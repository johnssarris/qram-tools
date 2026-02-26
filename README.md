# QRAM Tools

Transfer text and code from a locked-down work PC to an iPhone by
displaying animated barcodes on screen and scanning them with the
phone's camera.

Uses fountain codes (LT codes) so missed or duplicated frames don't
matter — the decoder only needs enough unique packets.

**Barcode format: QR Code only.** Benchmarking confirmed QR wins
decisively over Aztec and Data Matrix on the target stack (iPhone 15 +
Safari). All production and bench tooling is QR-only.

------------------------------------------------------------------------

# Quick Start (Production Text Transfer)

## Encoder (Work PC)

1.  Open `qram_encoder.html` in a modern browser
2.  Paste text/code
3.  Adjust FPS and block size if needed
4.  Click Start

## Decoder (iPhone)

1.  Open `index.html` in Safari (via GitHub Pages)
2.  Allow camera access
3.  Scan the animated codes
4.  Copy the result

### Recommended Settings

-   Block size: 200--400 bytes
-   FPS: 4--8
-   Distance: ~15--30 cm
-   Good lighting helps

------------------------------------------------------------------------

# Benchmarking Harness

For performance testing and diagnostics, use the bench tools:

-   `bench_encoder.html`
-   `bench_decoder.html`

Full documentation below.

------------------------------------------------------------------------

<details>
<summary><strong>Full Benchmarking Documentation</strong></summary>

## Files

### Production

-   `qram_encoder.html` — PC encoder (QR via node-qrcode)
-   `index.html` — iPhone decoder PWA (jsQR only)

### Benchmarking

-   `bench_encoder.html` — QR encoder + batch mode
-   `bench_decoder.html` — A/B scanner decoder + detailed metrics
-   `bench_encoder_v2.html` — alternative encoder UI
-   `bench_decoder_v2.html` — alternative decoder UI

### PWA

-   `manifest.json`
-   `sw.js`

### Libraries

-   `libs/qram.min.js` — fountain codec
-   `libs/qrcode.min.js` — QR encoder (node-qrcode)
-   `libs/jsQR.js` — QR decoder (production + bench scanner A)
-   `libs/zxing-wasm.js` — QR decoder via ZXing WASM (bench scanner B)

------------------------------------------------------------------------

## Bench Encoder

QR-only. Configurable parameters:

-   Packet encoding (base64url or binary)
-   Block size, FPS, QR EC level (L/M/Q/H), scale
-   Payload size and timeout
-   Seeded PRNG for reproducibility
-   SHA-256 hash for integrity verification

Packet header format: 4 bytes run ID + 4 bytes sequence number (BE)

Batch mode:

-   Auto-cycles through JSON-defined test configs
-   Non-QR `barcodeType` values in batch configs are coerced to `"qrcode"`
-   Uses run ID changes to signal decoder reset

------------------------------------------------------------------------

## Bench Decoder

QR-only. Scanner options: **jsQR** or **zxing-wasm** (QR-only mode).

Captures:

-   Scan attempts and successes
-   Successful decodes per second
-   Dedup drops
-   Unique packets
-   Enqueue attempts / accepts / rejects
-   Blocks decoded / total
-   Overhead ratio
-   Time to first packet / first block / total decode
-   Packet timeline and block timeline
-   SHA-256 verification

Batch mode:

-   Auto-detects run ID change
-   Exports each run result
-   Idle timeout detection
-   Export all results JSON

------------------------------------------------------------------------

## Diagnostic Heuristics

-   Low scans/sec → optical bottleneck
-   High scans/sec but low unique packets → dedup/frame issue
-   Unique packets grow but blocks flat → fountain accumulation or corruption
-   High enqueue rejects → format mismatch or corruption

</details>

------------------------------------------------------------------------

# Deployment

Static hosting (GitHub Pages supported). No build step required.

git push origin main
