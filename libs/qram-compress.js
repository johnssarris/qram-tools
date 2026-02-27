// Shared payload compression helpers for QRAM tools.
//
// Include BEFORE this file (optional — only needed as fallback):
//   <script src="./libs/pako.min.js"></script>
// Include this file:
//   <script src="./libs/qram-compress.js"></script>
//
// Public API (window.qramCompress):
//   maybeCompress(payload)   → Promise<{ data, compressed, originalSize, sentSize }>
//   maybeDecompress(data)    → Promise<{ data, wasCompressed, wireSize }>
//   isCompressed(data)       → boolean
//   selfTest()               → Promise<boolean>   (call from DevTools console)
window.qramCompress = (() => {
  // ── Tunable thresholds ────────────────────────────────────────────────────
  // Compression is kept only when ALL conditions are met:
  //   1. envelope size / original size  ≤  MIN_COMPRESS_RATIO
  //   2. bytes saved                    ≥  MIN_COMPRESS_SAVED_BYTES
  // And attempted only when:
  //   3. payload size                   ≥  MIN_COMPRESS_INPUT_BYTES
  const MIN_COMPRESS_RATIO        = 0.95;  // envelope must be ≤ 95 % of original
  const MIN_COMPRESS_SAVED_BYTES  = 50;    // must save at least 50 bytes
  const MIN_COMPRESS_INPUT_BYTES  = 50;    // skip attempt for tiny payloads

  // ── Envelope format ───────────────────────────────────────────────────────
  // Bytes  0-4:  ASCII "QRAMC" magic
  // Byte   5:    algo byte  (1 = gzip)
  // Bytes  6-9:  original length, big-endian uint32
  // Bytes 10+:   compressed payload
  const COMPRESS_MAGIC = new Uint8Array([0x51, 0x52, 0x41, 0x4D, 0x43]); // "QRAMC"
  const HEADER_LEN     = 10;
  const ALGO_GZIP      = 1;

  // ── Capability detection ─────────────────────────────────────────────────
  function hasNativeCompression() {
    return typeof CompressionStream !== 'undefined';
  }

  function hasPako() {
    return typeof window.pako !== 'undefined' &&
           typeof window.pako.gzip === 'function';
  }

  // ── Concatenate an array of Uint8Arrays ──────────────────────────────────
  function concatChunks(chunks) {
    let total = 0;
    for (const c of chunks) total += c.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out;
  }

  // ── Low-level compress ───────────────────────────────────────────────────
  async function _compressNative(data) {
    const cs     = new CompressionStream('gzip');
    const writer = cs.writable.getWriter();
    writer.write(data);
    writer.close();
    const chunks = [];
    const reader = cs.readable.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    return concatChunks(chunks);
  }

  function _compressPako(data) {
    return window.pako.gzip(data); // returns Uint8Array
  }

  // ── Low-level decompress ─────────────────────────────────────────────────
  async function _decompressNative(data) {
    const ds     = new DecompressionStream('gzip');
    const writer = ds.writable.getWriter();
    writer.write(data);
    writer.close();
    const chunks = [];
    const reader = ds.readable.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    return concatChunks(chunks);
  }

  function _decompressPako(data) {
    return window.pako.ungzip(data); // returns Uint8Array
  }

  // ── Envelope helpers ─────────────────────────────────────────────────────
  function _buildEnvelope(compressed, originalLen) {
    const out = new Uint8Array(HEADER_LEN + compressed.length);
    out.set(COMPRESS_MAGIC, 0);
    out[5] = ALGO_GZIP;
    out[6] = (originalLen >>> 24) & 0xFF;
    out[7] = (originalLen >>> 16) & 0xFF;
    out[8] = (originalLen >>>  8) & 0xFF;
    out[9] =  originalLen         & 0xFF;
    out.set(compressed, HEADER_LEN);
    return out;
  }

  /**
   * Returns true if `data` begins with the QRAMC magic bytes.
   * @param {Uint8Array} data
   * @returns {boolean}
   */
  function isCompressed(data) {
    if (data.length < HEADER_LEN) return false;
    for (let i = 0; i < COMPRESS_MAGIC.length; i++) {
      if (data[i] !== COMPRESS_MAGIC[i]) return false;
    }
    return true;
  }

  // ── Public: compress ─────────────────────────────────────────────────────
  /**
   * Opportunistically compress `payload` using gzip.
   * Priority: native CompressionStream → pako → skip (send uncompressed).
   * Compression is kept only when it satisfies both threshold conditions.
   *
   * @param  {Uint8Array} payload
   * @returns {Promise<{
   *   data:         Uint8Array,  // bytes to transmit (envelope or original)
   *   compressed:   boolean,     // true  → envelope was applied
   *   originalSize: number,
   *   sentSize:     number
   * }>}
   */
  async function maybeCompress(payload) {
    const originalSize = payload.length;

    if (originalSize < MIN_COMPRESS_INPUT_BYTES) {
      return { data: payload, compressed: false, originalSize, sentSize: originalSize };
    }

    let compressedBytes = null;

    if (hasNativeCompression()) {
      try { compressedBytes = await _compressNative(payload); } catch (_) {}
    }

    if (!compressedBytes && hasPako()) {
      try { compressedBytes = _compressPako(payload); } catch (_) {}
    }

    if (!compressedBytes) {
      return { data: payload, compressed: false, originalSize, sentSize: originalSize };
    }

    const envelopeSize = HEADER_LEN + compressedBytes.length;
    const ratio  = envelopeSize / originalSize;
    const saved  = originalSize - envelopeSize;

    if (ratio > MIN_COMPRESS_RATIO || saved < MIN_COMPRESS_SAVED_BYTES) {
      return { data: payload, compressed: false, originalSize, sentSize: originalSize };
    }

    const envelope = _buildEnvelope(compressedBytes, originalSize);
    return { data: envelope, compressed: true, originalSize, sentSize: envelope.length };
  }

  // ── Public: decompress ───────────────────────────────────────────────────
  /**
   * Decompress if `data` begins with the QRAMC magic; otherwise return as-is.
   * Priority: native DecompressionStream → pako → throw.
   *
   * @param  {Uint8Array} data
   * @returns {Promise<{
   *   data:          Uint8Array,  // original (decompressed) bytes
   *   wasCompressed: boolean,
   *   wireSize:      number       // compressed byte count that was transmitted
   * }>}
   * @throws if data is a QRAMC envelope but decompression fails entirely
   */
  async function maybeDecompress(data) {
    if (!isCompressed(data)) {
      return { data, wasCompressed: false, wireSize: data.length };
    }

    const wireSize = data.length;
    const algo     = data[5];
    const origLen  = ((data[6] << 24) | (data[7] << 16) | (data[8] << 8) | data[9]) >>> 0;
    const payload  = data.slice(HEADER_LEN);

    if (algo !== ALGO_GZIP) {
      throw new Error(`qram-compress: unknown algo byte ${algo}`);
    }

    let out = null;

    if (hasNativeCompression()) {
      try { out = await _decompressNative(payload); } catch (_) {}
    }

    if (!out && hasPako()) {
      try { out = _decompressPako(payload); } catch (_) {}
    }

    if (!out) {
      throw new Error('qram-compress: decompression failed (no CompressionStream and pako unavailable)');
    }

    if (out.length !== origLen) {
      console.warn(`qram-compress: length mismatch — expected ${origLen}, got ${out.length}`);
    }

    return { data: out, wasCompressed: true, wireSize };
  }

  // ── Public: self-test ────────────────────────────────────────────────────
  /**
   * In-browser round-trip sanity check.
   * Call from the DevTools console:  await qramCompress.selfTest()
   *
   * @returns {Promise<boolean>} true if all checks pass
   */
  async function selfTest() {
    const L = '[qramCompress.selfTest]';
    let allOk = true;

    // ── Test 1: compressible text ────────────────────────────────────────
    const text  = 'Hello, QRAM compression! '.repeat(20);
    const input = new TextEncoder().encode(text);
    console.log(L, 'input:', input.length, 'bytes');

    const { data: wire, compressed, sentSize } = await maybeCompress(input);
    console.log(L, 'compressed:', compressed, '| sentSize:', sentSize, 'bytes',
                compressed ? `(${((sentSize / input.length) * 100).toFixed(1)} % of original)` : '(threshold not met)');

    const { data: recovered, wasCompressed } = await maybeDecompress(wire);
    const recoveredText = new TextDecoder().decode(recovered);
    const t1ok = recoveredText === text && wasCompressed === compressed;
    console.log(L, t1ok ? '✓' : '✗', 'round-trip text OK:', t1ok);
    if (!t1ok) console.error(L, 'mismatch — first 80 chars:', recoveredText.slice(0, 80));
    allOk = allOk && t1ok;

    // ── Test 2: uncompressed passthrough ─────────────────────────────────
    const raw                       = new Uint8Array([1, 2, 3, 4, 5]);
    const { data: pt, wasCompressed: wc2 } = await maybeDecompress(raw);
    const t2ok = !wc2 && pt === raw; // same reference when passthrough
    console.log(L, t2ok ? '✓' : '✗', 'passthrough OK:', t2ok);
    allOk = allOk && t2ok;

    // ── Test 3: tiny payload skipped ─────────────────────────────────────
    const tiny                      = new TextEncoder().encode('hi');
    const { compressed: t3c, data: t3d } = await maybeCompress(tiny);
    const t3ok = !t3c && t3d === tiny;
    console.log(L, t3ok ? '✓' : '✗', 'tiny payload skip OK:', t3ok);
    allOk = allOk && t3ok;

    console.log(L, allOk ? '✓ all tests passed' : '✗ some tests FAILED');
    return allOk;
  }

  return {
    maybeCompress,
    maybeDecompress,
    isCompressed,
    selfTest,
    // expose constants so callers can read/document the thresholds
    COMPRESS_MAGIC,
    MIN_COMPRESS_RATIO,
    MIN_COMPRESS_SAVED_BYTES,
    MIN_COMPRESS_INPUT_BYTES,
  };
})();
