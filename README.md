# QRAM Tools — Encoder

Transfer text and files from a locked-down work PC to an iPhone by
displaying animated QR codes on screen and scanning them with the
phone's camera.

Uses fountain codes (LT codes) so missed or duplicated frames don't
matter — the receiver only needs enough unique packets to reconstruct
the original data.

------------------------------------------------------------------------

# Quick Start

1. Open `index.html` in a modern browser (or serve via a static file
   server / GitHub Pages)
2. Paste text or drop a file
3. Adjust FPS and block size if needed
4. Click **Start Encoding**

### Recommended Settings

- Block size: 200–400 bytes (or use Auto)
- FPS: 4–8
- Distance: ~15–30 cm, good lighting

------------------------------------------------------------------------

# Deployment

Static hosting (GitHub Pages supported). No build step required.

```
git push origin main
```
