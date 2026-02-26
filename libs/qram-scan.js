// Shared scanning helpers for QRAM tools.
// Include via: <script src="./libs/qram-scan.js"></script>
// Access via:  qramScan.cropCapture(video, canvas, ctx, opts)
//              qramScan.scheduleFrame(video, callback)
window.qramScan = (() => {
  // ── Tunable defaults ─────────────────────────────────────────────────────
  // Change DEFAULT_OUT_SIZE to 640 when scanning from longer distances.
  const DEFAULT_OUT_SIZE      = 480;   // pixels; output canvas is always square
  const DEFAULT_CROP_FRACTION = 0.85;  // fraction of visible container to capture

  /**
   * Compute the source rectangle in *video pixel* coordinates for a centred
   * square crop of `cropFraction` of the CSS container, accounting for the
   * CSS object-fit mode.
   *
   * For `cover`  (video fills/overflows container — index.html):
   *   scale = max(cw/vw, ch/vh); video overflows; offsets are negative.
   * For `contain` (video letterboxed inside container — bench_decoder.html):
   *   scale = min(cw/vw, ch/vh); black bars; offsets are positive.
   *
   * @param {HTMLVideoElement} video
   * @param {number}           cropFraction
   * @param {'cover'|'contain'} fitMode
   * @returns {{ sx, sy, sw, sh }}  — clamped to valid video pixel bounds
   */
  function computeCropRect(video, cropFraction, fitMode) {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return { sx: 0, sy: 0, sw: vw || 1, sh: vh || 1 };

    // CSS dimensions of the video element (falls back to native dims if not
    // laid out yet, which should never happen during an active scan loop).
    const cw = video.offsetWidth  || vw;
    const ch = video.offsetHeight || vh;

    // Rendered scale and origin offset (may be negative for cover).
    const scale = fitMode === 'cover'
      ? Math.max(cw / vw, ch / vh)
      : Math.min(cw / vw, ch / vh);
    const offX = (cw - vw * scale) / 2;
    const offY = (ch - vh * scale) / 2;

    // Scan box in CSS pixels: centred square at cropFraction of the container.
    const scanSizeCss = Math.min(cw, ch) * cropFraction;
    const scanX = (cw - scanSizeCss) / 2;
    const scanY = (ch - scanSizeCss) / 2;

    // Map to video pixels.
    const sx = (scanX - offX) / scale;
    const sy = (scanY - offY) / scale;
    const sw = scanSizeCss / scale;
    const sh = scanSizeCss / scale;

    // Clamp to [0, vw] × [0, vh], shrinking w/h for any leading edge clip.
    const csx = Math.max(0, sx);
    const csy = Math.max(0, sy);
    const csw = Math.max(1, Math.min(sw - (csx - sx), vw - csx));
    const csh = Math.max(1, Math.min(sh - (csy - sy), vh - csy));

    return { sx: csx, sy: csy, sw: csw, sh: csh };
  }

  /**
   * Draw the centred crop region of `video` onto `canvas`, optionally
   * downscaling to `outSize × outSize` pixels.
   *
   * The canvas is resized only when its dimensions change, so repeated calls
   * during a scan loop are cheap.
   *
   * @param {HTMLVideoElement}       video
   * @param {HTMLCanvasElement}      canvas
   * @param {CanvasRenderingContext2D} ctx
   * @param {object}  [opts]
   * @param {number}  [opts.cropFraction=0.85]           fraction of container to crop
   * @param {number}  [opts.outSize=480]                 output size in px (0 = no downscale)
   * @param {'cover'|'contain'} [opts.fitMode='cover']   CSS object-fit mode
   * @returns {{ width: number, height: number }}         resulting canvas size
   */
  function cropCapture(video, canvas, ctx, opts) {
    const cropFraction = (opts && opts.cropFraction != null) ? opts.cropFraction : DEFAULT_CROP_FRACTION;
    const outSize      = (opts && opts.outSize      != null) ? opts.outSize      : DEFAULT_OUT_SIZE;
    const fitMode      = (opts && opts.fitMode      != null) ? opts.fitMode      : 'cover';

    const { sx, sy, sw, sh } = computeCropRect(video, cropFraction, fitMode);
    const out = outSize > 0 ? outSize : Math.round(sw);

    if (canvas.width !== out || canvas.height !== out) {
      canvas.width  = out;
      canvas.height = out;
    }

    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, out, out);
    return { width: out, height: out };
  }

  /**
   * Schedule `callback` to run on the *next unique video frame*.
   *
   * Uses `requestVideoFrameCallback` (rVFC) when available — it fires at most
   * once per new decoded frame, avoiding redundant scans when the display
   * refresh rate exceeds the camera frame rate.
   *
   * Falls back to `requestAnimationFrame` (rAF) on browsers that do not
   * support rVFC (older iOS Safari < 15.4, some WebViews).
   *
   * @param {HTMLVideoElement} video
   * @param {function}         callback
   */
  function scheduleFrame(video, callback) {
    if (typeof video.requestVideoFrameCallback === 'function') {
      video.requestVideoFrameCallback(callback);
    } else {
      requestAnimationFrame(callback);
    }
  }

  return { cropCapture, scheduleFrame, DEFAULT_OUT_SIZE, DEFAULT_CROP_FRACTION };
})();
