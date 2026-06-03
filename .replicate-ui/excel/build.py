#!/usr/bin/env python3
# Excel-for-Mac replica generator — AX-driven, per-icon sprites, SEMANTIC markup,
# laid out as a NESTED HIERARCHY in NORMAL FLOW (flex/grid) — NOT a flat position:absolute
# canvas. Real landmark containers (titlebar / ribbon-tabs[role=tablist] / ribbon-body →
# section.group → rows·cols / formula-bar / grid / sheet-tabs / status-bar). Every control
# is a real role-driven element (../_shared/role-map.json) filled with its sliced sprite /
# text / input; placement is by flow MARGINS computed once from the measured AX bounds
# (a tiny recursive renderer turns each container's child x/y deltas into margin-left/top).
# `position:absolute` is reserved for the ONE genuine overlay: the A1 cell-selection box
# pinned inside the position:relative .cells grid. The cell grid stays a CSS-gradient block
# (Excel exposes no per-cell AX). ../_shared/interactive.css (inlined) = the button/input
# reset + hover/focus. Static clone (no JS). Slack build.mjs + Acrobat build.py are siblings.

from PIL import Image
import os, re, json, html as H

HERE = os.path.dirname(os.path.abspath(__file__))
CAP = os.path.join(HERE, "capture")
SPR = os.path.join(HERE, "assets", "sprites")
SHARED = os.path.join(HERE, "..", "_shared")
ROLE_MAP = json.load(open(os.path.join(SHARED, "role-map.json")))
INTERACTIVE_CSS = open(os.path.join(SHARED, "interactive.css")).read()
import sys as _sys; _sys.path.insert(0, SHARED)
import gridtext as G   # shared "grid labels -> real text" (detect range + OCR + repair)
meta = json.load(open(os.path.join(CAP, "meta.json")))
OX, OY = meta["window_origin"]
WW, WH = meta["window_size"]
SCALE = meta["scale"]
img = Image.open(os.path.join(CAP, "window.png")).convert("RGB")
IW, IH = img.size

for f in os.listdir(SPR) if os.path.isdir(SPR) else []:
    os.remove(os.path.join(SPR, f))
os.makedirs(SPR, exist_ok=True)

def rel(x, y): return x - OX, y - OY
def clampx(v): return max(0, min(IW, v))
def clampy(v): return max(0, min(IH, v))
def sample(rx, ry):
    p = img.getpixel((clampx(round(rx*SCALE)), clampy(round(ry*SCALE))))
    return "#%02x%02x%02x" % p
_seen = {}
def slug(name, region):
    base = re.sub(r'[^a-z0-9]+', '-', (region + "-" + name).lower()).strip('-') or "x"
    n = _seen.get(base, 0) + 1; _seen[base] = n
    return base if n == 1 else f"{base}-{n}"
def slice_sprite(name, region, sx, sy, w, h, pad=0):
    rx, ry = rel(sx, sy)
    box = (clampx(round((rx-pad)*SCALE)), clampy(round((ry-pad)*SCALE)),
           clampx(round((rx+w+pad)*SCALE)), clampy(round((ry+h+pad)*SCALE)))
    s = slug(name, region)
    img.crop(box).save(os.path.join(SPR, s + ".png"))
    return s

def detect_caret(sx, sy, w, h, gap_min=12, caret_max=30):
    """Auto-find a dropdown caret 'v' on a control's RIGHT edge (a small glyph set off by a
    background gap). Returns the split point in POINTS, or None for a single-glyph button."""
    rx, ry = sx - OX, sy - OY
    x0, y0 = clampx(round(rx*SCALE)), clampy(round(ry*SCALE))
    x1, y1 = clampx(round((rx+w)*SCALE)), clampy(round((ry+h)*SCALE))
    if x1-x0 < 16 or y1-y0 < 8: return None
    reg = img.crop((x0, y0, x1, y1)); px = reg.load(); W, Hh = reg.size
    bg = reg.getpixel((1, 1))
    fg = [sum(1 for cy in range(Hh) if abs(px[cx, cy][0]-bg[0]) + abs(px[cx, cy][1]-bg[1])
              + abs(px[cx, cy][2]-bg[2]) > 60) > 1 for cx in range(W)]
    r = W - 1
    while r >= 0 and not fg[r]: r -= 1
    if r < 0: return None
    cs = r
    while cs >= 0 and fg[cs]: cs -= 1
    g = cs
    while g >= 0 and not fg[g]: g -= 1
    caret_w, gap = r - cs, cs - g
    if caret_w <= caret_max and gap >= gap_min and any(fg[:g+1]) and cs > W * 0.45:
        return round((g + gap/2) / SCALE, 1)
    return None

