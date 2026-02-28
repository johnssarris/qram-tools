# QRAM

Transfer text and files from a locked-down PC to your iPhone by displaying animated QR codes on the screen and scanning them with the camera.

No network required. No cable. No cloud. Works entirely offline once installed.

## How it works

The PC runs the encoder tab in any browser and cycles through QR codes at a configurable frame rate. The iPhone runs the decoder tab as a PWA and scans the codes with its camera.

The key insight is **fountain coding** (specifically LT codes): the encoder generates an endless stream of encoded packets, and the decoder only needs to receive roughly *k* + a few extra unique packets to reconstruct the original *k* source blocks — regardless of which packets arrived or in what order. Missed or duplicate frames don't matter. Just point the camera and wait.

### Why QR codes?

QR codes comfortably fit ~1–2 KB per frame at error correction level M, and decode reliably from a phone camera even in less-than-ideal lighting. Aztec and Data Matrix were benchmarked and lost on iPhone + Safari.

## Usage

### Decode (iPhone)

1. Open the page in Safari on your iPhone and add it to the Home Screen (for offline PWA support).
2. The Decode tab opens by default. Grant camera access.
3. On your PC, start the Encode tab and hold the phone up to the screen.
4. A progress bar and block counter show decoding progress in real time.
5. When complete: text is shown in a text area (copy button); files trigger a save dialog.

### Encode (PC)

1. Switch to the Encode tab.
2. Choose **Text** mode and paste, or **File** mode and drag-and-drop a file (max 5 MB).
3. Adjust settings if needed (FPS, block size, error correction, compression).
4. Hit **Start** — QR codes begin cycling. Hit **Stop** when the phone reports completion.

### Settings

| Setting | Default | Notes |
|---|---|---|
| FPS | 10 | Higher is faster but the camera needs to keep up (~15–20 is practical) |
| Block size | 200 B | Smaller blocks → more, smaller QR codes; larger blocks → fewer, denser codes |
| Error correction | M (15%) | Higher EC = more robust to partial occlusion, but fewer data bytes per code |
| Compress | On | gzip via native `CompressionStream`; skipped automatically if it doesn't help |

## Architecture

```
qram-tools/
├── index.html              # Single-page PWA — Encode + Decode tabs
├── app.js                  # Application logic (ES module)
├── manifest.json           # PWA manifest
├── sw.js                   # Service worker (cache-first, offline support)
├── qram-core/              # Rust source for the WASM module
│   ├── Cargo.toml
│   └── src/lib.rs          # LT codec + QR generator
└── libs/
    ├── pkg/
    │   ├── qram_core.js    # wasm-bindgen JS glue (generated)
    │   └── qram_core_bg.wasm  # Compiled WASM binary (~49 KB)
    ├── jsQR.js             # QR code decoder (camera → binary data)
    ├── pako.min.js         # gzip fallback (for older browsers)
    └── compress.js         # QRAMC compression envelope
```

### WASM core (`qram-core`)

The Rust crate compiles to a single WASM binary that handles both the computationally heavy parts of the pipeline:

**LT fountain codec**

- `LTEncoder` — splits the payload into *k* source blocks, then generates an endless stream of encoded packets. Each packet XORs a randomly-chosen subset of source blocks together; the subset is determined deterministically from `(run_id, seq_num)` using xorshift64 + the Robust Soliton degree distribution.
- `LTDecoder` — belief propagation (BP) decoder with an inverted block→packet index for efficient propagation. Decoding typically completes with ~5–10% overhead above *k*.

**QR generation**

- `qr_generate(data, ec_level)` — encodes arbitrary bytes as a QR code using the `qrcodegen` Rust crate (Nayuki's reference implementation), returning a flat `[size: u32 LE, modules: size×size bytes]` array that `app.js` renders to a `<canvas>`.

### Packet wire format

Every packet is self-describing, so the decoder can fully bootstrap from any single received packet:

```
bytes  0-3  : run_id     (u32 big-endian)  — unique 32-bit session ID
bytes  4-7  : k          (u32 big-endian)  — source block count
bytes  8-11 : orig_len   (u32 big-endian)  — original payload length (pre-padding)
bytes 12-15 : seq_num    (u32 big-endian)  — packet sequence number
bytes 16+   : payload    (block_size bytes) — XOR of selected source blocks
```

### File-transfer envelope

When sending a file (rather than plain text), the payload is wrapped in a QRAMF envelope before fountain-encoding:

```
bytes 0-4  : 'QRAMF' (0x51 0x52 0x41 0x4D 0x46)
bytes 5-6  : filename length (u16 big-endian)
bytes 7+N  : UTF-8 filename
bytes 7+N+ : raw file bytes
```

### Compression envelope

When compression is enabled (and actually helps), the payload is wrapped in a QRAMC envelope before fountain-encoding:

```
bytes 0-4  : 'QRAMC' (0x51 0x52 0x41 0x4D 0x43)
byte  5    : algorithm (1 = gzip)
bytes 6-9  : original length (u32 big-endian)
bytes 10+  : compressed payload
```

Compression is skipped automatically if the compressed envelope is ≥ 95% of the original size or saves fewer than 50 bytes.

## Building the WASM module

The compiled WASM binary (`libs/pkg/`) is committed to the repo, so no build step is needed to run the app. To rebuild after modifying `qram-core/src/lib.rs`:

```bash
# Install tools (one-time)
rustup target add wasm32-unknown-unknown
cargo install wasm-pack

# Build
cd qram-core
wasm-pack build --target web --out-dir ../libs/pkg
```

Requires Rust 1.70+ and wasm-pack 0.12+.

## Running locally

Any static file server works:

```bash
# Python
python3 -m http.server 8080

# Node
npx serve .
```

Then open `http://localhost:8080` on the PC and `http://<your-ip>:8080` on the iPhone (or use a tunnel like ngrok for HTTPS, which is required for camera access on iOS).

## Limits

| | |
|---|---|
| Max file size | 5 MB |
| Max data per QR frame | ~1–2 KB (depends on block size and EC level) |
| Minimum iOS | 15.4 (for `requestVideoFrameCallback`; older falls back to `requestAnimationFrame`) |
| Minimum Safari | 15.4 |
