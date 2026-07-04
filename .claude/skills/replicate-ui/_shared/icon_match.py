#!/usr/bin/env python3
"""icon_match — pick each control's icon by VISUAL match to the native pixels, not by name.

Why this exists: name-driven icon selection (keyword / id-map) is two-level-ambiguous and
regresses on every re-pick. Here the native icon PIXELS decide; the name map is only a prior
that shortlists candidates. Confirmed picks are LOCKED in icon_map.json so re-runs never
re-pick them (kills the "fixed one, broke another" regression).

Pipeline:  extract_pool (resource_extract) -> render_masks (cached, colour-invariant)
           -> per control: match(native_crop, masks, name_prior) -> ranked candidates
           -> model confirms once -> lock in icon_map.json.

Color-invariance trick: a rendered candidate's ALPHA channel IS its silhouette regardless of
the glyph's colour; the native crop uses luma + polarity. Both reduce to a binary shape mask,
so theme recolour, background, padding, 16-vs-24px and AA all drop out. Pure PIL (no numpy).
"""
import os, struct, zlib, glob, json, hashlib, subprocess, tempfile, re
from PIL import Image, ImageChops, ImageStat, ImageFilter, ImageOps

try:
    import resource_extract as rx
except ImportError:
    rx = None


# ---------------------------------------------------------------- masks
def _binarize(ink):
    """L-mode single channel -> binary (0/255) via a two-mode histogram split."""
    h = ink.histogram()
    total = sum(h) or 1
    # midpoint between the darkest and brightest populated buckets, weighted to ink
    lo = next((i for i, c in enumerate(h) if c), 0)
    hi = next((i for i in range(255, -1, -1) if h[i]), 255)
    thr = (lo + hi) // 2 if hi > lo else 128
    return ink.point(lambda v: 255 if v > thr else 0)


def _native_ink(crop):
    """Native RGB crop -> binary glyph mask (polarity-aware: glyph may be light-on-dark)."""
    g = crop.convert("L")
    st = ImageStat.Stat(g)
    if st.mean[0] < 128:          # mostly dark bg -> glyph is the bright set (keep)
        ink = g
    else:                          # light bg -> invert so glyph is bright
        ink = ImageOps.invert(g)
    return _binarize(ink)


def _io(b):
    import io
    return io.BytesIO(b)


def _ink_from_rgba(im):
    """RGBA render -> binary silhouette. Use ALPHA only when it carries REAL transparency
    (transparent bg + opaque glyph). qlmanage thumbnails onto an OPAQUE WHITE background, so
    alpha is uniformly 255 (useless) — then use luma instead (dark glyph on light bg → invert)."""
    a = im.split()[3]
    ast = ImageStat.Stat(a)
    if a.getbbox() is not None and ast.mean[0] < 250 and ast.stddev[0] > 8:
        ink = a                                   # meaningful alpha channel
    else:
        ink = ImageOps.invert(im.convert("L"))    # opaque render: glyph is the dark set
    return _binarize(ink)


def _inline_css_vars(svg_bytes):
    """qlmanage can't resolve CSS custom properties, so theme-templated SVGs (kdesign '_kd':
    fill:var(--kd-color-icon-primary,#333333) / currentColor) render BLANK on its white bg — an
    empty silhouette → a useless mask whose score collapses to ~0.2-0.3 regardless of correctness.
    Inline each var()'s fallback colour and give currentColor a visible value so the glyph actually
    paints. Best-effort; on any error the caller keeps the original bytes."""
    try:
        s = svg_bytes.decode("utf-8", "ignore")
        s = re.sub(r"var\(\s*--[^,)]+,\s*([^)]+)\)", r"\1", s)   # var(--x, #fff) -> #fff
        s = re.sub(r"var\(\s*--[^)]+\)", "#333333", s)           # var(--x) (no fallback) -> dark
        s = s.replace("currentColor", "#333333")
        return s.encode("utf-8")
    except Exception:
        return svg_bytes


