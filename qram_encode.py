#!/usr/bin/env python3
"""qram_encode.py — QRAM fountain-code animated QR encoder (Python CLI)

Compatible wire format with the JS browser encoder (qram.js / qram-compress.js).

Usage:
  python qram_encode.py text "Hello, world!"
  python qram_encode.py file path/to/file.pdf [--fps 20] [--block-size N]

Dependencies:
  pip install qrcode[pil]          # required
  pip install segno                # optional but ~3x faster QR generation
"""

import argparse
import bisect
import gzip
import hashlib
import io
import math
import os
import random
import struct
import sys
import threading
import tkinter as tk
from collections import deque
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

try:
    from PIL import Image, ImageTk
except ImportError:
    sys.exit("Missing dependencies. Install with:  pip install qrcode[pil]")

# ─── Constants ────────────────────────────────────────────────────────────────

FILE_MAGIC     = b"QRAMF"
COMPRESS_MAGIC = b"QRAMC"
COMPRESS_HEADER_LEN = 10

MIN_COMPRESS_RATIO       = 0.95
MIN_COMPRESS_SAVED_BYTES = 50
MIN_COMPRESS_INPUT_BYTES = 50

MULTIHASH_SHA256  = 0x12
DIGEST_SIZE       = 32
PACKET_VERSION    = 1

DEFAULT_FAILURE_PROB  = 0.01
MAX_BLOCKS_PER_PACKET = 50

MAX_FILE_SIZE  = 10 * 1024 * 1024
MIN_BLOCK_SIZE = 50
MAX_BLOCK_SIZE = 20_000
MIN_FPS        = 1
MAX_FPS        = 60
DEFAULT_FPS    = 20
QR_WIDTH       = 350
QR_BORDER      = 1   # modules on each side


# ─── SHA-256 multihash ────────────────────────────────────────────────────────

def sha256_multihash(data: bytes) -> bytes:
    digest = hashlib.sha256(data).digest()
    return bytes([MULTIHASH_SHA256, len(digest)]) + digest


# ─── Robust Soliton degree distribution ──────────────────────────────────────

class RandomDegree:
    """Robust Soliton distribution — direct port of qram.js RandomDegree."""

    def __init__(self, N: int, failure_probability: float = DEFAULT_FAILURE_PROB):
        if not (isinstance(N, int) and N > 0):
            raise ValueError('"N" must be an integer > 0')

        M = math.ceil(N / 2)
        R = N / M

        weights = [0.0, 1.0 / N]
        for k in range(2, N + 1):
            weights.append(1.0 / (k * (k - 1)))
        for k in range(1, M):
            weights[k] += 1.0 / (k * M)
        weights[M] += math.log(R / failure_probability) / M

        self._total = sum(weights)
        self._cw    = [0.0]
        cum = 0.0
        for k in range(1, N + 1):
            cum += weights[k]
            self._cw.append(cum)

    def next(self) -> int:
        r = random.random() * self._total
        # C-accelerated binary search replaces the hand-rolled Python version
        return bisect.bisect_right(self._cw, r, lo=1)


# ─── Packet creation ──────────────────────────────────────────────────────────

def _header_size(index_count: int) -> int:
    return 9 + 2 * index_count + (2 + DIGEST_SIZE) + (2 + DIGEST_SIZE) + 4


def make_packet(
    total_size: int,
    blocks: list[bytes],
    indexes: list[int],
    block_size: int,
    data_digest: bytes,
) -> bytes:
    """Build one LT-coded packet: header || XOR'd payload."""
    n = len(blocks)
    hdr_size = _header_size(n)

    # XOR all blocks via Python big-integer arithmetic — ~20x faster than a
    # byte-by-byte Python loop (int.from_bytes / XOR / to_bytes are all C).
    acc = int.from_bytes(blocks[0], "big")
    for blk in blocks[1:]:
        acc ^= int.from_bytes(blk, "big")
    payload_bytes = acc.to_bytes(block_size, "big")

    packet_digest = sha256_multihash(payload_bytes)

    buf = bytearray(hdr_size + block_size)
    buf[hdr_size:] = payload_bytes

    p = 0
    buf[p] = PACKET_VERSION;                          p += 1
    struct.pack_into(">H", buf, p, hdr_size);         p += 2
    struct.pack_into(">I", buf, p, total_size);       p += 4
    struct.pack_into(">H", buf, p, n);                p += 2
    for idx in indexes:
        struct.pack_into(">H", buf, p, idx);          p += 2
    buf[p : p + len(packet_digest)] = packet_digest;  p += len(packet_digest)
    buf[p : p + len(data_digest)]   = data_digest;    p += len(data_digest)
    struct.pack_into(">I", buf, p, block_size)

    return bytes(buf)


