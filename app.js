/**
 * app.js — QRAM: animated QR-code file/text transfer using a Rust WASM LT fountain codec.
 *
 * Packet wire format (16-byte header):
 *   bytes  0-3  : run_id     (u32 big-endian)  — unique per session
 *   bytes  4-7  : k          (u32 big-endian)  — number of source blocks
 *   bytes  8-11 : orig_len   (u32 big-endian)  — original payload length
 *   bytes 12-15 : seq_num    (u32 big-endian)  — packet sequence index
 *   bytes 16+   : payload    (block_size bytes) — XOR of selected source blocks
 *
 * File-transfer envelope (wraps raw bytes when sending a file):
 *   bytes 0-4  : 'QRAMF' magic (0x51 0x52 0x41 0x4D 0x46)
 *   bytes 5-6  : filename length, big-endian uint16
 *   bytes 7+N  : UTF-8 filename
 *   bytes 7+N+ : file payload
 */

import initQramCore, { LTEncoder, LTDecoder, qr_generate } from './libs/pkg/qram_core.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const FILE_MAGIC    = new Uint8Array([0x51, 0x52, 0x41, 0x4D, 0x46]); // 'QRAMF'
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB
const HEADER_SIZE   = 16;

// ── Utilities ─────────────────────────────────────────────────────────────────

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(2)} MB`;
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function randomU32() {
  const buf = new Uint8Array(4);
  crypto.getRandomValues(buf);
  return new DataView(buf.buffer).getUint32(0, false);
}

/** Build a file-transfer payload from a filename and raw file bytes. */
function buildFilePayload(name, fileBytes) {
  const nameBytes = new TextEncoder().encode(name);
  const out = new Uint8Array(5 + 2 + nameBytes.length + fileBytes.length);
  out.set(FILE_MAGIC, 0);
  new DataView(out.buffer).setUint16(5, nameBytes.length, false);
  out.set(nameBytes, 7);
  out.set(fileBytes, 7 + nameBytes.length);
  return out;
}

/** Parse a file-transfer payload. Returns { name, data } or null. */
function parseFilePayload(bytes) {
  if (bytes.length < 7) return null;
  for (let i = 0; i < 5; i++) if (bytes[i] !== FILE_MAGIC[i]) return null;
  const view    = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const nameLen = view.getUint16(5, false);
  if (7 + nameLen > bytes.length) return null;
  const name = new TextDecoder().decode(bytes.subarray(7, 7 + nameLen));
  return { name, data: bytes.subarray(7 + nameLen) };
}

/**
 * Render a QR matrix (from qr_generate) to a canvas element.
 * The matrix is [size: u32 LE, modules: size*size bytes].
 */
function renderQR(canvas, matrix, scale) {
  const view  = new DataView(matrix.buffer, matrix.byteOffset, matrix.byteLength);
  const size  = view.getUint32(0, true);
  const mods  = matrix.subarray(4);
  const QUIET = 4;
  const dim   = (size + QUIET * 2) * scale;

  canvas.width  = dim;
  canvas.height = dim;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, dim, dim);
  ctx.fillStyle = '#000';
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (mods[y * size + x]) {
        ctx.fillRect((x + QUIET) * scale, (y + QUIET) * scale, scale, scale);
      }
    }
  }
}

/** Crop video frame for scanning: centre 85% of the visible area. */
function cropVideoFrame(video, canvas, ctx) {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return false;
  const rect = video.getBoundingClientRect();
  const ew = rect.width, eh = rect.height;
  if (!ew || !eh) return false;

  // object-fit: cover
  let sx, sy, sw, sh;
  if (vw / vh > ew / eh) {
    sh = vh; sw = vh * ew / eh;
    sx = (vw - sw) / 2; sy = 0;
  } else {
    sw = vw; sh = vw * eh / ew;
    sx = 0; sy = (vh - sh) / 2;
  }

  const crop = 0.85;
  const cw = sw * crop, ch = sh * crop;
  const cx = sx + (sw - cw) / 2, cy = sy + (sh - ch) / 2;

  canvas.width = canvas.height = 480;
  ctx.drawImage(video, cx, cy, cw, ch, 0, 0, 480, 480);
  return true;
}

/** Request the next unique video frame (prefer rVFC, fall back to rAF). */
function nextFrame(video, cb) {
  if ('requestVideoFrameCallback' in video) {
    video.requestVideoFrameCallback(cb);
  } else {
    requestAnimationFrame(cb);
  }
}

/** Cheap 32-bit packet fingerprint for duplicate detection. */
function packetFingerprint(data) {
  let h = 0x811c9dc5 | 0;
  for (let i = 0; i < data.length; i++) {
    h = Math.imul(h ^ data[i], 0x01000193) | 0;
  }
  return h;
}

/** Play a three-note completion chime. */
function chime() {
  try {
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    [659, 880, 1047].forEach((freq, i) => {
      const osc  = ac.createOscillator();
      const gain = ac.createGain();
      osc.connect(gain); gain.connect(ac.destination);
      osc.type = 'sine'; osc.frequency.value = freq;
      const t = ac.currentTime + i * 0.18;
      gain.gain.setValueAtTime(0.3, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
      osc.start(t); osc.stop(t + 0.4);
    });
  } catch { /* audio not available */ }
}

const $ = id => document.getElementById(id);

// ── Application ───────────────────────────────────────────────────────────────

const app = (() => {
  let wasmReady   = false;
  let inputMode   = 'text';      // 'text' | 'file'
  let pendingFile = null;        // { name: string, bytes: Uint8Array } | null

  // Encoder state
  let encoder    = null;
  let encTimer   = null;
  let encRunning = false;
  let encFrame   = 0;

  // Decoder state
  let decoder    = null;
  let decRunId   = null;        // run_id of the active session
  let decStream  = null;         // MediaStream
  let decCanvas  = null;        // off-screen canvas
  let decCtx     = null;
  let decActive  = false;
  let decFrames  = 0;
  let lastFP     = null;        // last packet fingerprint
  let decStartMs   = 0;
  let decPkts      = 0;
  let decOrigLen   = 0;         // original payload length from packet header
  let decBlockSize = 0;         // block_size for KB/s estimate
  let decResult  = null;        // { isFile, name?, data } after completion

  // ── Initialisation ──

  async function setup() {
    decCanvas = document.createElement('canvas');
    decCtx    = decCanvas.getContext('2d');
    await loadWasm();
    window.addEventListener('qram-tab', e => {
      if (e.detail === 'decode') activateDecode();
      else deactivateDecode();
    });
  }

  async function loadWasm() {
    try {
      await initQramCore();
      wasmReady = true;
    } catch (err) {
      showError('WASM init failed: ' + err.message);
    }
  }

  // ── Tab lifecycle ──

  function activateDecode() {
    decActive = true;
    startCamera();
  }

  function deactivateDecode() {
    decActive = false;
    stopCamera();
  }

  // ── Input mode ──

  function setInputMode(mode) {
    inputMode = mode;
    $('text-input-area').style.display  = mode === 'text' ? '' : 'none';
    $('file-input-area').style.display  = mode === 'file' ? '' : 'none';
    $('mode-text').classList.toggle('active', mode === 'text');
    $('mode-file').classList.toggle('active', mode === 'file');
  }

  function handleDrop(e) {
    e.preventDefault();
    $('drop-zone').classList.remove('drag-over');
    if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
  }

  function handleFileSelect(e) {
    if (e.target.files[0]) loadFile(e.target.files[0]);
  }

  function loadFile(file) {
    if (file.size > MAX_FILE_SIZE) {
      showError(`File too large: ${formatBytes(file.size)} (max 5 MB)`);
      return;
    }
    const reader = new FileReader();
    reader.onload = ev => {
      pendingFile = { name: file.name, bytes: new Uint8Array(ev.target.result) };
      $('drop-zone').classList.add('has-file');
      $('drop-label').textContent = `${file.name}  (${formatBytes(file.size)})`;
    };
    reader.readAsArrayBuffer(file);
  }

  // ── Encoder ──

  async function startEncoder() {
    if (!wasmReady) { showError('WASM not ready.'); return; }
    hideError();

    let raw;
    if (inputMode === 'text') {
      const t = $('text-in').value;
      if (!t.trim()) { showError('Enter some text first.'); return; }
      raw = new TextEncoder().encode(t);
    } else {
      if (!pendingFile) { showError('Choose a file first.'); return; }
      raw = buildFilePayload(pendingFile.name, pendingFile.bytes);
    }

    // Optionally compress.
    let payload = raw;
    if ($('chk-compress').checked) {
      payload = await qramCompress.compress(raw);
    }

    const blockSize = parseInt($('sel-block').value, 10);
    const ecLevel   = parseInt($('sel-ec').value, 10);
    const fps       = parseInt($('sel-fps').value, 10);
    const runId     = randomU32();

    encoder    = new LTEncoder(payload, blockSize, runId);
    encRunning = true;
    encFrame   = 0;

    const k = encoder.block_count();
    $('btn-start').disabled = true;
    $('btn-stop').disabled  = false;
    $('qr-wrap').classList.add('active');
    $('enc-status').textContent = `0 frames · ${k} blocks · ${formatBytes(payload.length)}`;

    const canvas   = $('qr-canvas');
    const interval = Math.round(1000 / fps);

    function tick() {
      if (!encRunning) return;
      const pkt = encoder.next_packet();
      const mat = qr_generate(pkt, ecLevel);

      if (mat.length > 4) {
        const view = new DataView(mat.buffer, mat.byteOffset, mat.byteLength);
        const qrN  = view.getUint32(0, true);
        // Choose scale so QR fills ~340 CSS pixels.
        const QUIET = 4;
        const scale = Math.max(1, Math.floor(340 / (qrN + QUIET * 2)));
        renderQR(canvas, mat, scale);
      }

      encFrame++;
      $('enc-status').textContent = `Frame ${encFrame} · ${k} blocks · ${formatBytes(payload.length)}`;
      encTimer = setTimeout(tick, interval);
    }

    tick();
  }

  function stopEncoder() {
    encRunning = false;
    clearTimeout(encTimer);
    if (encoder) { encoder.free(); encoder = null; }
    $('btn-start').disabled = false;
    $('btn-stop').disabled  = true;
    $('enc-status').textContent = 'Stopped.';
  }

  // ── Decoder ──

  async function startCamera() {
    if (decStream) return;
    try {
      decStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, frameRate: { ideal: 30 } }
      });
      const video = $('video');
      video.srcObject = decStream;
      await video.play();
      resetDecoder();
      nextFrame(video, scanLoop);
    } catch (err) {
      $('dec-status').textContent = 'Camera error: ' + err.message;
    }
  }

  function stopCamera() {
    if (!decStream) return;
    decStream.getTracks().forEach(t => t.stop());
    decStream = null;
    $('video').srcObject = null;
  }

  function scanLoop() {
    const video = $('video');
    if (!decActive || !decStream) return;
    nextFrame(video, scanLoop);

    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
    if (!cropVideoFrame(video, decCanvas, decCtx)) return;

    const imageData = decCtx.getImageData(0, 0, 480, 480);
    const code = jsQR(imageData.data, 480, 480, { inversionAttempts: 'dontInvert' });
    if (!code || !code.binaryData || code.binaryData.length < HEADER_SIZE) return;

    const pkt = new Uint8Array(code.binaryData);
    const fp  = packetFingerprint(pkt);
    if (fp === lastFP) return;
    lastFP = fp;

    decFrames++;
    $('s-frames').textContent = decFrames;

    // Parse header.
    const view    = new DataView(pkt.buffer, pkt.byteOffset, pkt.byteLength);
    const runId   = view.getUint32(0, false);
    const k       = view.getUint32(4, false);
    const origLen = view.getUint32(8, false);
    const blockSize = pkt.length - HEADER_SIZE;

    if (k < 1 || blockSize < 1) return;

    // Bootstrap or reset decoder when a new session is detected.
    if (!decoder || decRunId !== runId) {
      if (decoder) decoder.free();
      decoder      = new LTDecoder(k, blockSize, runId);
      decRunId     = runId;
      decOrigLen   = origLen;
      decBlockSize = blockSize;
      decStartMs   = Date.now();
      decPkts      = 0;
      $('s-total').textContent   = k;
      $('s-decoded').textContent = '0';
      // Hide any previous result when a new session starts.
      $('result-area').style.display = 'none';
    }

    const done = decoder.push_packet(pkt);
    decPkts++;
    updateDecStats();
    if (done) completeDecode();
  }

  function updateDecStats() {
    if (!decoder) return;
    const dec   = decoder.decoded_count();
    const total = decoder.block_count();

    $('s-decoded').textContent = dec;
    $('s-total').textContent   = total;

    const pct = total ? (dec / total) * 100 : 0;
    $('progress-bar').style.width = pct + '%';
    $('progress-bar').classList.toggle('done', dec >= total);

    const elapsedS = (Date.now() - decStartMs) / 1000;
    if (elapsedS > 0.3 && decPkts > 0 && decBlockSize > 0) {
      const kbps = (decPkts * decBlockSize / 1024) / elapsedS;
      $('s-speed').textContent = kbps.toFixed(1);
    }

    $('dec-status').textContent =
      dec >= total ? 'Reconstructing…' : `${dec} / ${total} blocks`;
  }

  async function completeDecode() {
    if (!decoder) return;

    const rawPadded = decoder.get_result(decOrigLen);
    decoder.free();
    decoder = null;

    chime();
    if (navigator.vibrate) navigator.vibrate([100, 50, 100]);

    $('progress-bar').style.width = '100%';
    $('progress-bar').classList.add('done');
    $('dec-status').textContent = 'Transfer complete!';

    // Decompress if needed.
    let payload;
    try {
      payload = await qramCompress.decompress(rawPadded);
    } catch {
      payload = rawPadded;
    }

    // Check for file envelope.
    const fileInfo = parseFilePayload(payload);

    const area = $('result-area');
    area.style.display = '';

    if (fileInfo) {
      $('result-file').style.display  = '';
      $('result-text').style.display  = 'none';
      $('result-filename').textContent = escapeHtml(fileInfo.name);
      $('result-filesize').textContent = formatBytes(fileInfo.data.length);
      $('btn-copy').style.display     = 'none';
      $('btn-save').style.display     = '';
      decResult = { isFile: true, name: fileInfo.name, data: fileInfo.data };
    } else {
      $('result-file').style.display  = 'none';
      $('result-text').style.display  = '';
      $('result-text').value           = new TextDecoder().decode(payload);
      $('btn-copy').style.display     = '';
      $('btn-save').style.display     = 'none';
      decResult = { isFile: false, data: payload };
    }
  }

  function copyResult() {
    const btn = $('btn-copy');
    navigator.clipboard.writeText($('result-text').value).then(() => {
      const orig = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = orig; }, 2000);
    });
  }

  function saveResult() {
    if (!decResult) return;
    const url = URL.createObjectURL(new Blob([decResult.data]));
    Object.assign(document.createElement('a'),
      { href: url, download: decResult.name || 'qram-output.bin' }).click();
    URL.revokeObjectURL(url);
  }

  function resetDecoder() {
    if (decoder) { decoder.free(); decoder = null; }
    decFrames = decPkts = 0;
    decResult    = null;
    decRunId     = null;
    decOrigLen   = 0;
    decBlockSize = 0;
    lastFP    = null;

    ['s-decoded', 's-total', 's-speed'].forEach(id => { $(id).textContent = '—'; });
    $('s-frames').textContent = '0';
    $('progress-bar').style.width = '0%';
    $('progress-bar').classList.remove('done');
    $('dec-status').textContent   = 'Scanning…';
    $('result-area').style.display = 'none';
    $('result-text').value         = '';
    $('result-file').style.display = 'none';
    hideError();
  }

  function showError(msg) {
    const box = $('error-box');
    box.textContent  = msg;
    box.style.display = '';
  }

  function hideError() {
    $('error-box').style.display = 'none';
  }

  return {
    setInputMode, handleDrop, handleFileSelect,
    startEncoder, stopEncoder,
    copyResult, saveResult, resetDecoder,
    _setup: setup,
  };
})();

// ── Bootstrap ─────────────────────────────────────────────────────────────────

(async () => {
  await app._setup();
  window.app = app;
})();
