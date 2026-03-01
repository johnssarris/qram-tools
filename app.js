    // ── CONFIG: tunables and named constants ────────────────────────────
    const CONFIG = Object.freeze({
      // Encoder limits
      MAX_FILE_SIZE:     1 * 1024 * 1024,  // 1 MB
      MIN_BLOCK_SIZE:    50,
      MAX_BLOCK_SIZE:    20000,
      DEFAULT_BLOCK:     200,
      MIN_FPS:           1,
      MAX_FPS:           60,
      DEFAULT_FPS:       20,
      QR_WIDTH:          350,
      QR_ERROR_LEVEL:    'L',

      // Decoder scan
      CROP_FRACTION:     0.85,
      DOWNSCALE_PX:      480,

      // UI timing
      FLASH_DURATION_MS:       150,
      COPY_CONFIRM_MS:         2000,
      SPEED_UPDATE_INTERVAL:   500,

      // File protocol magic: "QRAMF"
      FILE_MAGIC: new Uint8Array([0x51, 0x52, 0x41, 0x4D, 0x46]),
    });

    // Load WASM binary from libs/ (no CDN fetch needed).
    let zxingReady = false;
    ZXingWASM.setZXingModuleOverrides({
      locateFile: (path, _prefix) =>
        path.endsWith('.wasm') ? `./libs/${path}` : _prefix + path,
    });
    ZXingWASM.prepareZXingModule()
      .then(() => { zxingReady = true; })
      .catch(err => {
        console.error('ZXing WASM failed to load:', err);
        const el = document.getElementById('error-msg');
        if (el) {
          el.textContent = 'QR scanner failed to load. Please reload the page or check your connection.';
          el.classList.add('show');
        }
      });

    // ── Zone A: Page-tab controller ───────────────────────────────────────
    const pageTabs = (() => {
      const tabs     = document.querySelectorAll('.page-tab');
      const panelEnc = document.getElementById('panel-encode');
      const panelDec = document.getElementById('panel-decode');

      let _onEncDeactivate = null;
      let _onDecActivate   = null;
      let _onDecDeactivate = null;
      let current = 'decode';

      function switchTo(page) {
        if (page === current) return;
        if (current === 'encode') { _onEncDeactivate && _onEncDeactivate(); }
        else                      { _onDecDeactivate && _onDecDeactivate(); }
        panelEnc.style.display = page === 'encode' ? '' : 'none';
        panelDec.style.display = page === 'decode' ? '' : 'none';
        tabs.forEach(t => t.classList.toggle('active', t.dataset.page === page));
        current = page;
        if (page === 'decode') { _onDecActivate && _onDecActivate(); }
      }

      tabs.forEach(tab => tab.addEventListener('click', () => switchTo(tab.dataset.page)));

      return {
        onEncodeDeactivate: fn => { _onEncDeactivate = fn; },
        onDecodeActivate:   fn => { _onDecActivate   = fn; },
        onDecodeDeactivate: fn => { _onDecDeactivate = fn; },
      };
    })();

    // ── Zone B: Encoder IIFE ──────────────────────────────────────────────
    (() => {
      const elTxt      = document.getElementById('txt');
      const elFPS      = document.getElementById('fps');
      const elBlk      = document.getElementById('blk');
      const elAutoBlk  = document.getElementById('auto-blk');
      const elCompress = document.getElementById('compress');
      const elStart    = document.getElementById('start');
      const elStop     = document.getElementById('stop');
      const elStats    = document.getElementById('stats');
      const elErr      = document.getElementById('err');
      const elCanvas   = document.getElementById('qr');
      const elDataSize = document.getElementById('data-size');
      const elDropZone = document.getElementById('drop-zone');
      const elFileInput     = document.getElementById('file-input');
      const elTextInput     = document.getElementById('text-input');
      const elFileInputArea = document.getElementById('file-input-area');
      const modeTabs = document.querySelectorAll('.mode-tab');

      let running = false;
      let cancelRequested = false;
      let reader = null;
      let stream = null;

      let currentMode = 'text';
      let loadedFile = null;

      const FILE_MAGIC    = CONFIG.FILE_MAGIC;
      const MAX_FILE_SIZE = CONFIG.MAX_FILE_SIZE;

      // --- Mode switching ---
      function handleModeSwitch(mode) {
        if (running) return;
        if (mode === currentMode) return;
        currentMode = mode;
        modeTabs.forEach(t => t.classList.toggle('active', t.dataset.mode === mode));
        elTextInput.style.display = mode === 'text' ? '' : 'none';
        elFileInputArea.style.display = mode === 'file' ? '' : 'none';
        updateDataSize();
      }

      modeTabs.forEach(tab => {
        tab.addEventListener('click', () => handleModeSwitch(tab.dataset.mode));
      });

      // --- File handling ---
      function handleFile(file) {
        if (!file) return;
        if (file.size > MAX_FILE_SIZE) {
          showError(`File too large. Keep files under ${formatBytes(MAX_FILE_SIZE)} for practical QR transfer.`);
          return;
        }
        const reader = new FileReader();
        reader.onload = () => {
          loadedFile = {
            name: file.name,
            data: new Uint8Array(reader.result)
          };
          elDropZone.classList.add('has-file');
          elDropZone.innerHTML = '';
          const _icon = Object.assign(document.createElement('div'), { className: 'drop-icon', textContent: '\u2705' });
          const _info = Object.assign(document.createElement('div'), { className: 'file-info', textContent: file.name });
          const _size = Object.assign(document.createElement('div'), { className: 'file-size', textContent: formatBytes(file.size) });
          const _hint = Object.assign(document.createElement('div'), { className: 'drop-hint', textContent: 'Click or drop to replace' });
          elDropZone.append(_icon, _info, _size, _hint);
          updateDataSize();
        };
        reader.onerror = () => showError('Failed to read file.');
        reader.readAsArrayBuffer(file);
      }

      elDropZone.addEventListener('click', () => elFileInput.click());

      elDropZone.addEventListener('dragover', e => {
        e.preventDefault();
        elDropZone.classList.add('active');
      });

      elDropZone.addEventListener('dragleave', () => {
        elDropZone.classList.remove('active');
      });

      elDropZone.addEventListener('drop', e => {
        e.preventDefault();
        elDropZone.classList.remove('active');
        if (e.dataTransfer.files.length > 0) handleFile(e.dataTransfer.files[0]);
      });

      elFileInput.addEventListener('change', () => {
        if (elFileInput.files.length > 0) handleFile(elFileInput.files[0]);
      });

      elTxt.addEventListener('dragover', e => {
        if (e.dataTransfer.types.includes('Files')) e.preventDefault();
      });

      elTxt.addEventListener('drop', e => {
        if (e.dataTransfer.files.length > 0) {
          e.preventDefault();
          handleModeSwitch('file');
          handleFile(e.dataTransfer.files[0]);
        }
      });

      // --- Auto block size ---
      function autoBlockSize(dataLength) {
        if (dataLength <= 50)     return 50;
        if (dataLength <= 600)    return dataLength;
        if (dataLength <= 1200)   return Math.ceil(dataLength / 2);
        if (dataLength <= 5000)   return 400;
        if (dataLength <= 20000)  return 500;
        if (dataLength <= 100000) return 600;
        return 700;
      }

      elAutoBlk.addEventListener('change', () => {
        elBlk.disabled = elAutoBlk.checked;
        if (elAutoBlk.checked) updateDataSize();
      });

      elBlk.disabled = elAutoBlk.checked;
      elTxt.addEventListener('input', updateDataSize);
      elCompress.addEventListener('change', updateDataSize);

      let _compressPreviewTimer = null;

      function updateDataSize() {
        let size = 0;
        if (currentMode === 'text') {
          const txt = elTxt.value || '';
          if (txt) size = new TextEncoder().encode(txt).length;
        } else if (loadedFile) {
          const nameBytes = new TextEncoder().encode(loadedFile.name).length;
          size = FILE_MAGIC.length + 2 + nameBytes + loadedFile.data.length;
        }

        if (size > 0) {
          elDataSize.textContent = `Data: ${formatBytes(size)}`;
          if (elAutoBlk.checked) elBlk.value = autoBlockSize(size);
          // Show compression preview (debounced for text input)
          if (elCompress.checked && window.qramCompress) {
            if (currentMode === 'text') {
              clearTimeout(_compressPreviewTimer);
              _compressPreviewTimer = setTimeout(() => updateCompressionPreview(size), 300);
            } else {
              updateCompressionPreview(size);
            }
          }
        } else {
          elDataSize.textContent = '';
        }
      }

      async function updateCompressionPreview(rawSize) {
        const payload = buildPayload();
        if (!payload || payload.length === 0) return;
        try {
          const cr = await qramCompress.maybeCompress(payload);
          if (cr.compressed) {
            const pct = ((1 - cr.sentSize / cr.originalSize) * 100).toFixed(0);
            elDataSize.textContent = `Data: ${formatBytes(cr.originalSize)} → ${formatBytes(cr.sentSize)} (gz, −${pct}%)`;
          } else {
            elDataSize.textContent = `Data: ${formatBytes(cr.sentSize)} (won't compress)`;
          }
        } catch (_) {}
      }

      // --- Helpers ---
      const { formatBytes } = qramUtils;

      function showError(msg, errObj) {
        const extra = errObj ? ('\n\n' + (errObj.stack || String(errObj))) : '';
        elErr.textContent = String(msg) + extra;
        elErr.style.display = 'block';
        console.error(msg, errObj);
      }

      function clearError() {
        elErr.textContent = '';
        elErr.style.display = 'none';
      }

      const encSetup = document.getElementById('enc-setup');
      const encLive  = document.getElementById('enc-live');

      function setEncodeView(isRunning) {
        encSetup.style.display = isRunning ? 'none' : '';
        encLive.style.display  = isRunning ? '' : 'none';
        if (isRunning) {
          elCanvas.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      }

      function clearCanvas() {
        const ctx = elCanvas.getContext('2d');
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, elCanvas.width, elCanvas.height);
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, elCanvas.width, elCanvas.height);
        ctx.restore();
      }

      // --- Build payload ---
      function buildPayload() {
        if (currentMode === 'text') {
          const txt = elTxt.value || '';
          if (!txt.trim()) return null;
          return new TextEncoder().encode(txt);
        } else {
          if (!loadedFile) return null;
          const nameBytes = new TextEncoder().encode(loadedFile.name);
          const totalLen = FILE_MAGIC.length + 2 + nameBytes.length + loadedFile.data.length;
          const payload = new Uint8Array(totalLen);
          let offset = 0;
          payload.set(FILE_MAGIC, offset);
          offset += FILE_MAGIC.length;
          payload[offset]     = (nameBytes.length >> 8) & 0xFF;
          payload[offset + 1] = nameBytes.length & 0xFF;
          offset += 2;
          payload.set(nameBytes, offset);
          offset += nameBytes.length;
          payload.set(loadedFile.data, offset);
          return payload;
        }
      }

      // --- Start/Stop ---
      async function start() {
        if (running) return;
        clearError();
        clearCanvas();

        if (!window.qram)   { showError("qram library didn't load. Check network / content blockers / file:// restrictions."); return; }
        if (!window.QRCode) { showError("qrcode library didn't load. Check network / content blockers / file:// restrictions."); return; }

        const data = buildPayload();
        if (!data || data.length === 0) {
          alert(currentMode === 'text' ? 'Enter text' : 'Select a file');
          return;
        }

        let sendData = data;
        if (elCompress.checked && window.qramCompress) {
          const cr = await qramCompress.maybeCompress(data);
          sendData = cr.data;
        }

        const fps       = Math.max(CONFIG.MIN_FPS, Math.min(CONFIG.MAX_FPS, parseInt(elFPS.value, 10) || CONFIG.DEFAULT_FPS));
        const blockSize = Math.max(CONFIG.MIN_BLOCK_SIZE, Math.min(CONFIG.MAX_BLOCK_SIZE, parseInt(elBlk.value, 10) || CONFIG.DEFAULT_BLOCK));
        const delay     = 1000 / fps;

        let enc;
        try {
          enc = new qram.Encoder({ data: sendData, blockSize });
        } catch (e) {
          showError('Failed to create qram.Encoder (bad options?)', e);
          return;
        }

        try {
          stream = await enc.createReadableStream();
          reader = stream.getReader();
        } catch (e) {
          showError('Failed to create/read QRAM stream.', e);
          return;
        }

        running = true;
        cancelRequested = false;
        setEncodeView(true);

        let n = 0;
        const blocks = Math.ceil(sendData.length / blockSize);
        const modeLabel = currentMode === 'file' ? `file: ${loadedFile.name}, ` : '';
        elStats.textContent = `${modeLabel}${formatBytes(sendData.length)}, ${blocks} blocks`;

        try {
          while (!cancelRequested) {
            const { value: pkt, done } = await reader.read();
            if (done) break;

            try {
              await QRCode.toCanvas(elCanvas, [{ data: pkt.data, mode: 'byte' }], {
                width: CONFIG.QR_WIDTH,
                margin: 1,
                errorCorrectionLevel: CONFIG.QR_ERROR_LEVEL,
              });
            } catch (e) {
              showError('QR render error (QRCode.toCanvas failed).', e);
              break;
            }

            n++;
            elStats.textContent = `${modeLabel}${formatBytes(sendData.length)}, ${blocks} blocks, packet #${n}`;
            await new Promise(ok => setTimeout(ok, delay));
          }
        } catch (e) {
          showError('Streaming loop error.', e);
        } finally {
          try { await reader?.cancel(); } catch (e) {}
          try { await stream?.cancel?.(); } catch (e) {}
          reader = null;
          stream = null;
          running = false;
          cancelRequested = false;
          setEncodeView(false);
        }
      }

      function stop() {
        cancelRequested = true;
        try { reader?.cancel(); } catch (e) {}
        try { stream?.cancel?.(); } catch (e) {}
      }

      elStart.addEventListener('click', start);
      elStop.addEventListener('click', stop);

      clearCanvas();
      updateDataSize();

      // Stop encode cleanly when user switches to Decode tab
      pageTabs.onEncodeDeactivate(() => {
        if (running) elStop.click();
      });
    })();

    // ── Zone C: Decoder ───────────────────────────────────────────────────
    // Elements
    const video          = document.getElementById('video');
    const canvas         = document.getElementById('canvas');
    const ctx            = canvas.getContext('2d', { willReadFrequently: true });
    const statusEl       = document.getElementById('status');
    const progressFill   = document.getElementById('progress-fill');
    const blocksReceivedEl  = document.getElementById('blocks-received');
    const blocksTotalEl     = document.getElementById('blocks-total');
    const packetsScannedEl  = document.getElementById('packets-scanned');
    const speedDisplayEl    = document.getElementById('speed-display');
    const resultContainer   = document.getElementById('result-container');
    const resultLabel       = document.getElementById('result-label');
    const textResult        = document.getElementById('text-result');
    const fileResult        = document.getElementById('file-result');
    const fileResultName    = document.getElementById('file-result-name');
    const fileResultSize    = document.getElementById('file-result-size');
    const resultEl     = document.getElementById('result');
    const copyBtn      = document.getElementById('copy-btn');
    const downloadBtn  = document.getElementById('download-btn');
    const saveBtn      = document.getElementById('save-btn');
    const resetBtn     = document.getElementById('reset-btn');
    const errorMsg     = document.getElementById('error-msg');
    const scanIndicator = document.getElementById('scan-indicator');
    const decScan      = document.getElementById('dec-scan');

    // State
    let scanning = true;
    let cameraStream = null;
    let decoder = null;
    let decodePromise = null;
    let packetsScanned = 0;
    let flashTimeout = null;
    let lastPacketSignature = null;
    let speedInterval = null;
    let pendingProgressUpdate = false;
    // Generation counter — incremented each time initCamera starts a new scan
    // loop. The loop closure captures its own gen; stale callbacks bail out
    // when scanGen advances, preventing double-loop races on reset/reinit.
    let scanGen = 0;

    // Speed tracking
    let firstPacketTime = null;
    let lastReceivedBlocks = 0;
    let lastTotalBlocks = 0;
    let totalBytesReceived = 0;

    // File transfer state
    let decodedFileData = null;

    const FILE_MAGIC = CONFIG.FILE_MAGIC;

    // --- Helpers ---
    const { formatBytes, downloadBlob } = qramUtils;

    function formatSpeed(bytesPerSec) {
      if (bytesPerSec < 1024) return bytesPerSec.toFixed(0) + ' B/s';
      return (bytesPerSec / 1024).toFixed(1) + ' KB/s';
    }

    function isFileTransfer(data) {
      if (data.length < 8) return false;
      for (let i = 0; i < FILE_MAGIC.length; i++) {
        if (data[i] !== FILE_MAGIC[i]) return false;
      }
      return true;
    }

    function parseFileTransfer(data) {
      let offset = FILE_MAGIC.length;
      const nameLen = (data[offset] << 8) | data[offset + 1];
      offset += 2;
      if (offset + nameLen > data.length) return null;
      const nameBytes = data.slice(offset, offset + nameLen);
      const fileName = new TextDecoder().decode(nameBytes);
      offset += nameLen;
      const fileData = data.slice(offset);
      return { fileName, fileData };
    }

    function guessMimeType(fileName) {
      const ext = fileName.split('.').pop().toLowerCase();
      const types = {
        txt: 'text/plain', json: 'application/json', xml: 'text/xml',
        html: 'text/html', css: 'text/css', js: 'text/javascript',
        yaml: 'text/yaml', yml: 'text/yaml', toml: 'text/plain',
        ini: 'text/plain', cfg: 'text/plain', conf: 'text/plain',
        sh: 'text/x-shellscript', py: 'text/x-python',
        key: 'application/octet-stream', pem: 'application/x-pem-file',
        pub: 'text/plain', csv: 'text/csv', md: 'text/markdown',
        png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
        gif: 'image/gif', svg: 'image/svg+xml', pdf: 'application/pdf',
        zip: 'application/zip', gz: 'application/gzip',
        tar: 'application/x-tar',
      };
      return types[ext] || 'application/octet-stream';
    }

    // --- Completion feedback ---
    function playCompletionChime() {
      try {
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        function playNote(freq, startTime, duration) {
          const osc = audioCtx.createOscillator();
          const gain = audioCtx.createGain();
          osc.type = 'sine';
          osc.frequency.value = freq;
          osc.connect(gain);
          gain.connect(audioCtx.destination);
          gain.gain.setValueAtTime(0.15, startTime);
          gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
          osc.start(startTime);
          osc.stop(startTime + duration);
        }
        const now = audioCtx.currentTime;
        playNote(659, now, 0.15);
        playNote(880, now + 0.12, 0.2);
        playNote(1047, now + 0.24, 0.3);
      } catch (e) {}
    }

    function triggerCompletionFeedback() {
      if (navigator.vibrate) navigator.vibrate([100, 50, 100]);
      playCompletionChime();
    }

    // --- Speed tracking ---
    function updateSpeed() {
      if (!firstPacketTime || lastTotalBlocks === 0) return;
      const elapsed = (Date.now() - firstPacketTime) / 1000;
      if (elapsed < 0.5) return;
      const pps = packetsScanned / elapsed;
      const kbps = formatSpeed(totalBytesReceived / elapsed);
      speedDisplayEl.textContent = `${pps.toFixed(1)} pkt/s\n${kbps}`;
    }

    function startSpeedTracking() {
      if (speedInterval) return;
      speedInterval = setInterval(updateSpeed, CONFIG.SPEED_UPDATE_INTERVAL);
    }

    function stopSpeedTracking() {
      if (speedInterval) {
        clearInterval(speedInterval);
        speedInterval = null;
      }
    }

    // Initialize
    async function init() {
      scanning = true;

      decoder = new qram.Decoder();
      decodePromise = decoder.decode();

      decodePromise.then(result => {
        onComplete(result).catch(err => {
          showError('Decode error: ' + err.message);
        });
      }).catch(err => {
        if (err.name !== 'AbortError') {
          showError('Decode error: ' + err.message);
        }
      });

      await initCamera();
    }

    // Initialize camera
    async function initCamera() {
      try {
        cameraStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment', frameRate: { ideal: 30 }, height: { ideal: 1080 } },
        });
        video.srcObject = cameraStream;
        video.setAttribute('playsinline', true);

        await new Promise((resolve, reject) => {
          if (video.videoWidth > 0 && video.videoHeight > 0) {
            resolve();
          } else {
            video.addEventListener('loadedmetadata', resolve, { once: true });
            video.addEventListener('error', reject, { once: true });
          }
        });

        await video.play();
        statusEl.textContent = 'Point camera at animated QR...';

        // Advance generation so any leftover callbacks from a previous loop
        // exit cleanly, then start the new loop.
        const gen = ++scanGen;
        qramScan.scheduleFrame(video, () => scanFrame(gen));
      } catch (err) {
        scanning = false;
        if (decoder) decoder.cancel();
        showError('Camera access denied. Please allow camera permissions.');
        console.error(err);
      }
    }

    function showError(msg) {
      errorMsg.textContent = msg;
      errorMsg.classList.add('show');
    }

    function hideError() {
      errorMsg.classList.remove('show');
    }

    function flashIndicator() {
      scanIndicator.classList.add('flash');
      if (flashTimeout) clearTimeout(flashTimeout);
      flashTimeout = setTimeout(() => scanIndicator.classList.remove('flash'), CONFIG.FLASH_DURATION_MS);
    }

    function scheduleProgressUpdate() {
      if (pendingProgressUpdate) return;
      pendingProgressUpdate = true;
      requestAnimationFrame(() => {
        pendingProgressUpdate = false;
        const minFrames = lastTotalBlocks > 0 ? Math.ceil(lastTotalBlocks * 1.2) : '?';
        packetsScannedEl.textContent = `${packetsScanned} / ${minFrames}`;
        blocksReceivedEl.textContent = lastReceivedBlocks;
        blocksTotalEl.textContent    = lastTotalBlocks;
        const pct = lastTotalBlocks > 0
          ? Math.min(100, (lastReceivedBlocks / lastTotalBlocks) * 100)
          : 0;
        progressFill.style.width = `${pct}%`;
        statusEl.textContent = `Receiving: ${lastReceivedBlocks}/${lastTotalBlocks} blocks`;
      });
    }

    // Scan frame — aligned to unique video frames via rVFC (rAF fallback).
    // `gen` is captured from scanGen at loop-start; stale closures bail out
    // when scanGen advances (reset/reinit), preventing double loops.
    async function scanFrame(gen) {
      if (!scanning || gen !== scanGen) return;

      if (video.readyState === video.HAVE_ENOUGH_DATA) {
        // Crop to the visible 85% scan region and downscale to 480px.
        const { width, height } = qramScan.cropCapture(video, canvas, ctx);
        const imageData = ctx.getImageData(0, 0, width, height);
        const results = await ZXingWASM.readBarcodes(imageData, {
          formats: ['QRCode'],
          tryHarder: true,
          tryRotate: false,  // encoder is always upright
          tryInvert: false,  // skip inversion pass
        });
        const result = results[0];

        if (result?.isValid && result.bytes.length > 0) {
          try {
            const packetData = result.bytes;

            // Skip duplicate consecutive frames (encoder FPS << scan FPS).
            const len = packetData.length;
            const step = Math.max(1, len >> 5);
            let sig = len;
            for (let i = 0; i < len; i += step) sig = (sig * 31 + packetData[i]) | 0;

            if (sig !== lastPacketSignature) {
              lastPacketSignature = sig;

              const progress = await decoder.enqueue(packetData);
              packetsScanned++;
              totalBytesReceived += packetData.length;
              flashIndicator();

              if (!firstPacketTime) {
                firstPacketTime = Date.now();
                startSpeedTracking();
                hideError();
              }

              if (progress) {
                lastReceivedBlocks = progress.receivedBlocks;
                lastTotalBlocks    = progress.totalBlocks;
                scheduleProgressUpdate();
              }
            }
          } catch (err) {
            // Ignore invalid packets silently
          }
        }
      }

      if (scanning && gen === scanGen) {
        qramScan.scheduleFrame(video, () => scanFrame(gen));
      }
    }

    // Handle completion
    async function onComplete(result) {
      scanning = false;
      stopSpeedTracking();

      let data     = result.data;
      let wireSize = data.length;

      if (window.qramCompress) {
        const dr = await qramCompress.maybeDecompress(data);
        data     = dr.data;
        wireSize = dr.wireSize;
      }

      if (firstPacketTime) {
        const elapsed = (Date.now() - firstPacketTime) / 1000;
        if (elapsed > 0) {
          const pps = packetsScanned / elapsed;
          speedDisplayEl.textContent = `${pps.toFixed(1)} pkt/s\n${formatSpeed(wireSize / elapsed)}`;
        }
      }

      if (isFileTransfer(data)) {
        const parsed = parseFileTransfer(data);
        if (parsed) {
          decodedFileData = parsed;
          handleFileResult(parsed, data.length);
          return;
        }
      }

      handleTextResult(data);
    }

    function _finishResult(statusText) {
      resultContainer.classList.add('show');
      progressFill.style.width = '100%';
      statusEl.textContent     = statusText;
      triggerCompletionFeedback();
      stopCamera();
      setDecodeView(false);
    }

    function handleTextResult(data) {
      const text = new TextDecoder().decode(data);
      resultLabel.textContent   = 'Decoded Content';
      textResult.style.display  = '';
      fileResult.style.display  = 'none';
      resultEl.value            = text;
      copyBtn.style.display     = 'block';
      saveBtn.style.display     = 'block';
      downloadBtn.style.display = 'none';
      _finishResult(`Complete! ${formatBytes(data.length)} received.`);
    }

    function handleFileResult(parsed, totalBytes) {
      resultLabel.textContent    = 'Received File';
      textResult.style.display   = 'none';
      fileResult.style.display   = '';
      fileResultName.textContent = parsed.fileName;
      fileResultSize.textContent = formatBytes(parsed.fileData.length);
      downloadBtn.style.display  = 'block';
      copyBtn.style.display      = 'none';
      saveBtn.style.display      = 'none';
      _finishResult(`Complete! File "${parsed.fileName}" (${formatBytes(parsed.fileData.length)}) received.`);
    }

    function stopCamera() {
      if (cameraStream) {
        cameraStream.getTracks().forEach(track => track.stop());
        cameraStream = null;
      }
    }

    function setDecodeView(isScanning) {
      decScan.style.display = isScanning ? '' : 'none';
      if (!isScanning) {
        resultContainer.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }

    // Copy to clipboard
    copyBtn.addEventListener('click', () => {
      qramUtils.copyToClipboard(resultEl.value, copyBtn, 'Copy to Clipboard', 'Copied!', 2000);
    });

    // Download file (for file transfers)
    downloadBtn.addEventListener('click', () => {
      if (!decodedFileData) return;
      const mime = guessMimeType(decodedFileData.fileName);
      downloadBlob(new Blob([decodedFileData.fileData], { type: mime }), decodedFileData.fileName);
    });

    // Save as file (for text transfers)
    saveBtn.addEventListener('click', () => {
      downloadBlob(new Blob([resultEl.value], { type: 'text/plain' }), 'qram-transfer.txt');
    });

    // Reset
    function handleReset() {
      scanning = false;
      stopSpeedTracking();
      if (decoder) decoder.cancel();
      stopCamera();
      setDecodeView(true);

      packetsScanned = 0;
      totalBytesReceived = 0;
      lastPacketSignature = null;
      firstPacketTime = null;
      lastReceivedBlocks = 0;
      lastTotalBlocks = 0;
      decodedFileData = null;
      pendingProgressUpdate = false;

      resultContainer.classList.remove('show');
      textResult.style.display   = '';
      fileResult.style.display   = 'none';
      copyBtn.style.display      = 'none';
      downloadBtn.style.display  = 'none';
      saveBtn.style.display      = 'none';
      progressFill.style.width   = '0%';
      blocksReceivedEl.textContent  = '0';
      blocksTotalEl.textContent     = '?';
      packetsScannedEl.textContent  = '0 / ?';
      speedDisplayEl.textContent    = '--';
      hideError();

      init();
    }

    resetBtn.addEventListener('click', handleReset);

    // Register service worker for offline PWA support
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    }

    // ── Lazy camera: start when Decode tab is activated ───────────────────
    // Decode is the default active tab, so we also call init() immediately below.
    let decoderStarted = false;

    pageTabs.onDecodeActivate(() => {
      if (!decoderStarted) {
        decoderStarted = true;
        init();
        return;
      }
      // Returning to Decode after switching away: restart only if no result showing
      const scanDone = resultContainer.classList.contains('show');
      if (!scanDone) init();
    });

    pageTabs.onDecodeDeactivate(() => {
      if (!scanning) return;  // Scan complete or not started — leave result alone
      // Pause an in-progress scan: stop camera, cancel decoder
      scanning = false;
      stopSpeedTracking();
      if (decoder) { decoder.cancel(); decoder = null; }
      if (cameraStream) { cameraStream.getTracks().forEach(t => t.stop()); cameraStream = null; }
      video.srcObject = null;
      statusEl.textContent = 'Scan paused. Switch back to resume.';
    });

    // Decode is the default active tab — start immediately
    decoderStarted = true;
    init();

    // ── Theme toggle (dark ↔ light) ─────────────────────────────────────
    (() => {
      const STORAGE_KEY = 'qram-theme';
      const root = document.documentElement;
      const btn  = document.getElementById('theme-toggle');

      // Restore saved preference (default: dark)
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved === 'light') root.setAttribute('data-theme', 'light');

      btn.addEventListener('click', () => {
        const isLight = root.getAttribute('data-theme') === 'light';
        const next = isLight ? 'dark' : 'light';
        root.setAttribute('data-theme', next);
        localStorage.setItem(STORAGE_KEY, next);
        // Update theme-color meta for iOS status bar
        const meta = document.querySelector('meta[name="theme-color"]');
        if (meta) meta.content = next === 'light' ? '#f0f2f5' : '#1a1a2e';
      });
    })();

    // Prevent Safari pinch-to-zoom (iOS 10+ ignores user-scalable=no in the viewport meta)
    document.addEventListener('gesturestart', e => e.preventDefault(), { passive: false });
    document.addEventListener('touchmove', e => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });
