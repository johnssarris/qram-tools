// Shared payload compression helpers for QRAM tools.
window.qramCompress = (() => {
  // ── Tunable thresholds ────────────────────────────────────────────────────
  const MIN_COMPRESS_RATIO        = 0.95;  // envelope must be ≤ 95 % of original
  const MIN_COMPRESS_SAVED_BYTES  = 50;    // must save at least 50 bytes
  const MIN_COMPRESS_INPUT_BYTES  = 50;    // skip attempt for tiny payloads
  // ── Envelope format ───────────────────────────────────────────────────────
  const COMPRESS_MAGIC = new Uint8Array([0x51, 0x52, 0x41, 0x4D, 0x43]); // "QRAMC"
  const HEADER_LEN     = 10;
  const ALGO_GZIP      = 1;
  // ── Concatenate an array of Uint8Arrays ──────────────────────────────────
  function concatChunks(chunks) {
    let total = 0;
    for (const c of chunks) total += c.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out;
  }
  // ── Low-level compress / decompress (native only) ────────────────────────
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
  // ── Public: compress ─────────────────────────────────────────────────────
  async function maybeCompress(payload) {
    const originalSize = payload.length;

    if (originalSize < MIN_COMPRESS_INPUT_BYTES || typeof CompressionStream === 'undefined') {
      return { data: payload, compressed: false, originalSize, sentSize: originalSize };
    }

    let compressedBytes = null;
    try { compressedBytes = await _compressNative(payload); } catch (_) {}

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

  return { maybeCompress };
})();
