# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Purpose

QRAM Tools (`py_encode` branch) transfers text and files from a PC to an iPhone using animated QR codes and fountain codes (LT codes). Missed or duplicated frames don't matter — the receiver only needs enough unique packets for reconstruction.

## Development

Run the encoder directly with Python:

```
python qram_encode.py text "Hello, world!"
python qram_encode.py file path/to/file.pdf --fps 20 --block-size 500
```

Dependencies: `pip install segno numpy pygame`

## Data Formats

**Text transfer:** Raw UTF-8 bytes.

**File transfer:** Payload prefixed with magic `QRAMF` (`[0x51,0x52,0x41,0x4D,0x46]`) + 2-byte filename length (big-endian uint16) + UTF-8 filename + file bytes.

**Compression envelope:** Applied automatically when gzip saves ≥5% and ≥50 bytes. Format: magic `QRAMC` (`[0x51,0x52,0x41,0x4D,0x43]`) + 1-byte algo (`0x01` = gzip) + 4-byte original length (big-endian uint32) + compressed bytes.

**Fountain codec:** LT-coded packets are generated indefinitely; the receiver only needs enough unique packets to reconstruct the original data.

### Block Size Algorithm

Block size is auto-selected from payload length (user can override with `--block-size`):

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
- `py_encode` — Python CLI encoder only; no web app
