#!/usr/bin/env python3
"""qram_encode.py — QRAM fountain-code animated QR encoder (Python CLI)

Reworked for better runtime performance:
- Drops tkinter / ImageTk hot-path
- Avoids PNG/BMP encode/decode per frame
- Workers return compact QR matrix bits; main process scales and colours locally
- Uses pygame for direct blitting
- Keeps QRAM / QRAMC wire compatibility with the JS encoder

Usage:
  python qram_encode.py text "Hello, world!"
  python qram_encode.py file path/to/file.pdf --fps 20 --block-size 500

Dependencies:
  pip install segno numpy pygame
"""

from __future__ import annotations

import argparse
import bisect
import gzip
import hashlib
import math
import os
import random
import struct
import sys
import threading
import time
from collections import deque
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np


# ─── Constants ────────────────────────────────────────────────────────────────

FILE_MAGIC = b"QRAMF"
COMPRESS_MAGIC = b"QRAMC"
COMPRESS_HEADER_LEN = 10

MIN_COMPRESS_RATIO = 0.95
MIN_COMPRESS_SAVED_BYTES = 50
MIN_COMPRESS_INPUT_BYTES = 50

MULTIHASH_SHA256 = 0x12
DIGEST_SIZE = 32
PACKET_VERSION = 1

DEFAULT_FAILURE_PROB = 0.01
MAX_BLOCKS_PER_PACKET = 50

MAX_FILE_SIZE = 10 * 1024 * 1024
MIN_BLOCK_SIZE = 50
MAX_BLOCK_SIZE = 20_000
MIN_FPS = 1
MAX_FPS = 60
DEFAULT_FPS = 20
QR_WIDTH = 350
QR_BORDER = 1


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
        self._cw = [0.0]
        cum = 0.0
        for k in range(1, N + 1):
            cum += weights[k]
            self._cw.append(cum)

    def next(self) -> int:
        r = random.random() * self._total
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

    arr = np.frombuffer(blocks[0], dtype=np.uint8).copy()
    for blk in blocks[1:]:
        arr ^= np.frombuffer(blk, dtype=np.uint8)
    payload_bytes = arr.tobytes()

    packet_digest = sha256_multihash(payload_bytes)

    buf = bytearray(hdr_size + block_size)
    buf[hdr_size:] = payload_bytes

    p = 0
    buf[p] = PACKET_VERSION
    p += 1
    struct.pack_into(">H", buf, p, hdr_size)
    p += 2
    struct.pack_into(">I", buf, p, total_size)
    p += 4
    struct.pack_into(">H", buf, p, n)
    p += 2
    for idx in indexes:
        struct.pack_into(">H", buf, p, idx)
        p += 2
    buf[p : p + len(packet_digest)] = packet_digest
    p += len(packet_digest)
    buf[p : p + len(data_digest)] = data_digest
    p += len(data_digest)
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
        self.data = data
        self.block_size = block_size
        self.block_count = math.ceil(len(data) / block_size)
        self._random = RandomDegree(self.block_count, failure_probability)
        self._max_bpp = max_blocks_per_packet
        self._blocks: list[bytes | None] = [None] * self.block_count
        self._data_digest = sha256_multihash(data)

    def _get_block(self, index: int) -> bytes:
        blk = self._blocks[index]
        if blk is not None:
            return blk
        offset = index * self.block_size
        chunk = self.data[offset : offset + self.block_size]
        if len(chunk) < self.block_size:
            chunk = chunk + b"\x00" * (self.block_size - len(chunk))
        self._blocks[index] = chunk
        return chunk

    def next_packet(self) -> bytes:
        degree = max(1, min(self._random.next(), self._max_bpp, self.block_count))
        indexes = sorted(random.sample(range(self.block_count), degree))
        blocks = [self._get_block(i) for i in indexes]
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
    if (
        envelope_size / len(payload) > MIN_COMPRESS_RATIO
        or len(payload) - envelope_size < MIN_COMPRESS_SAVED_BYTES
    ):
        return payload

    return COMPRESS_MAGIC + bytes([0x01]) + struct.pack(">I", len(payload)) + compressed


