# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Purpose

QRAM Tools transfers text and files from a locked-down work PC to an iPhone using animated QR codes and fountain codes (LT codes). Missed or duplicated frames don't matter — the decoder only needs enough unique packets for reconstruction. QR Code is the only supported barcode format (benchmarked to outperform Aztec and Data Matrix on iPhone 15 + Safari).

## Development

**No build step.** This is a pure vanilla JS/HTML/CSS static site with no package.json, no bundler, and no test runner. Deployment is `git push origin main` to GitHub Pages.

To develop locally, open `index.html` directly in a browser or serve with any static file server (e.g. `python -m http.server`).

**Service Worker cache versioning:** When changing cached assets, bump `CACHE_NAME` in `sw.js` (currently `qram-v12`) to force cache invalidation on the next visit.

## Architecture

The app is a single-page PWA (`index.html` + `app.js`) with two panels — Encoder and Decoder — managed by a tab controller. All logic lives in three IIFEs in `app.js`:

- **`pageTabs`** (lines 34–63): Tab switching with lifecycle callbacks (`onEncodeDeactivate`, `onDecodeActivate`, `onDecodeDeactivate`).
- **`encoder`** (lines 65–405): Reads text or file input → optionally compresses → encodes via LT fountain codes → renders QR frames to canvas at configurable FPS.
- **`decoder`** (lines 407–893): Lazily initializes camera when Decode tab activates → captures frames → crops/downscales to 480×480 → scans with ZXing WASM → deduplicates → feeds packets into fountain decoder → reconstructs original data.

### Data Format

**File transfer:** Payload is prefixed with magic bytes `QRAMF` (`[0x51, 0x52, 0x41, 0x4D, 0x46]`) followed by a 2-byte filename length and UTF-8 filename.

**Compression envelope:** When gzip compression is applied, output is prefixed with `QRAMC` magic + 1-byte algorithm ID + 4-byte original length (big-endian). Compression is skipped if it doesn't save at least 5% and 50 bytes.

**Fountain codec:** `libs/qram.min.js` provides `qram.Encoder` and `qram.Decoder`. The encoder produces an infinite stream of LT-coded packets via `createReadableStream()`; the decoder resolves via `decoder.decode()` once it has accumulated enough unique packets.

### Key Libraries (`libs/`)

| File | Role |
|------|------|
| `qram.min.js` | LT fountain codec (encoder + decoder) |
| `qrcode.min.js` | QR code encoder (node-qrcode) |
| `zxing-wasm.js` + `.wasm` | QR decoder (primary, production) |
| `jsQR.js` | QR decoder (legacy, used in bench tools only) |
| `pako.min.js` | Gzip fallback when native `CompressionStream` is unavailable |
| `qram-utils.js` | Shared helpers: `formatBytes`, `sha256hex`, `downloadBlob`, `copyToClipboard`, etc. |
| `qram-compress.js` | Compression/decompression with QRAMC envelope |
| `qram-scan.js` | Frame capture: `cropCapture()` (crop + downscale) and `scheduleFrame()` (uses `requestVideoFrameCallback` or rAF fallback) |
| `qram-perf.js` | Opt-in performance profiler; activate via `?perf=1` URL param |

### Auto Block Size Algorithm

The encoder automatically selects a block size based on payload size (configurable range 50–20,000, default 200):

- ≤50 bytes → 50
- ≤600 bytes → payload length
- ≤1,200 bytes → half payload length
- ≤5,000 bytes → 400
- ≤20,000 bytes → 500
- ≤100,000 bytes → 600
- >100,000 bytes → 700

### Performance Profiling

Enable with `?perf=1`. Labels: `encode-frame`, `qr-render`, `scan-frame`, `scan-crop`, `scan-decode`, `decode-enqueue`. Export with `qramPerf.download()` (JSON). Stats per label: min/mean/p50/p95/p99/max over a 1000-sample ring buffer.

## Branches

- `main` — production (GitHub Pages deployment target)
- `py_encode` — active development (Python encoder port in progress)
