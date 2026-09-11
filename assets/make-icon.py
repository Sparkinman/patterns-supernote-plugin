#!/usr/bin/env python3
"""
Draw the plugin icon: a box with a grid of dots in it.

Checked in rather than only the PNG, because a 48x48 icon is unreadable as a
binary diff and nobody can tell what changed. Run it to regenerate:

    python3 assets/make-icon.py

Deliberately no Pillow. This writes the PNG by hand so the script runs on a
machine with nothing installed, which is the only way a generated asset stays
regenerable years later.

Black on transparent, because the launcher and the plugin list are white on
one panel and may not be on the next.
"""

import struct
import zlib

SIZE = 48
BLACK = (0, 0, 0, 255)
CLEAR = (0, 0, 0, 0)

# The box. A 2px rule inset far enough that the corners are not clipped when
# the launcher rounds them off.
INSET = 5
STROKE = 2

# A 3x3 lattice of 4px dots. Three across reads as "a grid" at 48 pixels; four
# across turns to mush, which is the whole problem with icon design at this
# size.
DOTS = 3
DOT = 4


def blank():
    return [[CLEAR for _ in range(SIZE)] for _ in range(SIZE)]


def fill(px, x0, y0, x1, y1, colour=BLACK):
    """Inclusive of x0/y0, exclusive of x1/y1, and clipped to the canvas."""
    for y in range(max(0, y0), min(SIZE, y1)):
        for x in range(max(0, x0), min(SIZE, x1)):
            px[y][x] = colour


def draw():
    px = blank()
    lo, hi = INSET, SIZE - INSET

    # The box, drawn as four bars so the corners meet squarely.
    fill(px, lo, lo, hi, lo + STROKE)              # top
    fill(px, lo, hi - STROKE, hi, hi)              # bottom
    fill(px, lo, lo, lo + STROKE, hi)              # left
    fill(px, hi - STROKE, lo, hi, hi)              # right

    # The dots, spaced the way the plugin itself spaces them: evenly, with the
    # remainder split between the two margins rather than left down one side.
    span = (hi - STROKE) - (lo + STROKE)
    step = span / (DOTS + 1)
    for row in range(DOTS):
        for col in range(DOTS):
            cx = lo + STROKE + step * (col + 1)
            cy = lo + STROKE + step * (row + 1)
            x = int(round(cx - DOT / 2))
            y = int(round(cy - DOT / 2))
            fill(px, x, y, x + DOT, y + DOT)

    return px


def write_png(px, path):
    raw = b"".join(
        b"\x00" + b"".join(struct.pack("4B", *px[y][x]) for x in range(SIZE))
        for y in range(SIZE)
    )

    def chunk(kind, data):
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", SIZE, SIZE, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    with open(path, "wb") as fh:
        fh.write(png)
    return len(png)


if __name__ == "__main__":
    size = write_png(draw(), "assets/icon.png")
    print(f"assets/icon.png written, {size} bytes")