# ─── Payload builders ────────────────────────────────────────────────────────

def auto_block_size(n: int) -> int:
    if n <= 50:
        return 50
    if n <= 600:
        return n
    if n <= 1_200:
        return math.ceil(n / 2)
    if n <= 5_000:
        return 400
    if n <= 20_000:
        return 500
    if n <= 100_000:
        return 600
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
    if n < 1024:
        return f"{n} B"
    if n < 1048576:
        return f"{n / 1024:.1f} KB"
    return f"{n / 1048576:.1f} MB"


# ─── Worker process helpers ──────────────────────────────────────────────────

def _worker_init() -> None:
    import segno  # noqa: F401


def _render_worker(packet: bytes) -> tuple[bytes, int]:
    """Encode packet as a QR symbol and return the raw module bits.

    Returns:
      (flat_bytes, native) where flat_bytes is native*native uint8 values
      (1 = dark, 0 = light) and native is the matrix side-length.

    Keeping only the compact matrix in the return value reduces IPC payload
    by ~100–150× compared with shipping a full scaled RGB frame across the
    process boundary.  All numpy scaling/colouring happens in the main
    process where it adds negligible latency.
    """
    import segno

    qr = segno.make_qr(packet, error="l")
    matrix = qr.matrix
    native = len(matrix)
    flat = (np.array(matrix, dtype=np.uint8) & 1).tobytes()  # 1=dark, 0=light
    return flat, native


# ─── Display window ───────────────────────────────────────────────────────────

