#!/usr/bin/env python3
"""Pragmatic per-app reuse cache for /replicate-ui.

The FIRST page of an app pays full cost: harvest assets over CDP, OCR grid
labels, slice ribbon sprites, hand-verify every component. Pages 2..N of the
SAME app are "similar pages" — identical chrome, fonts, icons, toolbar; only the
content/layout differs. This module reports what is already cached for an app so
the skill can REUSE the stable parts and regenerate only what changed.

Three app-stable artifact classes live under `.replicate-ui/<app>/`:

  • assets/manifest.json        — Electron fonts / icon-svgs / images, harvested by
                                  `extract_assets` over CDP. This is the SLOWEST and most
                                  disruptive step (it needs a `relaunch_with_debug_port`,
                                  which quits & reopens the app). Reuse it verbatim across
                                  pages — the icon set and fonts never change page-to-page.
  • capture/headers_cache.json  — grid header labels (A..Z / 1..N) recovered via OCR
                                  (see gridtext.py). Positionally stable for a given window
                                  size, so a same-size page reuses them with no OCR.
  • cache/sprites/<hash>.png    — content-addressed ribbon / toolbar sprites (AX apps like
                                  Excel / Acrobat). Identical icons across pages share one
                                  file, so an unchanged toolbar re-slices to cache hits.

And the prior verified replica (`index.html`) is the best STARTING POINT for a
similar page: copy it, then diff-edit only the changed regions instead of
generating from scratch — far fewer verify iterations.

General, not per-app: everything keys off the app directory and the manifests
the existing tools already write. No app names are hardcoded.

CLI:  python3 _shared/cache.py <app-or-path> [win_w win_h]
      → prints a human-readable reuse report + a machine-readable JSON block.
"""

import hashlib
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))


def app_root(app_or_path: str) -> str:
    """Resolve an app's OUTPUT directory.

    A path (or an existing dir) is used as-is; a bare name like `slack` resolves to
    the gitignored working area `<cwd>/.replicate-ui/<name>`. This is **decoupled
    from where this `_shared/` toolkit lives** — the toolkit ships *inside the skill*
    (`.claude/skills/replicate-ui/_shared/`), while replica outputs live next to the
    user's working dir. So we anchor on the CWD, never on `__file__`."""
    if os.path.sep in app_or_path or os.path.isdir(app_or_path):
        return os.path.abspath(app_or_path)
    return os.path.join(os.getcwd(), ".replicate-ui", app_or_path)


def _age_days(path: str):
    try:
        return round((time.time() - os.path.getmtime(path)) / 86400.0, 2)
    except OSError:
        return None


# --- Electron assets (fonts / icons / svg / images via CDP) -------------------

def asset_status(root: str) -> dict:
    """What `extract_assets` already harvested for this app, if anything."""
    manifest = os.path.join(root, "assets", "manifest.json")
    if not os.path.isfile(manifest):
        return {"present": False, "manifest": manifest}
    try:
        m = json.load(open(manifest))
    except (OSError, ValueError):
        return {"present": False, "manifest": manifest}
    return {
        "present": True,
        "manifest": manifest,
        "fonts": len(m.get("fonts", [])),
        "icons": len(m.get("icons", [])),
        "svgIcons": len(m.get("svgIcons", [])),
        "images": len(m.get("images", [])),
        "age_days": _age_days(manifest),
    }


# --- Grid header labels (Excel-style A..Z / 1..N via OCR) ---------------------

def grid_status(root: str, win_w=None, win_h=None) -> dict:
    """Cached grid header labels (gridtext.py writes headers_cache.json)."""
    cache = os.path.join(root, "capture", "headers_cache.json")
    if not os.path.isfile(cache):
        return {"present": False, "cache": cache}
    try:
        c = json.load(open(cache))
    except (OSError, ValueError):
        return {"present": False, "cache": cache}
    return {
        "present": True,
        "cache": cache,
        "cols": len(c.get("col", [])),
        "rows": len(c.get("row", [])),
        "age_days": _age_days(cache),
    }


# --- Prior verified replica (best starting point for a similar page) ----------

def prior_replica(root: str) -> dict:
    index = os.path.join(root, "index.html")
    if not os.path.isfile(index):
        return {"present": False, "path": index}
    return {"present": True, "path": index, "bytes": os.path.getsize(index),
            "age_days": _age_days(index)}


# --- Content-addressed sprite cache (AX ribbon / toolbar icons) ---------------

