# QRAM Tools — Encoder

Transfer text and files from a locked-down work PC to an iPhone by
displaying animated QR codes on screen and scanning them with the
phone's camera.

Uses fountain codes (LT codes) so missed or duplicated frames don't
matter — the receiver only needs enough unique packets to reconstruct
the original data.

---

## Quick Start

1. Open `index.html` in a modern browser, or serve via a static file server
2. Paste text or drop a file (up to 1 MB)
3. Adjust FPS and block size if needed
4. Click **Start Encoding** and scan the QR codes with your phone

## Tips

- **FPS**: 4–8 is reliable for most cameras; go higher if your scanner keeps up
- **Block size**: auto-selected based on payload size; override if needed
- **Distance**: ~15–30 cm, good lighting, phone held steady
- Compression is applied automatically when it helps (gzip via `CompressionStream`)

## Deployment

Static hosting, no build step.

```
git push origin main
```