def normalize(binary, size=64, blur=1.2):
    """binary glyph -> tight-crop -> resize size×size -> soft mask (alignment/AA tolerant)."""
    bb = binary.getbbox()
    if bb:
        binary = binary.crop(bb)
    m = binary.resize((size, size), Image.BILINEAR)
    return m.filter(ImageFilter.GaussianBlur(blur)) if blur else m


def score(a, b):
    """Shape similarity in [0,1] of two normalized soft masks (pure PIL). 0.6*softIoU + 0.4*NCC."""
    inter = ImageStat.Stat(ImageChops.darker(a, b)).sum[0]
    union = ImageStat.Stat(ImageChops.lighter(a, b)).sum[0] or 1
    iou = inter / union
    sa, sb = ImageStat.Stat(a), ImageStat.Stat(b)
    ma, mb = sa.mean[0], sb.mean[0]
    eab = ImageStat.Stat(ImageChops.multiply(a, b)).mean[0] * 255.0    # multiply scales /255
    cov = eab - ma * mb
    denom = (sa.stddev[0] * sb.stddev[0]) or 1e-6
    ncc = max(0.0, min(1.0, cov / denom))
    return 0.6 * iou + 0.4 * ncc


# ---------------------------------------------------------------- candidate rendering (cached)
def render_masks(pool, keys, size=64, cache_dir="cache/masks", blur=1.2, batch=180):
    """{key: normalized soft mask} for the requested keys, content-hash cached as PNG.
    SVGs are rasterised with BATCHED qlmanage calls (one process per ~180 files, not per
    file) — the difference between seconds and minutes for a few-hundred-candidate pool."""
    os.makedirs(cache_dir, exist_ok=True)
    out, todo = {}, []
    for k in keys:
        if k not in pool:
            continue
        h = hashlib.sha1(pool[k]).hexdigest()[:16]
        cp = os.path.join(cache_dir, f"{h}@{size}.png")
        if os.path.exists(cp):
            out[k] = Image.open(cp).convert("L")
        else:
            todo.append((k, h, cp))
    if not todo:
        return out
    with tempfile.TemporaryDirectory() as td:
        svg_jobs = []                                    # (key,h,cp, svg_path)
        for k, h, cp in todo:
            b = pool[k]
            if b[:4] == b"\x89PNG":                      # PNG candidate -> mask directly
                m = normalize(_ink_from_rgba(Image.open(_io(b)).convert("RGBA")), size, blur)
                m.save(cp); out[k] = m
            else:
                sp = os.path.join(td, h + ".svg")
                open(sp, "wb").write(_inline_css_vars(b))   # paint theme-templated _kd icons
                svg_jobs.append((k, h, cp, sp))
        for i in range(0, len(svg_jobs), batch):          # batched qlmanage
            chunk = svg_jobs[i:i + batch]
            subprocess.run(["qlmanage", "-t", "-s", str(size * 2)] + [j[3] for j in chunk]
                           + ["-o", td], capture_output=True)
        for k, h, cp, sp in svg_jobs:
            pngs = glob.glob(os.path.join(td, h + ".svg*.png")) + glob.glob(os.path.join(td, h + ".png"))
            if not pngs:
                continue
            m = normalize(_ink_from_rgba(Image.open(pngs[0]).convert("RGBA")), size, blur)
            m.save(cp); out[k] = m
    return out


