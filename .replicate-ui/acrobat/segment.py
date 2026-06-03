#!/usr/bin/env python3
"""Segment toolbar bands into individual element bboxes by foreground column-runs.
Coords in POINTS (px/2)."""
from PIL import Image

im = Image.open("capture/window.png").convert("RGB")
W, H = im.size
px = im.load()
S = 2


def seg(name, ypt0, ypt1, xpt0, xpt1, bg, thr=24, gap=5):
    x0, x1, y0, y1 = xpt0*S, xpt1*S, ypt0*S, ypt1*S
    def fg(x, y):
        c = px[x, y]
        return max(abs(c[0]-bg[0]), abs(c[1]-bg[1]), abs(c[2]-bg[2])) > thr
    cols = [any(fg(x, y) for y in range(y0, y1)) for x in range(x0, x1)]
    runs = []
    i, n = 0, len(cols)
    while i < n:
        if cols[i]:
            j = i; lastfg = i
            while j < n and (cols[j] or (j-lastfg) <= gap*S):
                if cols[j]:
                    lastfg = j
                j += 1
            runs.append((x0+i, x0+lastfg))   # px coords (fixed)
            i = lastfg+1
        else:
            i += 1
    print(f"\n=== {name}  y[{ypt0},{ypt1}] x[{xpt0},{xpt1}] bg={bg} ===")
    for a, b in runs:
        ys = [y for x in range(a, b+1) for y in range(y0, y1) if fg(x, y)]
        if not ys:
            continue
        ymin, ymax = min(ys), max(ys)
        print(f"  x {a//S:>4}..{b//S:<4} (w={(b-a)//S+1:>3})  y {ymin//S:>3}..{ymax//S:<3} (h={(ymax-ymin)//S+1})")


def bbox(name, ypt0, ypt1, xpt0, xpt1, bg, thr=22):
    x0, x1, y0, y1 = xpt0*S, xpt1*S, ypt0*S, ypt1*S
    def fg(x, y):
        c = px[x, y]
        return max(abs(c[0]-bg[0]), abs(c[1]-bg[1]), abs(c[2]-bg[2])) > thr
    pts = [(x, y) for x in range(x0, x1) for y in range(y0, y1) if fg(x, y)]
    if not pts:
        print(f"\n=== {name}: NONE ==="); return
    xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
    print(f"\n=== {name} bbox: x {min(xs)//S}..{max(xs)//S} (w={(max(xs)-min(xs))//S+1})  y {min(ys)//S}..{max(ys)//S} (h={(max(ys)-min(ys))//S+1})  npix={len(pts)} ===")


seg("topbar_left",   6, 30,    0, 200, (29, 29, 29))
seg("topbar_right",  6, 30, 1255,1432, (29, 29, 29))
seg("header_left",  40, 80,   10, 320, (50, 50, 51))
seg("header_right", 42, 74, 1180,1440, (50, 50, 51))
seg("content_head",150,188,  180,1440, (50, 50, 51))   # Starred heading + view toggles
bbox("illustration",250,500, 600,1060, (50, 50, 51))
seg("emptystate_text",520,720, 700,1000,(50,50,51))     # 'No starred files yet' + sub + button (y-runs)
print("\nDONE")
