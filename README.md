# QRAM Tools — Python Encoder

Transfer text and files device to device by displaying animated
QR codes on screen and scanning them with your phone's camera.

Uses fountain codes (LT codes) so missed or duplicated frames don't
matter — the receiver only needs enough unique packets to reconstruct
the original data.

---

## Quick Start

1. Install dependencies: `pip install segno numpy pygame`
2. Encode text: `python qram_encode.py text "Hello, world!"`
3. Encode a file: `python qram_encode.py file path/to/file.pdf`
4. Scan the QR codes with your phone

## Tips

- **FPS**: 4–8 is reliable for most cameras; go higher if your scanner keeps up (`--fps 20`)
- **Block size**: auto-selected based on payload size; override if needed (`--block-size 500`)
- **Distance**: ~15–30 cm, good lighting, phone held steady
- Compression is applied automatically when it helps (gzip)