# ─── LT Encoder ──────────────────────────────────────────────────────────────

class Encoder:
    """LT fountain encoder — direct port of qram.js Encoder."""

    def __init__(
        self,
        data: bytes,
        block_size: int,
        failure_probability: float = DEFAULT_FAILURE_PROB,
        max_blocks_per_packet: int = MAX_BLOCKS_PER_PACKET,
    ):
        self.data        = data
        self.block_size  = block_size
        self.block_count = math.ceil(len(data) / block_size)
        self._random     = RandomDegree(self.block_count, failure_probability)
        self._max_bpp    = max_blocks_per_packet
        self._blocks: list[bytes | None] = [None] * self.block_count
        self._data_digest = sha256_multihash(data)

    def _get_block(self, index: int) -> bytes:
        blk = self._blocks[index]
        if blk is not None:
            return blk
        offset = index * self.block_size
        chunk  = self.data[offset : offset + self.block_size]
        if len(chunk) < self.block_size:
            chunk = chunk + b"\x00" * (self.block_size - len(chunk))
        self._blocks[index] = chunk
        return chunk

    def next_packet(self) -> bytes:
        degree = max(1, min(self._random.next(), self._max_bpp, self.block_count))
        # random.sample is C-implemented and O(degree) — no rejection sampling
        indexes = sorted(random.sample(range(self.block_count), degree))
        blocks  = [self._get_block(i) for i in indexes]
        return make_packet(
            len(self.data), blocks, indexes, self.block_size, self._data_digest
        )

    def __iter__(self):
        while True:
            yield self.next_packet()


# ─── Compression ─────────────────────────────────────────────────────────────

def maybe_compress(payload: bytes) -> bytes:
    """Apply QRAMC gzip envelope if it saves >= 5% and >= 50 bytes."""
    if len(payload) < MIN_COMPRESS_INPUT_BYTES:
        return payload
    try:
        compressed = gzip.compress(payload, compresslevel=9)
    except Exception:
        return payload

    envelope_size = COMPRESS_HEADER_LEN + len(compressed)
    if (envelope_size / len(payload) > MIN_COMPRESS_RATIO
            or len(payload) - envelope_size < MIN_COMPRESS_SAVED_BYTES):
        return payload

    return COMPRESS_MAGIC + bytes([0x01]) + struct.pack(">I", len(payload)) + compressed


# ─── Payload builders ─────────────────────────────────────────────────────────

def auto_block_size(n: int) -> int:
    if n <= 50:       return 50
    if n <= 600:      return n
    if n <= 1_200:    return math.ceil(n / 2)
    if n <= 5_000:    return 400
    if n <= 20_000:   return 500
    if n <= 100_000:  return 600
    return 700


def build_text_payload(text: str) -> bytes:
    return text.encode("utf-8")


def build_file_payload(path: Path) -> bytes:
    data = path.read_bytes()
    if len(data) > MAX_FILE_SIZE:
        sys.exit(f"File too large ({len(data):,} B). Max is {MAX_FILE_SIZE:,} B.")
    name_bytes = path.name.encode("utf-8")
    return FILE_MAGIC + struct.pack(">H", len(name_bytes)) + name_bytes + data


def format_bytes(n: int) -> str:
    if n < 1024:    return f"{n} B"
    if n < 1048576: return f"{n / 1024:.1f} KB"
    return f"{n / 1048576:.1f} MB"


# ─── Worker process helpers ───────────────────────────────────────────────────
# All functions here must be module-level so ProcessPoolExecutor can pickle them.

