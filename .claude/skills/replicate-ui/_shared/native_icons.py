#!/usr/bin/env python3
"""native_icons — clean icons for NATIVE (AppKit) app replicas, the right way.

Hard-won from cloning Office ribbons. A throwaway generator imports this so it never re-derives
(or re-breaks) the same logic. The rules these encode (see SKILL.md step 3b/6):

  • Native-app icons come from the app's compiled asset catalog (Assets.car), extracted CLEAN +
    TRANSPARENT — NOT cropped from a screenshot (which bakes in the background).
  • Match a control to its icon by NAME first (AX name → catalog base name): exact, then keyword
    narrow, then visual-confirm. Blind visual search over thousands of icons picks wrong ones.
  • Render each icon at its MEASURED native glyph box (position + size from the crop), never a fixed
    square — that is what makes the layout match. Use the LARGEST rendition and downscale (crisp,
    not thick).
  • Dropdown chevrons come from the AX role: AXMenuButton has one; AXButton/AXCheckBox do not.

Typical generator use:
    import native_icons as ni
    car   = ni.find_catalogs("/Applications/Microsoft Word.app")[0]      # biggest catalog
    ni.build_pool(car, "pool")                                           # extract @2x icons
    pool  = ni.load_pool("pool")                                         # {base_name: largest png}
    crop  = Image.open("native.png").convert("RGB")                      # the pick-time crop (2x)
    for name, role, (x,y,w,h) in controls:                              # x,y,w,h in ELEMENT points
        base = ni.name_match(name, pool, extra=KNOWN.get(name))          # e.g. "Columns"->TextColumnTwo
        gx,gy,gw,gh = ni.measure_glyph_box(crop, (x,y,w,h), "tall")      # exact icon box
        if base: src = pool[base]                                        # clean catalog icon
        else:    ni.key_bg(crop.crop(...), bg).save(src)                 # screenshot-crop fallback
        ni.trim(src)                                                     # drop transparent padding
        caret = ni.caret_for(role)                                       # chevron iff AXMenuButton
        # ...place <img> at (gx,gy,gw,gh); add caret to the RIGHT of the icon if `caret`.
"""
import os, re, glob, subprocess
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))

# ---- catalog discovery + extraction -----------------------------------------
def find_catalogs(bundle_path):
    """Every Assets.car in an app bundle, LARGEST first (ribbon icons live in the big one,
    e.g. Office's mso40ui.framework)."""
    cars = []
    for root, _, files in os.walk(bundle_path):
        for f in files:
            if f.endswith(".car"):
                p = os.path.join(root, f)
                try: cars.append((os.path.getsize(p), p))
                except OSError: pass
    return [p for _, p in sorted(cars, reverse=True)]

def _ensure_extractor():
    binp = os.path.join(HERE, "catalog_extract"); src = os.path.join(HERE, "catalog_extract.m")
    if not os.path.exists(binp) or os.path.getmtime(binp) < os.path.getmtime(src):
        subprocess.run(["clang","-fobjc-arc","-framework","Foundation","-framework","CoreGraphics",
                        "-framework","ImageIO", src, "-o", binp], check=True)
    return binp

def build_pool(car, out, name_filter=""):
    """Extract @2x icon renditions from `car` into `out/` (compiles catalog_extract on first use)."""
    os.makedirs(out, exist_ok=True)
    subprocess.run([_ensure_extractor(), car, out, name_filter], check=True, capture_output=True)

def _px(p):
    m = re.search(r"\.(\d+)x\d+\.png$", os.path.basename(p)); return int(m.group(1)) if m else 0

_GAMUT = {"m2", "standard", "p3", "srgb", "gray", "graygamma22"}
def _rank(path):
    """Rank a rendition: prefer LOCALE-NEUTRAL / English over foreign-locale variants (else a
    glyph can come back as e.g. Korean 가나), then prefer the LARGEST rendition (downscale = crisp)."""
    b = os.path.basename(path)
    m = re.search(r"normal(?:_dark)?\.(.*?)\.\d+x\.\d+x\d+\.png$", b) or re.search(r"\.(.*?)\.\d+x\.\d+x\d+\.png$", b)
    toks = (m.group(1).split(".") if m else [])
    locs = [t for t in toks if re.fullmatch(r"[A-Za-z]{2,3}", t) and t.lower() not in _GAMUT]
    if not locs: loc = 2                                              # locale-neutral (best)
    elif any(l.lower() in ("en", "gb", "us") for l in locs): loc = 1  # English
    else: loc = 0                                                     # foreign — avoid (가나 etc.)
    return (loc, _px(path))

def load_pool(out, appearance="normal_dark"):
    """{ catalog-base-name → best-rendition PNG path } for the given appearance.
    'normal_dark' = dark UI (light glyphs), 'normal' = light UI. Picks the locale-neutral/English
    rendition (never a foreign-locale glyph) at the largest size (downscale = crisp)."""
    pool = {}
    pat = re.compile(r"(?:TcidAssets_)?(.+?)\." + re.escape(appearance) + r"\.")
    for p in glob.glob(os.path.join(out, f"*.{appearance}.*.png")):
        m = pat.match(os.path.basename(p))
        if not m: continue
        base = m.group(1)
        if base not in pool or _rank(p) > _rank(pool[base]): pool[base] = p
    return pool

