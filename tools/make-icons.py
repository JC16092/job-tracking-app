#!/usr/bin/env python3
"""Draws the app icon and writes it into public/:

    icon.svg                the drawing itself
    icon-512.png            512 x 512
    icon-192.png            192 x 192
    apple-touch-icon.png    180 x 180, the one the iPhone Home Screen uses

Run it from the project folder (it needs nothing but the Python that is already on the Mac):

    python3 tools/make-icons.py

The mark: the family block (a flat colour square with a black edge, as on Hours) in this app's
violet, with a tally of five on it: four cream strokes and a yellow one across.

The drawing is described once, in the numbers below. The SVG is written from those numbers and
the PNGs are painted from the same numbers, so the four files cannot drift apart. To change
the icon, change the numbers and run this again. The PNGs have no transparency (plain RGB),
which is what the iPhone wants.
"""

import math
import struct
import sys
import zlib
from pathlib import Path

# ── the drawing, on a 512 x 512 board ───────────────────────────────────────────

GROUND = "#F6F1FF"   # the app's background
VIOLET = "#9B5DE5"   # the app's lead colour
EDGE = "#111111"
CREAM = "#FFF8E7"
YELLOW = "#FFB800"

BOARD = 512
BLOCK = (56, 56, 400, 400)            # x, y, width, height: the same block as the Hours icon
BLOCK_EDGE = 26                       # 26 of 512 is the family's 3px edge at Home Screen size

STICKS_X = (151, 221, 291, 361)       # four upright strokes …
STICK_TOP, STICK_BOTTOM = 166, 346
SLASH = (110, 334, 402, 178)          # … and the fifth across them: x1, y1, x2, y2
STROKE_OUTER = 52                     # each stroke is drawn twice: wide in black,
STROKE_INNER = 24                     # then narrow in colour, which leaves a black outline

PNGS = (("icon-512.png", 512), ("icon-192.png", 192), ("apple-touch-icon.png", 180))


# ── as SVG ──────────────────────────────────────────────────────────────────────

def svg():
    x, y, w, h = BLOCK
    sticks = "".join(f"M{sx} {STICK_TOP}V{STICK_BOTTOM}" for sx in STICKS_X)
    slash = "M{} {}L{} {}".format(*SLASH)

    def stroke(d, colour, width):
        return f'  <path d="{d}" fill="none" stroke="{colour}" stroke-width="{width}" stroke-linecap="round"/>'

    return "\n".join([
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {BOARD} {BOARD}">',
        f'  <rect width="{BOARD}" height="{BOARD}" fill="{GROUND}"/>',
        f'  <rect x="{x}" y="{y}" width="{w}" height="{h}" fill="{VIOLET}" stroke="{EDGE}" stroke-width="{BLOCK_EDGE}"/>',
        stroke(sticks, EDGE, STROKE_OUTER),
        stroke(sticks, CREAM, STROKE_INNER),
        stroke(slash, EDGE, STROKE_OUTER),
        stroke(slash, YELLOW, STROKE_INNER),
        "</svg>",
        "",
    ])


# ── as pixels ───────────────────────────────────────────────────────────────────
# Each shape is a function giving the distance from a point to the shape's edge (negative
# inside), plus the box it fits in. Painting uses that distance to soften the edge by one pixel.

def box(x0, y0, x1, y1):
    def distance(x, y):
        dx = max(x0 - x, x - x1)
        dy = max(y0 - y, y - y1)
        return math.hypot(dx, dy) if dx > 0 and dy > 0 else max(dx, dy)
    return distance, (x0, y0, x1, y1)


def pill(x1, y1, x2, y2, width):
    """A straight stroke with round ends."""
    vx, vy = x2 - x1, y2 - y1
    length2 = vx * vx + vy * vy
    half = width / 2

    def distance(x, y):
        t = ((x - x1) * vx + (y - y1) * vy) / length2
        t = 0 if t < 0 else 1 if t > 1 else t
        return math.hypot(x - (x1 + t * vx), y - (y1 + t * vy)) - half
    return distance, (min(x1, x2) - half, min(y1, y2) - half, max(x1, x2) + half, max(y1, y2) + half)


def shapes():
    """The same drawing as svg(), back to front."""
    x, y, w, h = BLOCK
    e = BLOCK_EDGE / 2
    out = [
        (box(0, 0, BOARD, BOARD), GROUND),
        (box(x - e, y - e, x + w + e, y + h + e), EDGE),
        (box(x + e, y + e, x + w - e, y + h - e), VIOLET),
    ]
    for width, colour in ((STROKE_OUTER, EDGE), (STROKE_INNER, CREAM)):
        out += [(pill(sx, STICK_TOP, sx, STICK_BOTTOM, width), colour) for sx in STICKS_X]
    out += [(pill(*SLASH, STROKE_OUTER), EDGE), (pill(*SLASH, STROKE_INNER), YELLOW)]
    return out


def rgb(colour):
    return tuple(int(colour[i:i + 2], 16) for i in (1, 3, 5))


def paint(size):
    """The drawing at size x size pixels, as RGB bytes."""
    scale = size / BOARD
    pixels = [0.0] * (size * size * 3)
    for (distance, (bx0, by0, bx1, by1)), colour in shapes():
        r, g, b = rgb(colour)
        px0 = max(0, math.floor(bx0 * scale) - 1)
        py0 = max(0, math.floor(by0 * scale) - 1)
        px1 = min(size, math.ceil(bx1 * scale) + 1)
        py1 = min(size, math.ceil(by1 * scale) + 1)
        for py in range(py0, py1):
            y = (py + 0.5) / scale
            row = py * size * 3
            for px in range(px0, px1):
                cover = 0.5 - distance((px + 0.5) / scale, y) * scale     # 1 = fully inside, 0 = outside
                if cover <= 0:
                    continue
                i = row + px * 3
                if cover >= 1:
                    pixels[i], pixels[i + 1], pixels[i + 2] = r, g, b
                else:
                    pixels[i] += (r - pixels[i]) * cover
                    pixels[i + 1] += (g - pixels[i + 1]) * cover
                    pixels[i + 2] += (b - pixels[i + 2]) * cover
    return bytes(min(255, max(0, int(value + 0.5))) for value in pixels)


def png(size, pixels):
    """An 8-bit RGB PNG with no alpha channel."""
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    row = size * 3
    lines = b"".join(b"\x00" + pixels[y * row:(y + 1) * row] for y in range(size))
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
            + chunk(b"sRGB", b"\x00")
            + chunk(b"IDAT", zlib.compress(lines, 9))
            + chunk(b"IEND", b""))


def main():
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent / "public"
    out.mkdir(parents=True, exist_ok=True)
    (out / "icon.svg").write_text(svg(), encoding="utf-8")
    print(f"wrote {out / 'icon.svg'}")
    for name, size in PNGS:
        (out / name).write_bytes(png(size, paint(size)))
        print(f"wrote {out / name}  ({size} x {size})")


if __name__ == "__main__":
    main()
