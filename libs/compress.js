/**
 * compress.js — gzip compression / decompression for QRAM.
 *
 * Envelope format (magic prefix so decompression is always self-describing):
 *   bytes 0-4  : 'QRAMC' (0x51 0x52 0x41 0x4D 0x43)
 *   byte  5    : algorithm  (1 = gzip)
 *   bytes 6-9  : original length, big-endian uint32
 *   bytes 10+  : compressed payload
 *
 * Compression is skipped when it doesn't help: the raw data is returned as-is
 * when the compressed envelope is ≥ 95% the size of the original, or saves
 * fewer than 50 bytes.
 */

const MAGIC = new Uint8Array([0x51, 0x52, 0x41, 0x4D, 0x43]); // 'QRAMC'
const ALGO_GZIP = 1;
const SKIP_BELOW_BYTES = 50;
const SKIP_IF_RATIO_GTE = 0.95;

/** Try gzip via the native CompressionStream API. */
async function nativeGzip(data) {
  const cs = new CompressionStream('gzip');
  const writer = cs.writable.getWriter();
  writer.write(data);
  writer.close();
  const chunks = [];
  const reader = cs.readable.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/** Fallback via pako (must be loaded separately as window.pako). */
function pakoGzip(data) {
  if (typeof pako === 'undefined') throw new Error('pako not available');
  return pako.gzip(data);
}

/** Compress `data` (Uint8Array). Returns an envelope or the original bytes. */
async function compress(data) {
  if (data.length < SKIP_BELOW_BYTES) return data;

  let compressed;
  try {
    compressed = await nativeGzip(data);
  } catch {
    try {
      compressed = pakoGzip(data);
    } catch {
      return data;
    }
  }

  const envelopeLen = 10 + compressed.length;
  const savings = data.length - envelopeLen;
  if (savings < SKIP_BELOW_BYTES || envelopeLen / data.length >= SKIP_IF_RATIO_GTE) {
    return data;
  }

  const out = new Uint8Array(envelopeLen);
  out.set(MAGIC, 0);
  out[5] = ALGO_GZIP;
  const view = new DataView(out.buffer);
  view.setUint32(6, data.length, false); // big-endian
  out.set(compressed, 10);
  return out;
}

/** Gunzip via the native DecompressionStream API. */
async function nativeGunzip(data) {
  const ds = new DecompressionStream('gzip');
  const writer = ds.writable.getWriter();
  writer.write(data);
  writer.close();
  const chunks = [];
  const reader = ds.readable.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/**
 * Decompress `data` if it carries a QRAMC envelope; otherwise return as-is.
 * Throws on corrupt envelopes.
 */
async function decompress(data) {
  if (data.length < 10) return data;

  // Check magic.
  for (let i = 0; i < 5; i++) {
    if (data[i] !== MAGIC[i]) return data;
  }

  const algo = data[5];
  if (algo !== ALGO_GZIP) throw new Error(`Unknown compression algorithm: ${algo}`);

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const originalLen = view.getUint32(6, false);
  const payload = data.slice(10);

  let decompressed;
  try {
    decompressed = await nativeGunzip(payload);
  } catch {
    if (typeof pako === 'undefined') throw new Error('Decompression failed and pako not available');
    decompressed = pako.inflate(payload);
  }

  if (decompressed.length !== originalLen) {
    throw new Error(`Length mismatch: expected ${originalLen}, got ${decompressed.length}`);
  }
  return decompressed;
}

/** Quick round-trip self-test. Returns true on success. */
async function selfTest() {
  const msg = new TextEncoder().encode('Hello, QRAM compression test! '.repeat(10));
  const enc = await compress(msg);
  const dec = await decompress(enc);
  if (dec.length !== msg.length) return false;
  for (let i = 0; i < msg.length; i++) {
    if (dec[i] !== msg[i]) return false;
  }
  // Tiny payload should pass through unchanged (no envelope).
  const tiny = new Uint8Array([1, 2, 3]);
  const tinyEnc = await compress(tiny);
  if (tinyEnc.length !== 3) return false;
  return true;
}

window.qramCompress = { compress, decompress, selfTest };
