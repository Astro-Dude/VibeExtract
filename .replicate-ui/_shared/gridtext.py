#!/usr/bin/env python3
"""Shared, platform-agnostic "grid labels -> real text" helper for UI replicas.

When a region is a grid of LABELS baked into one image (e.g. a spreadsheet's row
numbers / column letters), this turns it into real, individual text cells instead of a
sprite. NOTHING is hardcoded: the visible range + cell sizes are DETECTED from the
capture each run, and the label text comes from AX when an app exposes it, else from
OCR of the detected cells, with a sequence-aware repair that only cleans OCR noise.

Hybrid text source (the design the user chose): AX -> OCR -> repair.
  - geometry:  detect_boundaries()  reads the real gridlines from the cell area.
  - text:      header_labels()      AX labels if given, else per-cell OCR (macOS Vision,
               via vision_ocr.swift) -> repair(kind): OCR establishes the START (so a
               scrolled sheet stays correct); the sequence rule (alpha/numeric) only
               regenerates/repairs values from that detected start. Single-glyph OCR is
               unreliable, so we never trust individual reads beyond the consensus start.

Reused by any Python-based replica generator (excel/build.py today; future apps).
"""
import os, subprocess, json, tempfile
from collections import Counter
from PIL import Image, ImageOps

HERE = os.path.dirname(os.path.abspath(__file__))
_SWIFT = os.path.join(HERE, "vision_ocr.swift")
_BIN = os.path.join(HERE, "vision_ocr")


def _ensure_ocr():
    """Compile vision_ocr once; recompile only if the source is newer."""
    if os.path.exists(_BIN) and os.path.getmtime(_BIN) >= os.path.getmtime(_SWIFT):
        return _BIN
    subprocess.run(["swiftc", "-O", _SWIFT, "-o", _BIN], check=True)
    return _BIN


def _ocr_image(pil):
    """Run macOS Vision on a PIL image -> list of recognised strings."""
    _ensure_ocr()
    f = tempfile.mktemp(suffix=".png"); pil.save(f)
    try:
        r = subprocess.run([_BIN, f], capture_output=True, text=True)
        return [t["text"] for t in json.loads(r.stdout or "[]")]
    except Exception:
        return []
    finally:
        try: os.remove(f)
        except OSError: pass


def ocr_cell(img, x0, y0, x1, y1, scale=2):
    """Crop one header cell and OCR the single glyph (invert->autocontrast->upscale->pad
    — the prep that makes tiny isolated glyphs legible to Vision). Returns raw string."""
    c = img.crop((round(x0*scale), round(y0*scale), round(x1*scale), round(y1*scale)))
    g = ImageOps.autocontrast(ImageOps.invert(c.convert("L")))
    g = g.resize((max(1, g.width*8), max(1, g.height*8)), Image.LANCZOS)
    g = ImageOps.expand(g, border=24, fill=255).convert("RGB")
    return "".join(_ocr_image(g)).strip()


def detect_boundaries(img, axis, cx0, cy0, cx1, cy1, scale=2, tol=14):
    """Detect grid cell boundaries by reading the real gridlines in the CELL AREA
    (gray line on white) along a centre probe line. Returns boundary coords (points),
    spanning the area edges. Range is fully detected — never hardcoded."""
    px = img.load()
    out = []
    if axis == "x":
        py = round((cy0 + cy1) / 2 * scale)
        rng = range(round(cx0*scale), round(cx1*scale))
        get = lambda v: px[v, py]
    else:
        pxn = round((cx0 + cx1) / 2 * scale)
        rng = range(round(cy0*scale), round(cy1*scale))
        get = lambda v: px[pxn, v]
    for v in rng:
        c = get(v)
        if 120 < c[0] < 235 and abs(c[0]-c[1]) < tol and abs(c[1]-c[2]) < tol:
            out.append(v // scale)
    bnds, prev = [], -9
    for v in out:
        if v - prev > 3:
            bnds.append(v)
        prev = v
    lo = cx0 if axis == "x" else cy0
    hi = cx1 if axis == "x" else cy1
    if not bnds or bnds[0] - lo > 3:
        bnds = [int(lo)] + bnds              # prepend the area's leading edge
    if hi - bnds[-1] > 3:
        bnds = bnds + [int(hi)]              # append the trailing edge (last partial cell)
    return bnds


def _col_name(n):                            # 1->A, 26->Z, 27->AA
    s = ""
    while n > 0:
        n, r = divmod(n - 1, 26); s = chr(65 + r) + s
    return s

def _col_num(s):
    n = 0
    for ch in s:
        if "A" <= ch <= "Z": n = n*26 + (ord(ch) - 64)
        else: return None
    return n or None


def repair(raws, kind):
    """raws: per-cell OCR strings (index = cell index). Establish the START from the OCR
    consensus (mode of value-index), then regenerate the whole arithmetic sequence from
    it. OCR supplies the (scroll-aware) start; `kind` supplies the rule + fixes noise."""
    vals = {}
    for i, r in enumerate(raws):
        r = (r or "").strip().upper()
        if kind == "numeric":
            d = "".join(c for c in r if c.isdigit())
            if d: vals[i] = int(d)
        else:
            v = _col_num("".join(c for c in r if c.isalpha()))
            if v: vals[i] = v
    base = Counter(v - i for i, v in vals.items()).most_common(1)[0][0] if vals else 1
    return [(str(base + i) if kind == "numeric" else _col_name(base + i)) for i in range(len(raws))]


def header_labels(img, bx, by, axis, boundaries, kind, scale=2, ax_labels=None):
    """Real-text labels for one header band. AX-first, else OCR+repair.
    Returns [(offset_pt, size_pt, label)] per cell. `bx/by` = the band's fixed cross-axis
    [start,end] (e.g. colheader y-range, rowheader x-range)."""
    cells = [(boundaries[i], boundaries[i+1]) for i in range(len(boundaries)-1)]
    n = len(cells)
    if ax_labels and len(ax_labels) >= n:
        labels = [str(ax_labels[i]) for i in range(n)]          # app exposed them
    else:
        raws = []
        for (a, b) in cells:
            if axis == "x":
                raws.append(ocr_cell(img, a, by[0], b, by[1], scale))
            else:
                raws.append(ocr_cell(img, bx[0], a, bx[1], b, scale))
        labels = repair(raws, kind)
    return [(cells[i][0], cells[i][1]-cells[i][0], labels[i]) for i in range(n)]