def role_el(role):
    m = ROLE_MAP.get(role) or ROLE_MAP["_default"]
    return m["tag"], dict(m.get("attrs", {}))
def attrs_str(d):
    return "".join(f' {k}="{H.escape(str(v))}"' for k, v in d.items())
DEFAULT_ROLE = {"sprite": "AXButton", "text": "AXStaticText", "combo": "AXComboBox",
                "search": "search", "input": "AXTextArea", "slider": "AXSlider", "dotbtn": "AXButton"}

C_TOP   = sample(900, 50)
C_FORM  = sample(95, 150)
C_NBOX  = sample(40, 150)
C_COMBO = sample(200, 82)
C_SHEET = sample(500, 758)
C_STAT  = sample(700, 786)
TXT, TXT_DIM = "#e6e6e6", "#bdbdbd"
COLHDR_TOP, COLHDR_H, CELLS_TOP, RHW, CW, ROW1, RH, GRID_BOTTOM = 163, 25, 188, 22, 65, 15, 16, 746

# ---- leaf control = a real role-driven element filled with sprite/text/value (SIZE only) ----
def leaf(c, lead=""):
    s, w, h = c["s"], c["w"], c["h"]; name = c.get("name", ""); lbl = H.escape(name)
    role = c.get("role") or DEFAULT_ROLE.get(s, "AXButton")
    SX, SY = c["x"]+OX, c["y"]+OY
    if s == "dotbtn":
        return f'<button class="dot" aria-label="{lbl}" style="{lead}background:{c["color"]}"></button>'
    if s == "sprite":
        menu = role == "AXMenuButton"
        split = detect_caret(SX, SY, w, h) if (menu and h <= 40) else None
        if split is not None:                       # split: icon <button> + caret <button aria-haspopup>
            isl = slice_sprite(name, c["region"], SX, SY, split, h)
            csl = slice_sprite(name+" caret", c["region"], SX+split, SY, w-split, h)
            # wrap in an inline-flex span so the icon+caret stay side-by-side in ANY parent
            # (a bare pair would stack vertically inside a flex-column group like Cells/Editing)
            return (f'<span class="split" style="{lead}">'
                    f'<button class="iconbtn" aria-label="{lbl}" title="{lbl}" style="width:{split}px;height:{h}px">'
                    f'<img src="assets/sprites/{isl}.png" alt=""></button>'
                    f'<button class="iconbtn caretbtn" aria-haspopup="menu" aria-label="{lbl} menu" style="width:{w-split}px;height:{h}px">'
                    f'<img src="assets/sprites/{csl}.png" alt=""></button></span>')
        sl = slice_sprite(name, c["region"], SX, SY, w, h)
        tag, ra = role_el(role)                     # tall menu buttons keep the caret in the sprite (aria-haspopup)
        return (f'<{tag} class="iconbtn"{attrs_str(ra)} aria-label="{lbl}" title="{lbl}" style="{lead}width:{w}px;height:{h}px">'
                f'<img src="assets/sprites/{sl}.png" alt=""></{tag}>')
    if s == "text":
        just = {"center": "center", "left": "flex-start", "right": "flex-end"}[c.get("align", "left")]
        cls = c.get("cls", "")
        style = (f'{lead}width:{w}px;height:{h}px;justify-content:{just};'
                 f'font-size:{c.get("size",12)}px;color:{c.get("color",TXT)};line-height:1')
        if role == "tab":
            sel = "true" if (c.get("active") or c.get("sheettab")) else "false"
            extra = (" active" if c.get("active") else "") + (" sheettab" if c.get("sheettab") else "")
            return f'<button class="txt tab{extra} {cls}" role="tab" aria-selected="{sel}" aria-label="{lbl}" style="{style}">{lbl}</button>'
        if role == "AXButton":
            return f'<button class="txt {cls}" aria-label="{lbl}" style="{style}">{lbl}</button>'
        return f'<span class="txt {cls}" aria-label="{lbl}" style="{style}">{lbl}</span>'
    if s == "combo":
        bg = C_NBOX if c.get("nbox") else C_COMBO
        sl = slice_sprite(name+" caret", c["region"], SX+w-16, SY, 16, h)
        return (f'<div class="combo" role="combobox" tabindex="0" aria-label="{lbl}" style="{lead}width:{w}px;height:{h}px;background:{bg}">'
                f'<input class="cval" value="{H.escape(c.get("value",""))}" readonly aria-label="{lbl}">'
                f'<img class="caret" src="assets/sprites/{sl}.png" alt="" style="width:16px;height:{h}px"></div>')
    if s == "search":
        sl = slice_sprite(name+" mag", c["region"], SX, SY, 22, h)
        return (f'<div class="search" role="search" style="{lead}width:{w}px;height:{h}px">'
                f'<img class="mag" src="assets/sprites/{sl}.png" alt="" style="width:22px;height:{h}px">'
                f'<input class="sval" type="search" placeholder="{H.escape(name)}" aria-label="{lbl}"></div>')
    if s == "input":
        return f'<input class="finput" type="text" aria-label="{lbl}" style="{lead}width:{w}px;height:18px">'
    if s == "slider":
        sl = slice_sprite(name, c["region"], SX, SY, w, h)
        return (f'<div class="slider" role="slider" tabindex="0" aria-label="zoom" aria-valuemin="0" aria-valuemax="200" aria-valuenow="100" '
                f'style="{lead}width:{w}px;height:{h}px"><img src="assets/sprites/{sl}.png" alt="" style="width:100%;height:100%"></div>')
    return ""

