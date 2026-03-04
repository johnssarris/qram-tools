# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Purpose

QRAM Tools (`py_encode` branch) transfers text and files from a locked-down work PC to an iPhone using animated QR codes and fountain codes (LT codes). Missed or duplicated frames don't matter — the receiver only needs enough unique packets for reconstruction.

## Development

**No build step.** Pure vanilla JS/HTML/CSS static site. Deployment is `git push origin main` to GitHub Pages.

Serve locally with any static file server (e.g. `python -m http.server`) or open `index.html` directly in a browser.

**Service Worker cache versioning:** Bump `CACHE_NAME` in `sw.js` (currently `qram-v33`) whenever any cached asset changes.

## Architecture

- `index.html` — markup and all CSS
- `libs/app.js` — all application logic; two top-level sections:
  - **Encoder IIFE**: reads text/file input → compresses → encodes with LT fountain codec → renders QR frames to canvas at configurable FPS
  - **Theme toggle IIFE**: dark/light mode, persisted in `localStorage`

### Libraries (`libs/`)

| File | Role |
|------|------|
| `qram.js` | LT fountain codec — provides `qram.Encoder` |
| `qrcode.js` | QR code renderer (byte mode, EC level L only); provides `QRCode.toCanvas` |
| `qram-compress.js` | Gzip compression with QRAMC envelope; provides `qramCompress.maybeCompress(payload)` |

### Data Formats

**Text transfer:** Raw UTF-8 bytes.

**File transfer:** Payload prefixed with magic `QRAMF` (`[0x51,0x52,0x41,0x4D,0x46]`) + 2-byte filename length (big-endian uint16) + UTF-8 filename + file bytes.

**Compression envelope:** Applied automatically when `CompressionStream` is available and saves ≥5% and ≥50 bytes. Format: magic `QRAMC` (`[0x51,0x52,0x41,0x4D,0x43]`) + 1-byte algo (`0x01` = gzip) + 4-byte original length (big-endian uint32) + compressed bytes.

**Fountain codec:** `qram.Encoder({ data, blockSize })` exposes `createReadableStream()` which yields LT-coded packets indefinitely until cancelled.

### Block Size Algorithm

Block size is auto-selected from payload length and shown in the input (user can override):

| Payload | Block size |
|---------|------------|
| ≤ 50 B | 50 |
| ≤ 600 B | payload length (1 block) |
| ≤ 1,200 B | half payload length |
| ≤ 5,000 B | 400 |
| ≤ 20,000 B | 500 |
| ≤ 100,000 B | 600 |
| > 100,000 B | 700 |

## Branches

- `main` — production (GitHub Pages); includes both encoder and decoder
- `py_encode` — encoder-only; decoder, perf profiler, and pako removed
