#!/usr/bin/env python3
from PIL import Image
im = Image.open("capture/window.png").convert("RGB"); px = im.load(); W, H = im.size; S = 2

def fg_at(c, bg, thr): return max(abs(c[0]-bg[0]), abs(c[1]-bg[1]), abs(c[2]-bg[2])) > thr

def seg(name, ypt0, ypt1, xpt0, xpt1, bg, thr=24, gap=6):
    x0,x1,y0,y1 = xpt0*S,xpt1*S,ypt0*S,ypt1*S
    cols=[any(fg_at(px[x,y],bg,thr) for y in range(y0,y1)) for x in range(x0,x1)]
    runs=[]; i=0; n=len(cols)
    while i<n:
        if cols[i]:
            j=i; last=i
            while j<n and (cols[j] or (j-last)<=gap*S):
                if cols[j]: last=j
                j+=1
            runs.append((x0+i,x0+last)); i=last+1
        else: i+=1
    print(f"\n=== {name} y[{ypt0},{ypt1}] x[{xpt0},{xpt1}] ===")
    for a,b in runs:
        ys=[y for x in range(a,b+1) for y in range(y0,y1) if fg_at(px[x,y],bg,thr)]
        if not ys: continue
        print(f"  x {a//S:>4}..{b//S:<4}(w{(b-a)//S+1:>3})  y {min(ys)//S}..{max(ys)//S}(h{(max(ys)-min(ys))//S+1})")

def bbox(name, ypt0, ypt1, xpt0, xpt1, bg, thr=24):
    x0,x1,y0,y1=xpt0*S,xpt1*S,ypt0*S,ypt1*S
    pts=[(x,y) for x in range(x0,x1) for y in range(y0,y1) if fg_at(px[x,y],bg,thr)]
    if not pts: print(f"\n=== {name}: NONE ==="); return
    xs=[p[0] for p in pts]; ys=[p[1] for p in pts]
    print(f"\n=== {name} bbox x {min(xs)//S}..{max(xs)//S}(w{(max(xs)-min(xs))//S+1}) y {min(ys)//S}..{max(ys)//S}(h{(max(ys)-min(ys))//S+1}) cx={((min(xs)+max(xs))//2)//S} ===")

# sidebar rows (text is light on dark; thr high to catch on both #323/#3e3e)
print("--- SIDEBAR row-bands (x16..210) ---")
bg=(50,50,51)
band=None
for y in range(166,1800):
    c=sum(1 for x in range(32,420,2) if fg_at(px[x,y],bg,40))
    if c>3:
        if band is None: band=[y,y]
        else: band[1]=y
    else:
        if band and (band[1]-band[0])//S+1>=4:
            seg_y0,seg_y1=band
            xs=[x for x in range(32,440) for yy in range(seg_y0,seg_y1+1) if fg_at(px[x,yy],bg,40)]
            print(f"  y {seg_y0//S:>3}..{seg_y1//S:<3}(h{(seg_y1-seg_y0)//S+1:>2})  x {min(xs)//S}..{max(xs)//S}")
        band=None

seg("content_head", 110,134, 180,1440, (50,50,51))
bbox("illustration", 205,360, 690,970, (50,50,51), thr=20)
seg("no_starred", 393,424, 400,1280, (50,50,51))
seg("subtext", 438,456, 400,1280, (50,50,51))
bbox("star_btn", 474,515, 600,1120, (50,50,51), thr=14)
print("\nDONE")