# ---- nested-flow renderer: each container places children with flow MARGINS from x/y deltas ----
def ct(s, name, x, y, w, h, region="", **kw):
    d = {"s": s, "name": name, "x": x, "y": y, "w": w, "h": h, "region": region}; d.update(kw); return d
def Lf(c): return {"leaf": c}
def N(d, cls, kids, tag="div", attrs="", css="", box=None):
    return {"dir": d, "cls": cls, "kids": kids, "tag": tag, "attrs": attrs, "css": css, "box": box}
def bbox(n):
    if "leaf" in n:
        c = n["leaf"]; return (c["x"], c["y"], c["w"], c["h"])
    if n.get("box"): return n["box"]
    bs = [bbox(k) for k in n["kids"]]
    x = min(b[0] for b in bs); y = min(b[1] for b in bs)
    return (x, y, max(b[0]+b[2] for b in bs)-x, max(b[1]+b[3] for b in bs)-y)
def render(n, lead=""):
    if "leaf" in n: return leaf(n["leaf"], lead)
    X, Y, _, _ = n.get("box") or bbox(n)
    parts = []; pr, pb = X, Y
    for k in n["kids"]:
        bx, by, bw, bh = bbox(k)
        if n["dir"] == "row":
            ml, mt = bx-pr, by-Y; pr = bx+bw
        else:
            ml, mt = bx-X, by-pb; pb = by+bh
        m = (f"margin-left:{ml:.0f}px;" if ml else "") + (f"margin-top:{mt:.0f}px;" if mt else "")
        parts.append(render(k, m))
    base = "display:flex;align-items:flex-start;" + ("flex-direction:column;" if n["dir"] == "col" else "")
    return f'<{n["tag"]} class="{n["cls"]}"{n["attrs"]} style="{lead}{base}{n["css"]}">' + "".join(parts) + f'</{n["tag"]}>'

# ============================ control definitions (window-relative points) ===================
DOTS = [ct("dotbtn","Close",11,12,12,12,color="#ff5f57"), ct("dotbtn","Minimise",34,12,12,12,color="#febc2e"),
        ct("dotbtn","Zoom",57,12,12,12,color="#28c840")]
QAT = [ct("sprite",n,x,8,w,24,"qat",**({"role":"AXMenuButton"} if r else {})) for n,x,w,r in [
        ("Home",98,26,0),("Save as",125,26,0),("Save",152,26,0),("Send Workbook",179,26,0),("Print",206,26,0),
        ("Spelling",233,26,0),("Undo",260,39,1),("Sort A to Z",300,26,0),("Sort Z to A",327,26,0),
        ("New",354,26,0),("Repeat New from Template",381,26,0),("Customise Quick Access Toolbar",408,26,1)]]