# ---------------------------------------------------------------- matching
def _shortlist(pool_idx, name_prior, keywords, kw_cap=44):
    """candidate keys = prior basename + its size/state variants (ALWAYS) + a CAPPED set of
    keyword neighbours. Uncapped substring keywords explode (e.g. "line"→1000+); we keep the
    prior's own variants unconditionally and add only the `kw_cap` shortest keyword-matching
    basenames (shortest ≈ the base command, not a long derived name)."""
    cands = set()
    priors = [name_prior] if isinstance(name_prior, str) else list(name_prior or [])
    for p in priors:
        for variant in (p, *p.split(";")):                 # state lists "x;x-hover;x-down"
            base = variant.strip()
            for bn, keys in pool_idx.items():
                if bn == base or bn.startswith(base + "_") or base.startswith(bn):
                    cands.update(keys)
    kwl = [k.lower() for k in (keywords or [])]
    hits = [bn for bn in pool_idx if any(k in bn.lower() for k in kwl)]
    for bn in sorted(set(hits), key=lambda b: (len(b), b))[:kw_cap]:
        cands.update(pool_idx[bn])
    return cands


def match(native_crop, pool, pool_idx, name_prior=None, keywords=None,
          size=64, topk=6, prior_boost=0.10, cache_dir="cache/masks"):
    """Rank candidates for ONE control. Returns [(key, score, from_prior)] sorted best-first.
    name_prior only BIASES (prior_boost); a clearly-better visual score still wins."""
    nat = normalize(_native_ink(native_crop), size)
    cand_keys = _shortlist(pool_idx, name_prior, keywords)
    if not cand_keys:                                       # no prior -> broad keyword pool
        cand_keys = set(k for bn, ks in pool_idx.items() for k in ks
                        if any(w in bn.lower() for w in (keywords or [])))
    masks = render_masks(pool, cand_keys, size, cache_dir)
    prior_bases = set()
    for p in ([name_prior] if isinstance(name_prior, str) else (name_prior or [])):
        prior_bases.update(x.strip() for x in p.split(";"))
    ranked = []
    for k, m in masks.items():
        s = score(nat, m)
        is_prior = rx.basename(k) in prior_bases if rx else False
        # Adaptive boost: only let the name-prior break ties among candidates with REAL signal.
        # A blank/near-zero mask (e.g. a render that still failed) must not be boosted into winning.
        boost = prior_boost if (is_prior and s >= 0.40) else 0.0
        ranked.append((k, s, s + boost, is_prior))
    ranked.sort(key=lambda r: -r[2])                        # sort by biased score
    return [(k, round(s, 3), p) for (k, s, _b, p) in ranked[:topk]]


# ---------------------------------------------------------------- color-aware rendered-icon GATE
# The mask scorer above is COLOUR-BLIND (it binarises to a silhouette) and whole-strip SSIM is
# alignment-dominated — so BOTH miss a wrong body colour (e.g. a document painted in the accent
# colour instead of grey) or a wrong accent. This gate closes that hole: it compares the FINAL
# rendered icon (native crop vs replica crop) on BOTH shape AND sampled body/accent colour. Run it
# on every placed icon and DON'T stop until each passes — this is the "separate icon accuracy
# predictor" the dev asked for, and the regression-catcher the recolour step needs behind it.
def _hsv(p):
    import colorsys
    return colorsys.rgb_to_hsv(p[0] / 255.0, p[1] / 255.0, p[2] / 255.0)


