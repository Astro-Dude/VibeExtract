#!/usr/bin/env python3
from PIL import Image
im = Image.open("capture/window.png").convert("RGB"); px = im.load(); W,H=im.size; S=2

def bluefill(name, xpt0,xpt1, ypt0,ypt1):
    acc=[0,0,0]; n=0
    for x in range(xpt0*S,xpt1*S):
        for y in range(ypt0*S,ypt1*S):
            r,g,b=px[x,y]
            if b>r+15 and b>90:   # blue-ish fill, exclude white text & dark bg
                acc[0]+=r;acc[1]+=g;acc[2]+=b;n+=1
    if n: print(f"{name}: #{acc[0]//n:02x}{acc[1]//n:02x}{acc[2]//n:02x} rgb({acc[0]//n},{acc[1]//n},{acc[2]//n}) n={n}")
    else: print(f"{name}: no blue")

print("--- button blue fills ---")
bluefill("FreeTrial header pill", 1332,1419, 43,73)
bluefill("Star from Recent",       757,902, 479,510)
bluefill("Card Free Trial btn",     20,210, 832,863)

# refine highlight (x<230)
def near(c,t,tol): return all(abs(c[i]-t[i])<=tol for i in range(3))
pts=[(x,y) for x in range(0,230*S) for y in range(128*S,170*S) if near(px[x,y],(62,62,63),5)]
xs=[p[0]for p in pts]; ys=[p[1]for p in pts]
print(f"\nhighlight refined: x {min(xs)//S}..{max(xs)//S}(w{(max(xs)-min(xs))//S+1}) y {min(ys)//S}..{max(ys)//S}(h{(max(ys)-min(ys))//S+1})")

# card border: scan column at card top to find border color (first non-bg from outside)
print("card top border row y=748pt colors x10..210:", set(('#%02x%02x%02x'%px[x*S,748*S]) for x in range(60,200,20)))
print("card left border col x=14pt colors y750..875:", set(('#%02x%02x%02x'%px[14*S,y*S]) for y in range(760,870,20)))
print("card sample inside (120,800pt):", '#%02x%02x%02x'%px[120*S,800*S])

# --- slice sprites (tight bbox + 1pt pad), place at given pt top-left ---
sprites = {
 "home":      (14, 9, 21, 18),
 "help":      (1267,10, 19, 18),
 "bell":      (1300,10, 18, 19),
 "waffle":    (1333, 8, 19, 19),
 "adobe":     (15, 46, 26, 26),
 "search":    (1238,50, 18, 18),
 "view_list": (1340,115,17, 16),
 "view_grid": (1383,115,16, 16),
 "illus":     (732,212,196,133),
}
import os
os.makedirs("sprites", exist_ok=True)
print("\n--- sprites (pt x,y,w,h) ---")
for nm,(x,y,w,h) in sprites.items():
    crop=im.crop((x*S, y*S, (x+w)*S, (y+h)*S))
    crop.save(f"sprites/{nm}.png")
    print(f"  {nm}: ({x},{y},{w},{h})  -> sprites/{nm}.png {crop.size}")

# save a card crop to inspect border
im.crop((8*S,744*S,300*S,888*S)).save("sprites/_card_crop.png")
print("DONE")