TITLE  = ct("text","Book1",683,11,36,17,align="center",size=13,color=TXT_DIM,cls="tb-title")
SEARCH = ct("search","Search (Cmd + Ctrl + U)",1113,7,282,26,"qat")
TABS = [ct("text",n,x,33,w,26,"tab",role="tab",size=13.5,color=("#ffffff" if a else TXT_DIM),**({"active":True} if a else {}))
        for n,x,w,a in [("Home",-1,62,1),("Insert",59,63,0),("Draw",120,58,0),("Page Layout",176,104,0),
        ("Formulas",278,85,0),("Data",361,55,0),("Review",414,70,0),("View",482,56,0),("Acrobat",536,76,0)]]
SHARE = ct("sprite","Share",1302,35,91,26,"tab")

clip = N("row","group clip",[Lf(ct("sprite","Paste",9,65,50,74,"clip",role="AXMenuButton")),
    N("col","col",[Lf(ct("sprite","Cut",59,66,24,22,"clip")), Lf(ct("sprite","Copy",59,88,36,22,"clip",role="AXMenuButton")),
                   Lf(ct("sprite","Format",59,110,24,22,"clip",role="AXCheckBox"))])], tag="section")
font = N("col","group font",[
    N("row","r",[Lf(ct("combo","Font",114,70,143,26,"font",value="Aptos Narrow (Body)")), Lf(ct("combo","Font Size",257,70,56,26,"font",value="12")),
                 Lf(ct("sprite","Increase Font Size",313,70,26,26,"font")), Lf(ct("sprite","Decrease Font Size",339,70,26,26,"font"))]),
    N("row","r",[Lf(ct("sprite","Bold",114,102,26,26,"font",role="AXCheckBox")), Lf(ct("sprite","Italic",140,102,26,26,"font",role="AXCheckBox")),
                 Lf(ct("sprite","Underline",166,102,38,26,"font",role="AXMenuButton")), Lf(ct("sprite","Borders",219,102,38,26,"font",role="AXMenuButton")),
                 Lf(ct("sprite","Shading",272,102,38,26,"font",role="AXMenuButton")), Lf(ct("sprite","Font Colour",310,102,38,26,"font",role="AXMenuButton"))])], tag="section")
align = N("col","group align",[
    N("row","r",[Lf(ct("sprite","Align to Top",384,70,26,26,"align",role="AXCheckBox")), Lf(ct("sprite","Align to Middle",410,70,26,26,"align",role="AXCheckBox")),
                 Lf(ct("sprite","Align to Bottom",436,70,26,26,"align",role="AXCheckBox")), Lf(ct("sprite","Orientation",477,70,38,26,"align",role="AXMenuButton")),
                 Lf(ct("sprite","Wrap Text",544,70,38,26,"align",role="AXMenuButton"))]),
    N("row","r",[Lf(ct("sprite","Align to Left",384,102,26,26,"align",role="AXCheckBox")), Lf(ct("sprite","Centre",410,102,26,26,"align",role="AXCheckBox")),
                 Lf(ct("sprite","Align to Right",436,102,26,26,"align",role="AXCheckBox")), Lf(ct("sprite","Decrease Indent",477,102,26,26,"align")),
                 Lf(ct("sprite","Increase Indent",503,102,26,26,"align")), Lf(ct("sprite","Merge & Centre",544,102,38,26,"align",role="AXMenuButton"))])], tag="section")
num = N("col","group num",[
    N("row","r",[Lf(ct("combo","Number Format",601,70,157,26,"num",value="General"))]),
    N("row","r",[Lf(ct("sprite","Accounting Number Format",601,102,38,26,"num",role="AXMenuButton")), Lf(ct("sprite","Percentage Style",639,102,26,26,"num")),
                 Lf(ct("sprite","Comma Style",665,102,26,26,"num")), Lf(ct("sprite","Increase Decimal",706,102,26,26,"num")),
                 Lf(ct("sprite","Decrease Decimal",732,102,26,26,"num"))])], tag="section")
