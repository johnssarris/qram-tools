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

      // File protocol magic: "QRAMF"
      FILE_MAGIC: new Uint8Array([0x51, 0x52, 0x41, 0x4D, 0x46]),
    });

    // ── Encoder IIFE ──────────────────────────────────────────────────────
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
    })();

    // Register service worker for offline PWA support
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').then(reg => {
        reg.update();
        // Only reload on update (not on first install when there's no previous controller)
        if (navigator.serviceWorker.controller) {
          navigator.serviceWorker.addEventListener('controllerchange', () => window.location.reload());
        }
      }).catch(() => {});
    }

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

