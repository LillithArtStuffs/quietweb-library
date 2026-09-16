"""Regenerate the Quietweb PWA icons.

Pure standard library: no Pillow, no build step. Run it after changing the
brand colours, then commit the PNGs it writes into ``web/icons/``.

    python scripts/make-icons.py
"""

from pathlib import Path
import math
import struct
import zlib

ICON_DIR = Path(__file__).resolve().parent.parent / "web" / "icons"
BACKGROUND = (0x17, 0x3D, 0x48)
MARK = (0xD9, 0x60, 0x45)
SIZES = (192, 512)


def rounded_box(x, y, half, radius):
    """Signed distance to a rounded square centred on the origin."""
    dx = abs(x) - half + radius
    dy = abs(y) - half + radius
    outside = math.hypot(max(dx, 0.0), max(dy, 0.0))
    return outside + min(max(dx, dy), 0.0) - radius


def ring(x, y, cx, cy, radius, thickness):
    return abs(math.hypot(x - cx, y - cy) - radius) - thickness / 2


def capsule(x, y, ax, ay, bx, by, thickness):
    px, py = x - ax, y - ay
    bax, bay = bx - ax, by - ay
    span = bax * bax + bay * bay
    t = 0.0 if span == 0 else min(max((px * bax + py * bay) / span, 0.0), 1.0)
    return math.hypot(px - bax * t, py - bay * t) - thickness / 2


def coverage(distance):
    """Convert a signed distance into an anti-aliased 0..1 coverage value."""
    return min(max(0.5 - distance, 0.0), 1.0)


def blend(base, top, alpha):
    return tuple(round(b + (t - b) * alpha) for b, t in zip(base, top))


def render(size):
    scale = size / 512
    half = 256 * scale
    rows = []
    for row in range(size):
        pixels = bytearray()
        y = row + 0.5
        for column in range(size):
            x = column + 0.5
            plate = coverage(rounded_box(x - half, y - half, half, 104 * scale))
            mark = max(
                coverage(ring(x, y, 250 * scale, 236 * scale, 148 * scale, 52 * scale)),
                coverage(capsule(x, y, 296 * scale, 300 * scale, 386 * scale, 396 * scale, 50 * scale)),
            )
            colour = blend(BACKGROUND, MARK, mark)
            pixels += bytes(colour) + bytes((round(plate * 255),))
        rows.append(bytes(pixels))
    return rows


def write_png(path, size, rows):
    raw = b"".join(b"\x00" + row for row in rows)

    def chunk(kind, payload):
        body = kind + payload
        return struct.pack(">I", len(payload)) + body + struct.pack(">I", zlib.crc32(body))

    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    path.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def main():
    ICON_DIR.mkdir(parents=True, exist_ok=True)
    for size in SIZES:
        target = ICON_DIR / f"quietweb-{size}.png"
        write_png(target, size, render(size))
        print(f"wrote {target.relative_to(ICON_DIR.parent.parent)} ({target.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
