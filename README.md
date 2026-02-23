# QRAM Tools

Transfer text and code from a locked-down work PC to an iPhone by
displaying animated barcodes on screen and scanning them with the
phone's camera.

Uses fountain codes (LT codes) so missed or duplicated frames don't
matter --- the decoder only needs enough unique packets.

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

-   Block size: 200--400 bytes\
-   FPS: 4--8\
-   Distance: \~15--30 cm\
-   Good lighting helps

------------------------------------------------------------------------

# Benchmarking Harness

For performance testing and diagnostics, use the bench tools:

-   `bench_encoder.html`
-   `bench_decoder.html`

Full documentation below.

------------------------------------------------------------------------

```{=html}
<details>
```
```{=html}
<summary>
```
`<strong>`{=html}Full Benchmarking Documentation`</strong>`{=html}
```{=html}
</summary>
```
## Files

### Production

-   `qram_encoder.html` --- PC encoder
-   `index.html` --- iPhone decoder PWA

### Benchmarking

-   `bench_encoder.html` --- configurable encoder + batch mode
-   `bench_decoder.html` --- multi-library decoder + detailed metrics

### PWA

-   `manifest.json`
-   `sw.js`

### Libraries

-   `qram.min.js`
-   `qrcode.min.js`
-   `jsQR.js`
-   `bwip-js.js`

------------------------------------------------------------------------

## Bench Encoder

Configurable parameters: - Barcode type (Aztec, QR, Data Matrix,
PDF417) - Encoder library - Packet encoding (base64url or binary) -
Block size, FPS, EC level, scale - Payload size and timeout - Seeded
PRNG for reproducibility - SHA-256 hash for integrity verification

Packet header format: - 4 bytes run ID - 4 bytes sequence number

Batch mode: - Auto-cycles through JSON-defined test configs - Uses run
ID changes to signal decoder reset

------------------------------------------------------------------------

## Bench Decoder

Captures: - Scan attempts and successes - Successful decodes per
second - Dedup drops - Unique packets - Enqueue attempts / accepts /
rejects - Blocks decoded / total - Overhead ratio - Time to first
packet - Time to first block - Total decode time - Packet timeline -
Block timeline - SHA-256 verification

Batch mode: - Auto-detects run ID change - Exports each run result -
Idle timeout detection - Export all results JSON

------------------------------------------------------------------------

## Diagnostic Heuristics

-   Low scans/sec → optical bottleneck\
-   High scans/sec but low unique packets → dedup/frame issue\
-   Unique packets grow but blocks flat → fountain accumulation or
    corruption\
-   High enqueue rejects → format mismatch or corruption

```{=html}
</details>
```

------------------------------------------------------------------------

# Deployment

Static hosting (GitHub Pages supported). No build step required.

git push origin main