sty = N("row","group sty",[Lf(ct("sprite","Conditional Formatting",777,65,64,74,"sty",role="AXMenuButton")),
    Lf(ct("sprite","Format as Table",841,65,50,74,"sty",role="AXMenuButton")), Lf(ct("sprite","Cell Styles",891,65,50,74,"sty",role="AXMenuButton"))], tag="section")
cells = N("col","group cells",[Lf(ct("sprite","Insert",960,66,71,22,"cells",role="AXMenuButton")),
    Lf(ct("sprite","Delete",960,88,75,22,"cells",role="AXMenuButton")), Lf(ct("sprite","Format",960,110,78,22,"cells",role="AXMenuButton"))], tag="section")
edit = N("row","group edit",[
    N("col","col",[Lf(ct("sprite","Auto-sum",1057,66,36,22,"edit",role="AXMenuButton")), Lf(ct("sprite","Fill",1057,88,36,22,"edit",role="AXMenuButton")),
                   Lf(ct("sprite","Clear",1057,110,36,22,"edit",role="AXMenuButton"))]),
    Lf(ct("sprite","Sort & Filter",1093,65,50,74,"edit",role="AXMenuButton")), Lf(ct("sprite","Find & Select",1143,65,50,74,"edit",role="AXMenuButton"))], tag="section")
addin = N("row","group addin",[Lf(ct("sprite","Add-ins",1212,65,45,74,"addin"))], tag="section")
acro  = N("row","group acro",[Lf(ct("sprite","Create PDF and share link",1276,65,76,74,"acro"))], tag="section")

ribbon_tabs = N("row","ribbon-tabs",[Lf(t) for t in TABS]+[Lf(SHARE)], tag="nav",
                attrs=' role="tablist" aria-label="Ribbon"', css=f"background:{C_TOP};height:26px", box=(0,33,WW,26))
ribbon_body = N("row","ribbon-body",[clip,font,align,num,sty,cells,edit,addin,acro],
                css=f"background:{C_TOP};height:79px;overflow:hidden", box=(0,59,WW,79))
formula_bar = N("row","formula-bar",[Lf(ct("combo","NameBox",-1,136,87,28,"formula",role="AXComboBox",nbox=True)),
    Lf(ct("sprite","Cancel",89,138,32,26,"formula")), Lf(ct("sprite","Enter",119,138,32,26,"formula")),
    Lf(ct("sprite","Fx",149,138,32,26,"formula")), Lf(ct("input","Formula Bar",181,141,1196,18,"formula")),
    Lf(ct("sprite","Expand",1377,140,26,21,"formula"))], css=f"background:{C_FORM};height:25px;overflow:visible", box=(0,138,WW,25))
sheet_tabs = N("row","sheet-tabs",[Lf(ct("sprite","Prev sheet",-1,745,32,28,"sheet")), Lf(ct("sprite","Next sheet",29,745,32,28,"sheet")),
    Lf(ct("text","Sheet1",60,746,80,26,"sheet",role="tab",sheettab=True,align="center",size=12.5,color="#107c41")),
    Lf(ct("sprite","Add sheet",139,745,40,28,"sheet"))], css=f"background:{C_SHEET};height:26px", box=(0,746,WW,26))
status_bar = N("row","status-bar",[Lf(ct("text","Ready",21,771,58,22,align="left",size=11.5,color=TXT_DIM)),
    Lf(ct("sprite","Accessibility Good to go",69,774,180,20,"status")), Lf(ct("sprite","Normal view",1082,775,37,22,"status",role="AXRadioButton")),
    Lf(ct("sprite","Page Layout view",1119,775,36,22,"status",role="AXRadioButton")), Lf(ct("sprite","Page Break Preview",1155,775,36,22,"status",role="AXRadioButton")),
    Lf(ct("sprite","Zoom Out",1194,775,18,22,"status")), Lf(ct("slider","zoom",1213,775,102,22,"status")),
    Lf(ct("sprite","Zoom In",1316,775,18,22,"status")), Lf(ct("text","100%",1335,771,54,22,role="AXButton",align="left",size=11.5,color=TXT_DIM))],
    css=f"background:{C_STAT};height:28px", box=(0,772,WW,28))