# ---- dropdown / popup indicators --------------------------------------------
def caret_for(ax_role):
    """A single down chevron `⌄` iff the control is a MENU button (AXMenuButton) or combo box.
    AXButton/AXCheckBox have none. A POP-UP button is different — see popup_spinner()."""
    return ax_role in ("AXMenuButton", "AXComboBox")

def popup_spinner(cls="spin"):
    """Markup for a macOS NSPopUpButton's UP/DOWN double-chevron (⌃ over ⌄) — what an AXPopUpButton
    shows on the right of its value box (e.g. Word's citation-Style: APA box). This is NOT a single
    down caret (that's a menu/combo button). Pair with CSS:
        .spin{display:flex;flex-direction:column;align-items:center;justify-content:center;
              line-height:.6;font-size:11px;opacity:.85;margin-left:6px}
    Generalized after the dev flagged the Style popup rendering a lone `⌄`."""
    return f'<span class="{cls}"><b>⌃</b><b>⌄</b></span>'

# ---- matching ---------------------------------------------------------------
# NOTE: a NAME match can be plausibly-named but the WRONG glyph (e.g. catalog `InsertCitation` is a
# page with `(−)`+check, but Mac Word renders a scroll with green `+`/red `−`). Automated grayscale
# cross-correlation between a clean catalog icon and a screenshot crop is too noisy to gate on (it
# scores correct matches as low as wrong ones). The reliable safeguard is the human-style check in
# SKILL step 8/11: in the stacked native-over-replica view, ZOOM into each icon and compare the glyph
# SHAPE + accent COLOURS (not just position); when one differs, force that control to a screenshot
# crop (`["CROP"]`) — the guaranteed-exact fallback.

def name_match(ctrl_name, pool, extra=None):
    """Best catalog base-name for a control, or None (→ caller uses screenshot-crop fallback).
    Order: explicit `extra` candidate (exact then substring) → keyword-narrow on the AX name.
    Pass `extra=[...]` when you know the catalog name(s) (e.g. Columns→['TextColumnTwo'])."""
    names = list(pool.keys())
    for c in (extra or []):
        for n in names:
            if n.lower() == c.lower(): return n
    for c in (extra or []):
        for n in names:
            if c.lower() in n.lower(): return n
    kws = [w for w in re.split(r"[^a-z0-9]+", ctrl_name.lower()) if len(w) > 2]
    hits = [n for n in names if kws and all(k in n.lower() for k in kws)]
    return sorted(hits, key=len)[0] if hits else None

# ---- measured glyph box (THE layout fix) ------------------------------------
def _light_bbox(crop, rect, thr, scale):
    ex0, ey0, ex1, ey1 = rect
    c = crop.crop((int(ex0*scale), int(ey0*scale), int(ex1*scale), int(ey1*scale))).convert("L")
    bb = c.point(lambda v: 255 if v > thr else 0).getbbox()
    if not bb: return None
    return (ex0 + bb[0]/scale, ey0 + bb[1]/scale, (bb[2]-bb[0])/scale, (bb[3]-bb[1])/scale)

def measure_glyph_box(crop, btn, kind, scale=2.0):
    """The icon's EXACT (x,y,w,h) in element points, measured from the native crop.
    crop: PIL RGB of the element at `scale` px/pt. btn:(x,y,w,h) element pts.
    kind: 'tall' (icon centred near top, label below) or 'row' (icon at left).
    Guards faint/greyed mis-measures → a sensible centred default so layout never collapses."""
    bx, by, bw, bh = btn
    if kind == 'tall':
        band = (bx, by, bx+bw, by+min(bh, 36))
        box = _light_bbox(crop, band, 95, scale) or _light_bbox(crop, band, 55, scale)
        if box and 20 <= box[3] <= 34 and 22 <= box[2] <= 48: return box
        gw = min(bw-2, 36); return (bx + (bw-gw)/2, by+2, gw, 30)
    else:
        band = (bx, by, bx+22, by+bh)
        box = _light_bbox(crop, band, 95, scale) or _light_bbox(crop, band, 55, scale)
        if box and 8 <= box[3] <= 20 and 8 <= box[2] <= 24: return box
        return (bx+1, by + (bh-16)/2, 16, 16)

# ---- pixel helpers ----------------------------------------------------------
def trim(path):
    """Crop a PNG to its non-transparent glyph bbox so it can be sized exactly to the measured box."""
    im = Image.open(path).convert("RGBA"); bb = im.split()[3].getbbox()
    if bb: im.crop(bb).save(path)

def key_bg(im, bg, tol=26):
    """Screenshot-crop fallback: knock out the (dark) ribbon background → transparent glyph."""
    im = im.convert("RGBA"); px = im.load()
    for j in range(im.height):
        for i in range(im.width):
            r, g, b, a = px[i, j]
            if abs(r-bg[0]) <= tol and abs(g-bg[1]) <= tol and abs(b-bg[2]) <= tol: px[i, j] = (r, g, b, 0)
    return im