class SpriteCache:
    """Dedup sliced sprites by content hash so an unchanged toolbar re-slices to
    cache hits instead of writing N new per-page files.

    Usage from a generator (e.g. excel/build.py)::

        sc = SpriteCache(HERE)
        png_bytes = _png(img.crop(box))      # encode the crop to PNG bytes
        rel = sc.put(png_bytes, hint=slug)   # -> "cache/sprites/<hash>.png"
        # reference `rel` from the HTML; identical crops across pages share the file.
        ...
        print(sc.stats())                    # {"hits": .., "misses": .., "files": ..}

    Exact (sha1) match — robust for icons re-sliced from the same source render.
    A re-captured screenshot with subpixel drift won't match; for that case the
    whole `assets/sprites/` dir of the prior page can be reused wholesale when the
    ribbon is visually unchanged (the skill decides this).
    """

    def __init__(self, root: str):
        self.dir = os.path.join(root, "cache", "sprites")
        os.makedirs(self.dir, exist_ok=True)
        self.index_path = os.path.join(root, "cache", "sprite-index.json")
        try:
            self.index = json.load(open(self.index_path))
        except (OSError, ValueError):
            self.index = {}
        self.hits = 0
        self.misses = 0

    def put(self, png_bytes: bytes, hint: str = "") -> str:
        h = hashlib.sha1(png_bytes).hexdigest()[:16]
        rel = os.path.join("cache", "sprites", h + ".png")
        abspath = os.path.join(self.dir, h + ".png")
        if os.path.exists(abspath):
            self.hits += 1
        else:
            with open(abspath, "wb") as f:
                f.write(png_bytes)
            self.misses += 1
        if hint:
            self.index.setdefault(h, hint)
        return rel

    def stats(self) -> dict:
        try:
            json.dump(self.index, open(self.index_path, "w"), indent=2)
        except OSError:
            pass
        n = self.hits + self.misses
        return {"hits": self.hits, "misses": self.misses,
                "files": len(set(os.listdir(self.dir))) if os.path.isdir(self.dir) else 0,
                "reuse_pct": round(100.0 * self.hits / n, 1) if n else 0.0}


# --- Report -------------------------------------------------------------------

def report(app_or_path: str, win_w=None, win_h=None) -> dict:
    root = app_root(app_or_path)
    sprites_dir = os.path.join(root, "cache", "sprites")
    return {
        "app_root": root,
        "exists": os.path.isdir(root),
        "assets": asset_status(root),
        "grid_labels": grid_status(root, win_w, win_h),
        "prior_replica": prior_replica(root),
        "sprites_cached": len(os.listdir(sprites_dir)) if os.path.isdir(sprites_dir) else 0,
    }


def _print_report(r: dict):
    print(f"# Reuse cache for {r['app_root']}")
    if not r["exists"]:
        print("  (no cache yet — first page of this app; full cost)")
    a = r["assets"]
    if a["present"]:
        print(f"  ✅ assets: REUSE — {a.get('fonts',0)} fonts, "
              f"{a.get('icons',0)} icon-glyphs, {a.get('svgIcons',0)} svg, "
              f"{a.get('images',0)} images ({a.get('age_days')}d old). "
              f"SKIP relaunch_with_debug_port + extract_assets.")
    else:
        print("  ⬜ assets: none — harvest with extract_assets (Electron) if needed.")
    g = r["grid_labels"]
    if g["present"]:
        print(f"  ✅ grid labels: REUSE — {g.get('cols',0)} cols, {g.get('rows',0)} rows "
              f"cached ({g.get('age_days')}d old). SKIP OCR.")
    else:
        print("  ⬜ grid labels: none — gridtext.py will OCR on first run (if a grid app).")
    if r["sprites_cached"]:
        print(f"  ✅ sprites: {r['sprites_cached']} cached — identical ribbon icons reuse files.")
    p = r["prior_replica"]
    if p["present"]:
        print(f"  ✅ prior replica: START FROM {p['path']} ({p['bytes']}B, "
              f"{p.get('age_days')}d old) — copy it, diff-edit only changed regions.")
    else:
        print("  ⬜ prior replica: none — generate from scratch.")


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        print("usage: python3 _shared/cache.py <app-or-path> [win_w win_h]")
        sys.exit(2)
    win_w = float(sys.argv[2]) if len(sys.argv) > 2 else None
    win_h = float(sys.argv[3]) if len(sys.argv) > 3 else None
    r = report(sys.argv[1], win_w, win_h)
    _print_report(r)
    print("\n--- json ---")
    print(json.dumps(r, indent=2))


if __name__ == "__main__":
    main()
