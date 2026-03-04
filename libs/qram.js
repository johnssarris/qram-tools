/*!
 * qram encoder — browser build
 * Based on Digital Bazaar qram (c) 2019 Digital Bazaar, Inc. All rights reserved.
 */
(function (global) {
  'use strict';

  // ── SHA-256 multihash helper ───────────────────────────────────────────────
  // Multihash prefix: codec 0x12 (sha2-256), digest length 32
  const MULTIHASH_SHA256 = 18;
  const DIGEST_SIZE = 32;

  async function sha256(data) {
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
    const out = new Uint8Array(2 + hash.length);
    out[0] = MULTIHASH_SHA256;
    out[1] = hash.length;
    out.set(hash, 2);
    return out;
  }

  // ── Robust Soliton degree distribution ────────────────────────────────────
  const DEFAULT_FAILURE_PROB = 0.01;

  class RandomDegree {
    constructor({ N, failureProbability = DEFAULT_FAILURE_PROB } = {}) {
      if (!(Number.isInteger(N) && N > 0)) {
        throw new Error('"N" must be an integer > 0.');
      }
      const M = Math.ceil(N / 2);
      const R = N / M; // ripple size ratio

      // Ideal Soliton distribution
      const weights = [0, 1 / N];
      for (let k = 2; k <= N; k++) weights.push(1 / (k * (k - 1)));

      // Add robust (tau) component
      for (let k = 1; k < M; k++) weights[k] += 1 / (k * M);
      weights[M] += Math.log(R / failureProbability) / M;

      // Build cumulative weight table (unnormalized; totalWeight used as divisor in next())
      const total = weights.reduce((s, w) => s + w, 0);
      this.totalWeight = total;
      this.cumulativeWeights = [0];
      let cumSum = 0;
      for (let k = 1; k <= N; k++) {
        cumSum += weights[k];
        this.cumulativeWeights[k] = cumSum;
      }
    }

    next() {
      const { cumulativeWeights: cw, totalWeight } = this;
      const r = Math.random() * totalWeight;
      // Binary search: find smallest k where cw[k] > r
      let lo = 1, hi = cw.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (r < cw[mid]) hi = mid;
        else lo = mid + 1;
      }
      return lo;
    }
  }

  // ── LT packet (encoder-side only) ─────────────────────────────────────────
  const PACKET_VERSION = 1;

  class Packet {
    constructor({ header, payload, data }) {
      this.header = header;
      this.payload = payload;
      this.data = data;
    }

    static async create({ totalSize, blocks, indexes, blockSize, digest }) {
      const headerSize = Packet.getHeaderSize({ indexCount: indexes.length });
      const packetData = new Uint8Array(headerSize + blockSize);
      const payload = new Uint8Array(packetData.buffer, packetData.byteOffset + headerSize, blockSize);

      for (const block of blocks) {
        for (let i = 0; i < blockSize; i++) payload[i] ^= block[i];
      }

      const header = {
        version: PACKET_VERSION,
        size: headerSize,
        totalSize,
        blockCount: blocks.length,
        indexes,
        packetDigest: await sha256(payload),
        digest,
        blockSize,
      };
      Packet._writeHeader({ header, data: packetData });
      return new Packet({ header, payload, data: packetData });
    }

    static getHeaderSize({ digestSize = DIGEST_SIZE, indexCount }) {
      return 9 + 2 * indexCount + (2 + digestSize) + (2 + digestSize) + 4;
    }

    static _writeHeader({ header, data }) {
      const h = new Uint8Array(data.buffer, data.byteOffset, header.size);
      const v = new DataView(h.buffer, h.byteOffset, h.length);
      let p = 0;
      h[p] = header.version;
      v.setUint16(p += 1, header.size);
      v.setUint32(p += 2, header.totalSize);
      v.setUint16(p += 4, header.blockCount);
      for (const idx of header.indexes) v.setUint16(p += 2, idx);
      h.set(header.packetDigest, p += 2);
      h.set(header.digest, p += header.packetDigest.length);
      v.setUint32(p += header.digest.length, header.blockSize);
    }
  }

  // ── Encoder ───────────────────────────────────────────────────────────────
  class Encoder {
    constructor({ data, blockSize, failureProbability, maxBlocksPerPacket = 50 } = {}) {
      if (!(data instanceof Uint8Array || data instanceof Uint8ClampedArray)) {
        throw new TypeError('"data" must be a Uint8Array or Uint8ClampedArray.');
      }
      this.data = data;
      this.digest = null;
      this.blockSize = blockSize;
      this.blockCount = Math.ceil(data.length / blockSize);
      this.blocks = new Array(this.blockCount);
      this.random = new RandomDegree({ N: this.blockCount, failureProbability });
      this.maxBlocksPerPacket = maxBlocksPerPacket;
    }

    async createReadableStream() {
      if (!this.digest) this.digest = await sha256(this.data);
      const self = this;
      return new ReadableStream({
        async pull(controller) {
          controller.enqueue(await self._nextPacket());
        },
      });
    }

    static getMaxPacketSize({ size, blockSize, maxBlocksPerPacket }) {
      const blockCount = Math.ceil(size / blockSize);
      const indexCount = maxBlocksPerPacket || blockCount;
      return Packet.getHeaderSize({ indexCount });
    }

    async _nextPacket() {
      const { blockCount, blockSize, data, digest, maxBlocksPerPacket } = this;
      let degree = this.random.next();
      if (degree > maxBlocksPerPacket) degree = maxBlocksPerPacket;
      if (degree < 1) degree = 1;

      // Pick `degree` unique random block indexes using a Set for O(1) dedup
      const used = new Set();
      const indexes = [];
      while (indexes.length < degree) {
        const idx = Math.floor(Math.random() * blockCount);
        if (!used.has(idx)) {
          used.add(idx);
          indexes.push(idx);
        }
      }
      indexes.sort((a, b) => a - b);

      const blocks = indexes.map(i => this._createBlock(i));
      return Packet.create({ totalSize: data.length, blocks, indexes, blockSize, digest });
    }

    _createBlock(index) {
      let block = this.blocks[index];
      if (block) return block;
      const offset = index * this.blockSize;
      const remaining = this.data.length - offset;
      if (remaining < this.blockSize) {
        block = new Uint8Array(this.blockSize);
        block.set(new Uint8Array(this.data.buffer, this.data.byteOffset + offset, remaining));
      } else {
        block = new Uint8Array(this.data.buffer, this.data.byteOffset + offset, this.blockSize);
      }
      return (this.blocks[index] = block);
    }
  }

  global.qram = { Encoder };
})(window);
