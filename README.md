# QRAM Tools

Transfer text and code from a locked-down work PC to your iPhone by displaying animated QR codes on screen and scanning them with the phone's camera. No software installation required on the PC — just a browser.

## How it works

1. **Encoder** (work PC browser): Paste text, click Start. The page splits your data into blocks and displays an animated sequence of QR codes using [fountain codes](https://en.wikipedia.org/wiki/Fountain_code).
2. **Decoder** (iPhone PWA): Point your camera at the animated QR stream. The app reconstructs the original data from scanned frames, then lets you copy it to the clipboard.

Fountain codes (LT codes) make this robust: the encoder generates redundant packets indefinitely, so missed or duplicated frames don't matter. The decoder just needs *enough* unique packets — it doesn't matter which ones or what order they arrive in.

## Files

```
index.html          iPhone decoder — scans animated QR stream, reassembles data
qram_encoder.html   PC encoder — paste text, generates animated QR codes
manifest.json       PWA manifest for home screen installation
sw.js               Service worker for offline support
libs/
  qram.min.js       Fountain code encoder/decoder (Digital Bazaar, v0.3.9)
  qrcode.min.js     QR code generation (node-qrcode, v1.5.1)
  jsQR.js           QR code scanning from camera frames (jsQR, v1.4.0)
```

## Usage

### Encoder (work PC)

1. Open `qram_encoder.html` in any modern browser (works from `file://` or served via GitHub Pages)
2. Paste text/code into the textarea
3. Adjust **FPS** (animation speed, default 6) and **Block size** (bytes per block, default 300) if needed
4. Click **Start** — animated QR codes will display on screen
5. Keep it running until the decoder finishes

### Decoder (iPhone)

1. Open `index.html` in Safari (via GitHub Pages URL)
2. Optionally add to home screen for fullscreen PWA experience
3. Allow camera access when prompted
4. Point the camera at the animated QR codes on your PC screen
5. Watch the progress bar fill as blocks are received
6. When complete, tap **Copy to Clipboard**

### Tips

- **Smaller block size** = smaller QR codes (easier to scan) but more frames needed
- **Larger block size** = fewer frames but denser QR codes (harder for the camera to read)
- **Higher FPS** = faster transfer if your camera can keep up; lower FPS is more reliable
- A block size of 200-400 bytes at 4-8 FPS works well for most phone cameras
- Hold the phone steady, ~15-30cm from the screen
- Good lighting and a clean screen help scanning reliability

## Deployment

Serve all files from any static host. GitHub Pages works well:

```sh
git push origin main
# Enable Pages in repo Settings → Pages → Deploy from branch
```

The decoder is a PWA — once loaded, it works offline thanks to the service worker.

## Tech stack

- [qram](https://github.com/digitalbazaar/qram) — LT/fountain code encoding and decoding
- [node-qrcode](https://github.com/soldair/node-qrcode) — QR code generation to canvas
- [jsQR](https://github.com/cozmo/jsQR) — QR code detection from camera frames
- Pure HTML/JS, no build step, no npm required

## How fountain codes help

Traditional sequential transfer would require every frame to be received in order. One missed frame means retransmission — but there's no back-channel from phone to PC.

Fountain codes solve this: the encoder generates a potentially infinite stream of redundant packets, each encoding a random combination of data blocks. The decoder needs roughly N packets to reconstruct N blocks of original data (with small overhead). It doesn't matter which packets are received, what order, or how many are missed — just keep scanning until the progress bar hits 100%.