def _worker_init() -> None:
    """Pre-import heavy libraries once per worker process at pool-creation time.

    On Windows, ProcessPoolExecutor uses 'spawn': each worker starts a fresh
    Python interpreter and must import everything from scratch.  Without this
    initializer the first real job in each worker pays a ~700 ms cold-import
    penalty (segno + numpy + PIL), causing a visible freeze before the first
    QR frame appears.  With the initializer those imports happen while the
    tkinter UI is being built, so they are invisible to the user.
    """
    try:
        import segno        # noqa: F401
    except ImportError:
        pass
    try:
        import numpy        # noqa: F401
    except ImportError:
        pass
    try:
        from PIL import Image  # noqa: F401
    except ImportError:
        pass


def _render_worker(packet: bytes, target_px: int) -> bytes:
    """Render one LT packet as a QR code. Returns BMP or PNG bytes.

    Each packet uses fit=True so the QR version exactly matches the packet
    size — no extra padding bytes that would confuse the decoder.

    Fast path  (segno + numpy): matrix → numpy array → BMP.
      - Skips segno's PNG encoder/PIL PNG decoder round-trip.
      - BMP is uncompressed: save/load are O(pixels), not O(compressed size).
    Medium path (segno alone): segno PNG output.
    Slow path   (qrcode):      pure-Python fallback.

    Runs in a worker process — true parallelism, separate GIL per process.
    """
    buf = io.BytesIO()
    try:
        import segno
        qr = segno.make_qr(packet, error="l")   # fit=True: exact version per packet
        # box_size so the native output is ~target_px wide (no resize needed)
        box_size = max(1, target_px // (qr.version * 4 + 17 + 2 * QR_BORDER))
        try:
            import numpy as np
            # qr.matrix: tuple-of-tuples of uint8; odd value = dark module.
            mat = np.array(qr.matrix, dtype=np.uint8)
            pixels = ((mat & 1) ^ 1) * 255  # dark→0 (black), light→255 (white)
            pixels = np.pad(pixels, QR_BORDER, constant_values=255)
            pixels = np.repeat(np.repeat(pixels, box_size, axis=0), box_size, axis=1)
            from PIL import Image
            Image.fromarray(pixels, mode="L").save(buf, format="BMP")
            return buf.getvalue()
        except ImportError:
            pass
        qr.save(buf, kind="png", scale=box_size, border=QR_BORDER)
        return buf.getvalue()
    except ImportError:
        pass
    # Last resort: qrcode (pure Python, slower RS)
    import qrcode
    qr = qrcode.QRCode(
        error_correction=qrcode.constants.ERROR_CORRECT_L,
        box_size=10,
        border=QR_BORDER,
    )
    qr.add_data(packet, optimize=0)
    qr.make(fit=True)
    img = qr.make_image(fill_color="black", back_color="white")
    from PIL import Image
    img = img.convert("L").resize((target_px, target_px), Image.NEAREST)
    img.save(buf, format="BMP")
    return buf.getvalue()


# ─── Display window ───────────────────────────────────────────────────────────

class QRDisplay:
    """Animated QR display.

    Architecture:
      Feeder thread — generates LT packets (fast, pure Python) and submits
        render jobs to a ProcessPoolExecutor. Blocks on a Semaphore when
        _PREFETCH futures are already in flight.
      Worker processes — render QR PNGs in parallel with true concurrency
        (separate GIL per process). Return PNG bytes back to main process.
      UI thread — polls futures in _tick(); when the oldest is done, opens
        the PNG and displays it via tkinter.
    """

    # Use as many cores as available, leaving one free for the UI.
    # Saturating all cores improves throughput for slow (high-version) QR renders.
    _WORKERS  = max(2, (os.cpu_count() or 2) - 1)
    _PREFETCH = _WORKERS * 2   # keep pipeline full

    def __init__(
        self,
        encoder: Encoder,
        fps: int,
        label: str,
    ):
        self._encoder  = encoder
        self._delay_ms = max(1, round(1000 / fps))
        self._label    = label
        self._n        = 0
        self._running  = True
        self._futures: deque = deque()
        self._sem  = threading.Semaphore(self._PREFETCH)
        self._pool = ProcessPoolExecutor(
            max_workers=self._WORKERS,
            initializer=_worker_init,   # pre-import segno/numpy/PIL at spawn time
        )

        self._thread = threading.Thread(target=self._feeder_loop, daemon=True)
        self._thread.start()

        self.root = tk.Tk()
        self.root.title("QRAM Encoder")
        self.root.resizable(False, False)

        self._stats_var = tk.StringVar(value=label)
        tk.Label(self.root, textvariable=self._stats_var,
                 font=("Courier", 11)).pack(pady=(8, 2))

        self._img_label = tk.Label(self.root)
        self._img_label.pack(padx=8, pady=4)

        tk.Button(self.root, text="Stop", width=10,
                  command=self._stop).pack(pady=(2, 8))

        self.root.protocol("WM_DELETE_WINDOW", self._stop)
        self.root.after(0, self._tick)
        self.root.mainloop()

        self._pool.shutdown(wait=False, cancel_futures=True)

    def _feeder_loop(self) -> None:
        for pkt in self._encoder:
            if not self._running:
                break
            # Block here when PREFETCH slots are full; timeout lets us re-check _running
            if not self._sem.acquire(timeout=1.0) or not self._running:
                break
            self._futures.append(
                self._pool.submit(_render_worker, pkt, QR_WIDTH)
            )

    def _tick(self) -> None:
        if not self._running:
            return
        # If no futures ready, retry quickly without counting as a frame
        if not self._futures or not self._futures[0].done():
            self.root.after(5, self._tick)
            return

        future = self._futures.popleft()
        self._sem.release()   # allow feeder to submit another

        try:
            png_bytes = future.result()
        except Exception as exc:
            print(f"Render error: {exc}", file=sys.stderr)
            self.root.after(self._delay_ms, self._tick)
            return

        photo = ImageTk.PhotoImage(Image.open(io.BytesIO(png_bytes)))
        self._img_label.config(image=photo)
        self._img_label._photo = photo  # prevent GC

        self._n += 1
        self._stats_var.set(f"{self._label}  |  packet #{self._n}")
        self.root.after(self._delay_ms, self._tick)

    def _stop(self) -> None:
        self._running = False
        self._sem.release()  # unblock feeder if waiting on acquire
        self.root.destroy()


# ─── CLI ──────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(
        description="QRAM fountain-code animated QR encoder",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = parser.add_subparsers(dest="mode", required=True)

    p_text = sub.add_parser("text", help="Encode a text string")
    p_text.add_argument("content", help="UTF-8 text to encode")
    p_text.add_argument("--fps", type=int, default=DEFAULT_FPS)
    p_text.add_argument("--block-size", type=int, default=0,
                        help="Block size in bytes (default: auto)")

    p_file = sub.add_parser("file", help="Encode a file")
    p_file.add_argument("path", type=Path, help="File to encode")
    p_file.add_argument("--fps", type=int, default=DEFAULT_FPS)
    p_file.add_argument("--block-size", type=int, default=0,
                        help="Block size in bytes (default: auto)")

    args = parser.parse_args()
    fps = max(MIN_FPS, min(MAX_FPS, args.fps))

    if args.mode == "text":
        payload = build_text_payload(args.content)
        label = f"text  {format_bytes(len(payload))}"
    else:
        payload = build_file_payload(args.path)
        label = f"file: {args.path.name}  {format_bytes(len(payload))}"

    send_data = maybe_compress(payload)
    if send_data is not payload:
        pct = (1 - len(send_data) / len(payload)) * 100
        print(f"Compressed: {format_bytes(len(payload))} → {format_bytes(len(send_data))} (−{pct:.0f}%)")
    else:
        print(f"Data: {format_bytes(len(send_data))}")

    block_size = args.block_size
    if block_size <= 0:
        block_size = auto_block_size(len(send_data))
    block_size = max(MIN_BLOCK_SIZE, min(MAX_BLOCK_SIZE, block_size))

    block_count = math.ceil(len(send_data) / block_size)
    print(f"Block size: {block_size}  |  Blocks: {block_count}  |  FPS: {fps}")
    print(f"Workers: {QRDisplay._WORKERS}  |  Prefetch: {QRDisplay._PREFETCH}")

    encoder = Encoder(send_data, block_size)
    QRDisplay(encoder, fps, f"{label}  |  {block_count} blocks  |  {fps} fps")


if __name__ == "__main__":
    main()