# titlebar uses CSS grid (1fr auto 1fr) for true window-centred "Book1"
tb_left = render(N("row","tb-left",[Lf(d) for d in DOTS]+[Lf(c) for c in QAT], box=(0,0,WW,33)))
titlebar = ('<header class="titlebar">' + tb_left + leaf(TITLE)
            + '<div class="tb-right">' + leaf(SEARCH) + '</div></header>')

# grid: REAL-TEXT headers (range + labels DETECTED from the capture via _shared/gridtext —
# gridlines for geometry, OCR for the start, sequence-repair for the rest; nothing hardcoded)
# + the procedural cell gradient + the A1 overlay (the ONE position:absolute). Cached by
# capture mtime so iterative rebuilds don't re-OCR.
_cap_png = os.path.join(CAP, "window.png"); _cap_mtime = os.path.getmtime(_cap_png)
_cache_f = os.path.join(CAP, "headers_cache.json")
_cache = {}
if os.path.exists(_cache_f):
    try: _cache = json.load(open(_cache_f))
    except Exception: _cache = {}
if _cache.get("mtime") == _cap_mtime and "col" in _cache and "row" in _cache:
    col_cells = [tuple(c) for c in _cache["col"]]; row_cells = [tuple(c) for c in _cache["row"]]
else:
    colb = G.detect_boundaries(img, "x", RHW, CELLS_TOP, WW, GRID_BOTTOM, SCALE)
    rowb = G.detect_boundaries(img, "y", RHW, CELLS_TOP, WW, GRID_BOTTOM, SCALE)
    col_cells = G.header_labels(img, (0, RHW), (COLHDR_TOP, CELLS_TOP), "x", colb, "alpha", SCALE)
    row_cells = G.header_labels(img, (0, RHW), (CELLS_TOP, GRID_BOTTOM), "y", rowb, "numeric", SCALE)
    json.dump({"mtime": _cap_mtime, "col": col_cells, "row": row_cells}, open(_cache_f, "w"))
CWd = col_cells[1][1] if len(col_cells) > 1 else CW       # detected column width
RHd = row_cells[1][1] if len(row_cells) > 1 else RH       # detected row pitch
ROW1d = row_cells[0][1] if row_cells else ROW1            # detected first-row height
corner = slice_sprite("corner", "grid", OX+0, OY+COLHDR_TOP, RHW, COLHDR_H)  # select-all triangle (a glyph)
# DETECT the selected (highlighted) header cells — Excel paints the selected cell's column
# + row headers a lighter grey. Sample each cell's bg near its edge (off the centred glyph);
# lighter than the dark band bg => selected. (Detected, not hardcoded to A/1.)
def _sel(rx, ry):
    return img.getpixel((clampx(round(rx*SCALE)), clampy(round(ry*SCALE))))[0] > 60
col_sel = [_sel(off+3, COLHDR_TOP+4) for off, _, _ in col_cells]
row_sel = [_sel(3, off+3) for off, _, _ in row_cells]
cols_html = (f'<img class="corner" src="assets/sprites/{corner}.png" alt="select all" '
             f'style="width:{RHW}px;height:{COLHDR_H}px">'
             + "".join(f'<div class="colhdr{" sel" if s else ""}" style="width:{w}px">{H.escape(lbl)}</div>'
                       for (_, w, lbl), s in zip(col_cells, col_sel)))
rows_html = "".join(f'<div class="rowhdr{" sel" if s else ""}" style="height:{h}px">{H.escape(lbl)}</div>'
                    for (_, h, lbl), s in zip(row_cells, row_sel))
grid_html = (f'<div class="grid"><div class="colheaders">{cols_html}</div>'
             f'<div class="grid-body"><div class="rowheaders">{rows_html}</div>'
             f'<div class="gridcells"><div class="a1sel"><div class="fill"></div></div></div></div></div>')

app = ("<div class=\"app\">" + titlebar + render(ribbon_tabs) + render(ribbon_body)
       + render(formula_bar) + grid_html + render(sheet_tabs) + render(status_bar) + "</div>")

