# QRAM Tools

Transfer text and code from a locked-down work PC to an iPhone by displaying animated barcodes on screen and scanning them with the phone's camera. No software installation required on the PC — just a browser.

Uses [fountain codes](https://en.wikipedia.org/wiki/Fountain_code) (LT codes) so missed or duplicated frames don't matter. The decoder just needs *enough* unique packets — not specific ones, not in order.

## Files

```
Production (text transfer):
  qram_encoder.html       PC encoder — paste text, generates animated QR codes
  index.html              iPhone decoder PWA — scans QR stream, reassembles data

Benchmarking harness:
  bench_encoder.html      Bench encoder — configurable barcode type, encoding,
                          block size, FPS, EC, scale; single-run and batch mode
  bench_decoder.html      Bench decoder — multi-library scanning, full metrics,
                          auto-batch with run ID change detection

Experimental (not merged into production):
  aztec_test.html         Encoder test with bwip-js and multi-format support
  index_aztest.html       Decoder test with ZXing and multi-format scanning

PWA:
  manifest.json           PWA manifest for home screen installation
  sw.js                   Service worker for offline support

libs/
  qram.min.js             Fountain code encoder/decoder (Digital Bazaar, v0.3.9)
  qrcode.min.js           QR code generation (node-qrcode)
  jsQR.js                 QR code scanning from camera frames
  bwip-js-min.js          Multi-format barcode generation (Aztec, Data Matrix, QR, PDF417)
  bwip-js.js              bwip-js unminified source
```

## Quick start

### Text transfer (production)

**Encoder (work PC):**
1. Open `qram_encoder.html` in any modern browser
2. Paste text/code into the textarea
3. Adjust FPS and block size if needed
4. Click **Start**

**Decoder (iPhone):**
1. Open `index.html` in Safari (via GitHub Pages)
2. Allow camera access, point at the animated QR codes
3. Watch progress, then copy result to clipboard

### Tips
- Block size 200-400 bytes at 4-8 FPS works well for most phone cameras
- Smaller blocks = easier to scan, more frames needed
- Hold the phone steady, ~15-30cm from the screen
- Good lighting and a clean screen help

## Benchmarking harness

The bench harness measures real-world throughput and reliability across barcode types, encoding methods, block sizes, FPS, and decoder libraries. Results are structured JSON designed for analysis and comparison.

### Bench encoder (`bench_encoder.html`)

Generates random payloads and streams them as animated barcodes with a configurable test setup.

**Configurable parameters:**
- Barcode type: Aztec, Data Matrix, QR Code, PDF417
- Encoder library: bwip-js or qrcode.min.js (QR only)
- Packet encoding: base64url or binary
- Block size, FPS, error correction, scale
- Per-run timeout (default 120s)
- Mat/background for quiet zone testing
- Environment notes (distance, brightness, conditions)

**Payload generation:**
- Uses a seeded PRNG (xorshift128) so any run can be exactly reproduced by reusing the same `randomSeed` value from the config JSON
- SHA-256 hash included in config for integrity verification on the decoder

**Packet format:**
- 8-byte header: 4 bytes run ID + 4 bytes sequence number (big-endian)
- Followed by qram fountain code data
- Encoded as base64url text or raw binary depending on config

**Single-run mode:** Generate Payload, then Start/Stop manually.

**Batch mode:** Paste or upload a JSON array of test configs. The encoder auto-cycles through each config: generates payload, streams for the configured timeout, pauses 4 seconds with a visual countdown (so the decoder can detect the run ID change), then advances.

Example batch config:
```json
[
  {
    "label": "aztec-b64-120",
    "barcodeType": "azteccode",
    "packetEncoding": "base64url",
    "blockSize": 120,
    "fps": 12,
    "payloadSize": 500,
    "timeoutSec": 60,
    "ecLevel": 33,
    "scale": 2
  },
  {
    "label": "qr-b64-200",
    "barcodeType": "qrcode",
    "encoderLib": "bwip-js",
    "packetEncoding": "base64url",
    "blockSize": 200,
    "fps": 8,
    "payloadSize": 1000,
    "timeoutSec": 90,
    "ecLevel": "M",
    "scale": 3
  }
]
```

### Bench decoder (`bench_decoder.html`)

Scans barcodes from camera or video file, feeds packets into the qram fountain decoder, and captures detailed metrics.

**Configurable options:**
- Decoder library: ZXing or jsQR (QR only)
- Barcode format filter: Auto, Aztec, Data Matrix, QR Code, PDF417
- Scan interval: 250ms / 120ms / 80ms / 50ms
- Packet encoding: base64url or binary
- Per-run timeout (default 120s) and idle timeout (default 90s)

**Metrics captured per run:**
- Scan attempts, successes, and actual scans/sec
- Dedup drops, unique packets, packets/sec
- Enqueue attempts, accepts, and rejects (diagnoses silent corruption)
- Blocks decoded / total, overhead ratio
- Time to first packet, first block, total decode time
- Block decode timeline (timestamp + packet count at each block)
- Packet timeline (seq number + elapsed at each unique packet)
- SHA-256 hash verification against expected hash
- Library versions (decoder, encoder if provided, qram)

**Encoder config echo:** Paste the encoder's config JSON into the decoder. Key fields (`barcodeType`, `blockSize`, `fps`, `payloadSize`, `packetEncoding`, `encoderLib`, `ecLevel`, `scale`, `randomSeed`) are echoed into each result so every result is fully self-contained.

**Batch mode (decoder side):**
- Auto-detects when the encoder's run ID changes — exports the current run's result and resets for the new run
- Accumulates all run results into an array
- **Export All Results** button dumps the full batch as JSON
- Idle timeout: if no new packets arrive for N seconds, auto-exports as failed and waits for next run
- Shows batch progress: runs completed, success/fail counts

### Interpreting results

Key diagnostic patterns:
- **Low scans/sec or many scan failures** — optical bottleneck: reduce density, increase scale, adjust lighting/distance
- **High scans/sec but low unique packets** — dedup/frame issue: check that frames are actually changing
- **Unique packets grow but blocks stay flat** — may be normal fountain accumulation (slow then cascade), or corruption if it never resolves
- **High enqueue rejects** — packets are being parsed but the fountain decoder is rejecting them (corruption or format mismatch)
- **Gap between uniquePackets and enqueueAccepts** — silent corruption: packets counted but not contributing to decode

## Deployment

Serve all files from any static host. GitHub Pages works:

```sh
git push origin main
# Enable Pages in repo Settings → Pages → Deploy from branch
```

The decoder is a PWA — once loaded it works offline via the service worker.

## Tech stack

- [qram](https://github.com/digitalbazaar/qram) — LT/fountain code encoding and decoding
- [bwip-js](https://github.com/metafloor/bwip-js) — multi-format barcode generation (Aztec, Data Matrix, QR, PDF417)
- [node-qrcode](https://github.com/soldair/node-qrcode) — QR code generation to canvas
- [jsQR](https://github.com/cozmo/jsQR) — QR code detection from camera frames
- [ZXing](https://github.com/niclas-niclas-niclas/niclas-niclas-niclas.github.io) — multi-format barcode scanning (@zxing/browser@0.1.5, loaded from unpkg CDN)
- Pure HTML/JS, no build step, no npm required

## How fountain codes help

Traditional sequential transfer requires every frame in order. One missed frame means retransmission — but there's no back-channel from phone to PC.

Fountain codes solve this: the encoder generates a potentially infinite stream of redundant packets, each encoding a random combination of data blocks. The decoder needs roughly N packets to reconstruct N blocks (with small overhead). It doesn't matter which packets are received, what order, or how many are missed — just keep scanning until complete.

A healthy run needs only N + small overhead packets. If you're seeing hundreds of packets with barely any blocks decoded, that's not normal fountain behavior — it indicates silent corruption, and the bench harness metrics (enqueue accepts/rejects, hash verification) will help diagnose it.