def _median_rgb(pixels):
    if not pixels:
        return None
    return tuple(sorted(p[c] for p in pixels)[len(pixels) // 2] for c in range(3))


def dominant_accent(crop, min_sat=0.30, min_val=0.25, core_frac=0.4):
    """The accent colour's CORE as (r,g,b), or None if the icon is monochrome. Robust to anti-
    aliasing: takes the saturated/bright pixels, keeps the most-saturated `core_frac` of them and
    returns their per-channel MEDIAN (a single most-saturated pixel is an AA blend and unstable)."""
    sat = [(p, _hsv(p)[1]) for p in list(crop.convert("RGB").getdata()) if _hsv(p)[2] > min_val and _hsv(p)[1] > min_sat]
    if not sat:
        return None
    sat.sort(key=lambda t: -t[1])
    core = [p for p, _ in sat[: max(1, int(len(sat) * core_frac))]]
    return _median_rgb(core)


def body_grey(crop, max_sat=0.18, min_val=0.45, max_val=0.90):
    """The monochrome body stroke colour = MEDIAN of the low-saturation (grey) pixels, EXCLUDING
    near-white (`v > max_val`) so bright LABEL TEXT bleeding into the crop (#f5f5f5) can't masquerade
    as the icon body (#c7c7c7) — that false-fails monochrome icons. Median (not brightest) so AA edges
    and a little stray text don't shift it; the icon stroke dominates a well-located crop."""
    greys = [p for p in list(crop.convert("RGB").getdata())
             if _hsv(p)[1] < max_sat and min_val < _hsv(p)[2] <= max_val]
    return _median_rgb(greys) if greys else None


def ink_color(crop, min_val=0.30):
    """MEDIAN colour of the glyph 'ink' = every pixel brighter than the dark bar background. The
    gross body-as-accent bug flips this from grey to the accent colour (Δ~140); a correct icon stays
    body-dominant. Reliable where body/accent extraction (which can return None on AA) is not."""
    px = [p for p in list(crop.convert("RGB").getdata()) if _hsv(p)[2] > min_val]
    return _median_rgb(px) if px else None


def _chan_delta(a, b):
    return 999 if (a is None or b is None) else max(abs(a[i] - b[i]) for i in range(3))


def gate_icon(native_crop, replica_crop, size=64, shape_min=0.60, color_max=24):
    """Colour-aware accuracy gate for ONE rendered icon. Returns a dict with an alignment-tolerant
    silhouette `shape` score + body/accent colour channel-deltas + `passed`. `passed` ⇔
    shape ≥ shape_min AND body within color_max AND (if the native has an accent) accent within
    color_max. This catches the exact bugs the mask scorer can't: mis-coloured body, wrong accent."""
    nc, rc = native_crop.convert("RGB"), replica_crop.convert("RGB")
    shp = score(normalize(_native_ink(nc), size), normalize(_native_ink(rc), size))
    nb, rb = body_grey(nc), body_grey(rc)
    na, ra = dominant_accent(nc), dominant_accent(rc)
    ni, ri = ink_color(nc), ink_color(rc)
    body_d, acc_d = _chan_delta(nb, rb), _chan_delta(na, ra)
    color_ok = body_d <= color_max and (na is None or acc_d <= color_max)
    return {
        "shape": round(shp, 3),
        "body_delta": body_d,
        "accent_delta": (None if na is None else acc_d),
        "ink_delta": _chan_delta(ni, ri),
        "native_accent": na, "replica_accent": ra,
        "native_body": nb, "replica_body": rb,
        "native_ink": ni, "replica_ink": ri,
        "passed": bool(shp >= shape_min and color_ok),
    }


def locate_glyph(native_img, template_crop, center, search=(60, 28), step=2):
    """Find the native glyph by sliding the CLEAN replica glyph (`template_crop`) over `native_img`
    around `center=(cx,cy)` within ±`search` px. Self-aligning — NEVER trust a fixed box, which
    catches label text ("Pic"/"Extr"/"Sc"). Returns (iou, native_crop) where native_crop is the RGB
    crop at the best-matching position (for colour sampling); iou is the silhouette overlap there."""
    T = _binarize(_native_ink(template_crop.convert("RGB")))
    bb = T.getbbox()
    if bb:
        T = T.crop(bb)
    w, h = T.size
    cx, cy = center
    sx, sy = search
    x0, y0 = cx - w // 2, cy - h // 2
    best = None
    for dy in range(-sy, sy + 1, step):
        for dx in range(-sx, sx + 1, step):
            x, y = x0 + dx, y0 + dy
            patch = _binarize(_native_ink(native_img.crop((x, y, x + w, y + h)).convert("RGB")))
            inter = ImageStat.Stat(ImageChops.darker(patch, T)).sum[0]
            union = ImageStat.Stat(ImageChops.lighter(patch, T)).sum[0] or 1
            iou = inter / union
            if best is None or iou > best[0]:
                best = (iou, x, y, w, h)
    iou, x, y, w, h = best
    return iou, native_img.crop((x, y, x + w, y + h))


def gate_at(native_img, replica_img, box, search=(60, 28), color_max=14):
    """Gate ONE icon end-to-end: `box=(x,y,w,h)` is the icon's position in the REPLICA render (the
    generator knows it). Crops the replica glyph as the template, locates the native glyph by sliding
    it (alignment-free), and runs `gate_icon`. Returns the gate_icon dict plus `loc` (template IoU)
    and the located crops. Shape stays advisory here — see `icon_gate.py` for the PASS/EYEBALL/FAIL
    policy (colour is the hard gate; a ~0.5%% stroke-weight difference must NOT fail)."""
    x, y, w, h = box
    rc = replica_img.crop((x, y, x + w, y + h))
    iou, nc = locate_glyph(native_img, rc, (x + w // 2, y + h // 2), search=search)
    g = gate_icon(nc, rc, color_max=color_max)
    g["loc"] = round(iou, 3)
    return g, nc, rc


# ---------------------------------------------------------------- lock (icon_map.json)
def load_map(path):
    return json.load(open(path)) if os.path.exists(path) else {}


def save_map(path, m):
    json.dump(m, open(path, "w"), indent=2, sort_keys=True)


def crop_hash(src):
    """SHA1[:16] of a verified native crop. Accepts raw bytes, a file path, or a
    PIL Image (re-encoded to PNG so callers don't have to round-trip a file)."""
    if isinstance(src, bytes):
        data = src
    elif isinstance(src, str):
        data = open(src, "rb").read()
    else:
        import io
        buf = io.BytesIO()
        src.convert("RGB").save(buf, "PNG")
        data = buf.getvalue()
    return hashlib.sha1(data).hexdigest()[:16]


def is_locked(entry, ch):
    return bool(entry) and entry.get("confirmed") and entry.get("crop_hash") == ch


def confirm_pick(map_path, name, resource, native_crop, gate=None):
    """The ONLY sanctioned way to write a lock. Historically generators
    `json.dump`ed over icon_map.json without ever recording `crop_hash`, so
    `is_locked` was always False and 'locked' icons silently re-picked on the
    next page. This MERGES (never clobbers other entries) and records the hash
    of the native crop the pick was verified against — making the lock real."""
    m = load_map(map_path)
    entry = {"resource": resource, "confirmed": True, "crop_hash": crop_hash(native_crop)}
    if gate:
        entry["gate"] = {k: gate[k] for k in ("verdict", "shape", "loc", "body_delta", "accent_delta")
                         if k in gate}
    m[name] = entry
    save_map(map_path, m)
    return entry


def lock_decision(entry, fresh_ch, pool_idx=None):
    """Re-pick policy for a control on a LATER page/run, given its icon_map
    entry and the crop_hash of THIS page's fresh native crop. Returns:
      'reuse'    — confirmed and the fresh crop is byte-identical to the one
                   the lock was verified against: place it, zero cost.
      'reverify' — confirmed but the capture differs (the normal cross-page
                   case, and all legacy entries without crop_hash): place the
                   locked resource, then it MUST pass icon_gate against THIS
                   page's capture before it counts as done. Never reuse on faith.
      'repick'   — no confirmed entry, or the locked resource no longer exists
                   in the fresh pool (app updated): run the full match pipeline.
    """
    if not entry or not entry.get("confirmed") or not entry.get("resource"):
        return "repick"
    if pool_idx is not None and entry["resource"] not in pool_idx:
        return "repick"
    if entry.get("crop_hash") and entry["crop_hash"] == fresh_ch:
        return "reuse"
    return "reverify"
