# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Purpose

QRAM Tools (encoder-only branch) transfers text and files from a locked-down work PC to an iPhone using animated QR codes and fountain codes (LT codes). Missed or duplicated frames don't matter — the receiver only needs enough unique packets for reconstruction.

## Development

**No build step.** Pure vanilla JS/HTML/CSS static site. Deployment is `git push origin main` to GitHub Pages.

Serve locally with any static file server (e.g. `python -m http.server`) or open `index.html` directly in a browser.

**Service Worker cache versioning:** Bump `CACHE_NAME` in `sw.js` (currently `qram-v15`) whenever cached assets change.

## Architecture

Two files: `index.html` (markup + CSS) and `app.js` (all logic). `app.js` has two top-level sections:

- **Encoder IIFE**: reads text/file input → optionally compresses → encodes with LT fountain codec → renders QR frames to canvas at configurable FPS.
- **Theme toggle IIFE**: dark/light mode, persisted in `localStorage`.

### Data Format

**File transfer:** Payload is prefixed with magic bytes `QRAMF` (`[0x51, 0x52, 0x41, 0x4D, 0x46]`) + 2-byte filename length (big-endian) + UTF-8 filename.

**Compression envelope:** When gzip compression is applied (`CompressionStream`), output is prefixed with `QRAMC` magic + 1-byte algorithm ID (`0x01` = gzip) + 4-byte original length (big-endian). Skipped if native `CompressionStream` is unavailable, or if it doesn't save at least 5% and 50 bytes.

**Fountain codec:** `qram.Encoder` (from `libs/qram.min.js`) takes `{ data, blockSize }` and exposes `createReadableStream()` which yields LT-coded packets indefinitely until cancelled.

### Libraries (`libs/`)

| File | Role |
|------|------|
| `qram.min.js` | LT fountain codec — provides `qram.Encoder` |
| `qrcode.min.js` | QR code renderer (node-qrcode) |
| `qram-compress.js` | Gzip compression with QRAMC envelope; `maybeCompress(payload)` |
| `qram-utils.js` | `formatBytes(n)` — only export |

### Auto Block Size Algorithm

The encoder automatically selects block size when "Auto" is checked:

- ≤50 bytes → 50
- ≤600 bytes → payload length
- ≤1,200 bytes → half payload length
- ≤5,000 bytes → 400
- ≤20,000 bytes → 500
- ≤100,000 bytes → 600
- >100,000 bytes → 700

## Branches

- `main` — production (GitHub Pages); includes both encoder and decoder
- `py_encode` — encoder-only; decoder, perf profiler, and pako removed