CSS = f"""
  *{{box-sizing:border-box;margin:0;padding:0}}
  html,body{{width:{WW}px;height:{WH}px;overflow:hidden;background:{C_TOP};
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Helvetica Neue',Arial,sans-serif;
    -webkit-font-smoothing:antialiased;color:{TXT}}}
  .app{{display:flex;flex-direction:column;width:{WW}px;height:{WH}px}}
  img{{display:block}}
  .iconbtn{{display:block;overflow:hidden}}
  .iconbtn img{{width:100%;height:100%}}
  .split{{display:inline-flex;align-items:flex-start}}
  .dot{{width:12px;height:12px;border-radius:50%}}
  .txt{{display:flex;align-items:center;white-space:nowrap;overflow:hidden}}
  .tab{{font-weight:500}} .tab.active{{font-weight:600}}
  .sheettab{{font-weight:600;border-bottom:2px solid #107c41;background:#fff}}
  .combo{{display:flex;align-items:center;border:1px solid #555;border-radius:3px;padding-left:5px;overflow:hidden}}
  .combo .cval{{flex:1;min-width:0;font-size:12px;color:{TXT};white-space:nowrap;overflow:hidden}}
  .combo .caret{{flex:0 0 16px}}
  .search{{display:flex;align-items:center;background:{C_NBOX};border-radius:5px;overflow:hidden}}
  .search .mag{{flex:0 0 22px}}
  .search .sval{{flex:1;min-width:0;font-size:12px;color:#9a9a9a;white-space:nowrap}}
  .sval::placeholder{{color:#9a9a9a;opacity:1}}
  .finput{{background:#383838}}
  /* titlebar (grid → centred title) */
  .titlebar{{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;height:33px;background:{C_TOP};padding-right:7px}}
  .tb-left{{justify-self:start}} .tb-title{{justify-self:center}} .tb-right{{justify-self:end;display:flex;align-items:center}}
  /* grid: real-text headers (detected) + procedural cells + the one A1 overlay */
  .grid{{display:flex;flex-direction:column;height:583px;background:#fff;overflow:hidden}}
  .colheaders{{display:flex;flex:0 0 {COLHDR_H}px;height:{COLHDR_H}px}}
  .corner{{flex:0 0 auto;display:block}}
  .colhdr{{flex:0 0 auto;display:flex;align-items:center;justify-content:center;height:{COLHDR_H}px;
    background:#161616;color:#eaeaea;font-size:11px;line-height:1;
    border-right:1px solid #565656;border-bottom:1px solid #565656}}
  .grid-body{{display:flex;flex:1 1 auto;min-height:0}}
  .rowheaders{{display:flex;flex-direction:column;flex:0 0 {RHW}px;width:{RHW}px}}
  .rowhdr{{flex:0 0 auto;display:flex;align-items:center;justify-content:center;width:{RHW}px;
    background:#161616;color:#e9e9e9;font-size:11px;line-height:1;
    border-bottom:1px solid #565656;border-right:1px solid #565656}}
  .colhdr.sel,.rowhdr.sel{{background:#565656;color:#fff}}
  .gridcells{{position:relative;flex:1 1 auto;background:#fff;
    background-image:linear-gradient(to right,#d4d4d4 1px,transparent 1px),linear-gradient(to bottom,#d4d4d4 1px,transparent 1px);
    background-size:{CWd}px {RHd}px;background-position:0 -1px}}
  .a1sel{{position:absolute;left:0;top:0;width:{CWd+1}px;height:{ROW1d+1}px;border:2px solid #107c41}}
  .a1sel .fill{{position:absolute;right:-3px;bottom:-3px;width:6px;height:6px;background:#107c41;border:1px solid #fff}}
"""

doc = ('<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Excel replica</title>'
       '<style>\n/* shared, platform-agnostic interactivity (../_shared/interactive.css) */\n'
       + INTERACTIVE_CSS + '\n/* Excel layout (nested hierarchy + normal flow) */' + CSS +
       '</style></head><body>\n' + app + '\n</body></html>')
open(os.path.join(HERE, "index.html"), "w").write(doc)

n_spr = len([f for f in os.listdir(SPR) if f.endswith(".png")])
n_abs = doc.count("position:absolute")
n_btn = doc.count("<button")
n_tab = doc.count('role="tab"')
print(f"wrote index.html | {n_spr} sprites | {n_btn} <button> | {n_tab} role=tab | "
      f"position:absolute = {n_abs} (A1 selection overlay only) | nested flow: titlebar/ribbon-tabs/ribbon-body/groups/formula-bar/grid/sheet-tabs/status-bar")
