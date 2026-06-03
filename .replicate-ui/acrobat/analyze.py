#!/usr/bin/env python3
"""Structural analysis of the Acrobat Home screenshot (no AX available).
All measurements printed in POINTS (px/2, scale=2)."""
from PIL import Image

im = Image.open("capture/window.png").convert("RGB")
W, H = im.size
px = im.load()
S = 2  # retina scale


def runs(seq, tol=8):
    """Collapse a sequence of (pos,color) into runs of ~constant color."""
    out = []
    start = 0
    cur = seq[0][1]
    for i in range(1, len(seq)):
        c = seq[i][1]
        if max(abs(c[0]-cur[0]), abs(c[1]-cur[1]), abs(c[2]-cur[2])) > tol:
            out.append((seq[start][0], seq[i-1][0], cur))
            start = i
            cur = c
    out.append((seq[start][0], seq[-1][0], cur))
    return out


def vprofile(xpt, y0=0, y1=None):
    x = xpt*S
    y1 = (y1*S) if y1 else H
    seq = [(y//S, px[x, y]) for y in range(0, y1, 1)]
    print(f"\n--- vertical profile @ x={xpt}pt (col {x}px) ---")
    for a, b, c in runs(seq, 10):
        if b-a >= 1:
            print(f"  y {a:>4}..{b:<4}pt  h={b-a+1:<4} {('#%02x%02x%02x'%c)} {c}")


def hprofile(ypt, x0=0, x1=None):
    y = ypt*S
    x1 = (x1*S) if x1 else W
    seq = [(x//S, px[x, y]) for x in range(0, x1, 1)]
    print(f"\n--- horizontal profile @ y={ypt}pt (row {y}px) ---")
    for a, b, c in runs(seq, 10):
        if b-a >= 2:
            print(f"  x {a:>4}..{b:<4}pt  w={b-a+1:<4} {('#%02x%02x%02x'%c)} {c}")


# Bar heights / dividers down two columns
vprofile(700, 0, 130)     # right-of-center: header bars
vprofile(110, 0, 900)     # sidebar column: row backgrounds
# Sidebar/content edge + header element edges
hprofile(80, 0, 1440)     # second header bar row
hprofile(400, 0, 1440)    # content row (sidebar divider?)
hprofile(26, 0, 1440)     # top strip row
print("\nDONE")
