#!/usr/bin/env python3
from PIL import Image
im = Image.open("capture/window.png").convert("RGB"); px = im.load(); W,H=im.size; S=2

def near(c, t, tol): return all(abs(c[i]-t[i])<=tol for i in range(3))

# 1. selected-row highlight (#3e3e3e ~62) bbox in left region
pts=[(x,y) for x in range(0,540) for y in range(260,346) if near(px[x,y],(62,62,63),6)]
if pts:
    xs=[p[0]for p in pts]; ys=[p[1]for p in pts]
    print(f"Starred highlight: x {min(xs)//S}..{max(xs)//S}(w{(max(xs)-min(xs))//S+1}) y {min(ys)//S}..{max(ys)//S}(h{(max(ys)-min(ys))//S+1})")

# 2. free-trial card: find border (pixels brighter than bg) in region x[8,330] y[740,890]
bg=(50,50,51)
pts=[(x,y) for x in range(8*S,330*S) for y in range(740*S,890*S) if max(abs(px[x,y][0]-bg[0]),abs(px[x,y][1]-bg[1]),abs(px[x,y][2]-bg[2]))>10]
if pts:
    xs=[p[0]for p in pts]; ys=[p[1]for p in pts]
    print(f"Card content+border: x {min(xs)//S}..{max(xs)//S}(w{(max(xs)-min(xs))//S+1}) y {min(ys)//S}..{max(ys)//S}(h{(max(ys)-min(ys))//S+1})")
    print("  card border sample px(20, 815pt):", px[20*S,815*S], " top-edge px(120,750pt):", px[120*S,750*S])

# 3. dominant text colors: average fg pixels (diff from bg>60) in given row bands
def textcol(name, ypt0,ypt1, xpt0,xpt1, bg):
    acc=[0,0,0]; n=0
    for x in range(xpt0*S,xpt1*S):
        for y in range(ypt0*S,ypt1*S):
            c=px[x,y]
            if max(abs(c[0]-bg[0]),abs(c[1]-bg[1]),abs(c[2]-bg[2]))>60:
                acc[0]+=c[0];acc[1]+=c[1];acc[2]+=c[2];n+=1
    if n: print(f"  {name}: rgb({acc[0]//n},{acc[1]//n},{acc[2]//n})  '#{acc[0]//n:02x}{acc[1]//n:02x}{acc[2]//n:02x}'  n={n}")
print("text colors:")
textcol("nav 'Your documents'", 270,279, 28,160, (50,50,51))
textcol("selected 'Starred'",   146,155, 28,120, (62,62,63))
textcol("hdr 'Files'",          234,242, 28,80,  (50,50,51))
textcol("'No starred files'",   399,420, 720,940,(50,50,51))
textcol("subtext",              442,454, 740,920,(50,50,51))
textcol("'Add file storage'",   573,583, 28,160, (50,50,51))
textcol("Sign in",              13,27, 1368,1416,(29,29,29))
print("DONE")