class QRDisplay:
    """Animated QR display using pygame and raw RGB buffers."""

    _WORKERS = max(2, (os.cpu_count() or 2) - 1)
    _PREFETCH = _WORKERS * 3

    def __init__(
        self,
        encoder: Encoder,
        fps: int,
        label: str,
    ):
        try:
            import pygame
        except ImportError:
            sys.exit("Missing dependency. Install with: pip install pygame")

        self.pygame = pygame
        self._encoder = encoder
        self._fps = fps
        self._frame_interval = 1.0 / fps
        self._label = label
        self._n = 0
        self._running = True
        self._last_present = 0.0
        self._latest_frame: tuple[bytes, int] | None = None
        self._futures: deque = deque()
        self._sem = threading.BoundedSemaphore(self._PREFETCH)
        self._pool = ProcessPoolExecutor(
            max_workers=self._WORKERS,
            initializer=_worker_init,
        )

        pygame.init()
        pygame.display.set_caption("QRAM Encoder")
        self.screen = pygame.display.set_mode((QR_WIDTH, QR_WIDTH + 36))
        self.font = pygame.font.SysFont("Consolas", 16)
        self.clock = pygame.time.Clock()

        self._thread = threading.Thread(target=self._feeder_loop, daemon=True)
        self._thread.start()

        try:
            self._mainloop()
        finally:
            self._running = False
            self._drain_and_shutdown()
            pygame.quit()

    def _feeder_loop(self) -> None:
        for pkt in self._encoder:
            if not self._running:
                break
            if not self._sem.acquire(timeout=0.05):
                continue
            if not self._running:
                self._sem.release()
                break
            fut = self._pool.submit(_render_worker, pkt)
            self._futures.append(fut)

    def _pull_ready_frames(self) -> None:
        if self._futures and self._futures[0].done():
            fut = self._futures.popleft()
            self._sem.release()
            try:
                self._latest_frame = fut.result()
            except Exception as exc:
                print(f"Render error: {exc}", file=sys.stderr)

    def _draw(self) -> None:
        pygame = self.pygame
        self.screen.fill((20, 20, 20))

        if self._latest_frame is not None:
            flat_bytes, native = self._latest_frame
            # Reconstruct the module grid and scale it to screen size.
            # All numpy ops are fast; the heavy work (segno.make_qr) stayed
            # in the worker.  Doing this here instead of in the worker cuts
            # the IPC payload from ~367 KB of RGB bytes down to ~native²
            # bytes (a few KB), which is the main win from this refactor.
            modules = np.frombuffer(flat_bytes, dtype=np.uint8).reshape(native, native)
            native_with_border = native + 2 * QR_BORDER
            scale = max(1, QR_WIDTH // native_with_border)
            pixels = np.where(modules, np.uint8(0), np.uint8(255))
            pixels = np.pad(pixels, QR_BORDER, constant_values=255)
            pixels = np.repeat(np.repeat(pixels, scale, axis=0), scale, axis=1)
            h, w = pixels.shape
            rgb = np.empty((h, w, 3), dtype=np.uint8)
            rgb[...] = pixels[:, :, np.newaxis]  # broadcast into all 3 channels at once
            surf = pygame.image.frombuffer(rgb.tobytes(), (w, h), "RGB")
            x = (QR_WIDTH - w) // 2
            y = max(0, (QR_WIDTH - h) // 2)
            self.screen.blit(surf, (x, y))

        stats = self.font.render(
            f"{self._label} | packet #{self._n}",
            True,
            (220, 220, 220),
        )
        self.screen.blit(stats, (8, QR_WIDTH + 8))
        pygame.display.flip()

    def _mainloop(self) -> None:
        pygame = self.pygame
        while self._running:
            for event in pygame.event.get():
                if event.type == pygame.QUIT:
                    self._running = False
                    break
                if event.type == pygame.KEYDOWN and event.key in (pygame.K_ESCAPE, pygame.K_q):
                    self._running = False
                    break

            self._pull_ready_frames()

            now = time.perf_counter()
            if self._latest_frame is not None and (now - self._last_present) >= self._frame_interval:
                self._n += 1
                self._last_present = now
                self._draw()

            self.clock.tick(240)

    def _drain_and_shutdown(self) -> None:
        self._running = False
        while self._futures:
            fut = self._futures.popleft()
            fut.cancel()
        self._pool.shutdown(wait=False, cancel_futures=True)


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
    p_text.add_argument(
        "--block-size",
        type=int,
        default=0,
        help="Block size in bytes (default: auto)",
    )

    p_file = sub.add_parser("file", help="Encode a file")
    p_file.add_argument("path", type=Path, help="File to encode")
    p_file.add_argument("--fps", type=int, default=DEFAULT_FPS)
    p_file.add_argument(
        "--block-size",
        type=int,
        default=0,
        help="Block size in bytes (default: auto)",
    )

    args = parser.parse_args()
    fps = max(MIN_FPS, min(MAX_FPS, args.fps))

    if args.mode == "text":
        payload = build_text_payload(args.content)
        label = f"text {format_bytes(len(payload))}"
    else:
        payload = build_file_payload(args.path)
        label = f"file: {args.path.name} {format_bytes(len(payload))}"

    send_data = maybe_compress(payload)
    if send_data is not payload:
        pct = (1 - len(send_data) / len(payload)) * 100
        print(
            f"Compressed: {format_bytes(len(payload))} → "
            f"{format_bytes(len(send_data))} (−{pct:.0f}%)"
        )
    else:
        print(f"Data: {format_bytes(len(send_data))}")

    block_size = args.block_size
    if block_size <= 0:
        block_size = auto_block_size(len(send_data))
    block_size = max(MIN_BLOCK_SIZE, min(MAX_BLOCK_SIZE, block_size))

    block_count = math.ceil(len(send_data) / block_size)
    print(f"Block size: {block_size} | Blocks: {block_count} | FPS: {fps}")
    print(f"Workers: {QRDisplay._WORKERS} | Prefetch: {QRDisplay._PREFETCH}")

    encoder = Encoder(send_data, block_size)
    QRDisplay(encoder, fps, f"{label} | {block_count} blocks | {fps} fps")


if __name__ == "__main__":
    main()
