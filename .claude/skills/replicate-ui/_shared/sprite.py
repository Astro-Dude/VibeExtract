#!/usr/bin/env python3
"""App-agnostic sprite slicing for AX / screenshot-sourced replicas.

When an app exposes no real asset for an icon (native AX apps, AX-opaque CEF
surfaces), the faithful move is to **slice the real pixels** from the captured
window image — never hand-draw. This generalises the `slice_sprite()` that the
Excel / Acrobat generators each re-implemented, and routes every crop through
`cache.SpriteCache` so identical icons across pages dedup to one content-addressed
file. (For Electron apps, prefer `extract_assets` real SVG/PNG/woff2 over slicing.)

    import sys; sys.path.insert(0, "<skill>/_shared")
    from sprite import SpriteSlicer
    sl = SpriteSlicer("capture/window.png", out_root=".replicate-ui/excel",
                      scale=meta["scale"], origin=meta["window_origin"])
    rel = sl.slice("bold", x, y, w, h)      # -> "cache/sprites/<hash>.png" (relative to out_root)
    # reference `rel` from the replica HTML; print(sl.stats()) for hits/misses.
"""

import io
import os
import re

from PIL import Image

try:
    from cache import SpriteCache            # when _shared/ is on sys.path
except ImportError:                          # when imported as a package
    from .cache import SpriteCache


class SpriteSlicer:
    """Crop regions of a captured window image into content-addressed PNGs.

    `image`  — a PIL.Image or a path to the captured window PNG (device pixels).
    `out_root` — the replica's output dir; sprites land in `<out_root>/cache/sprites/`.
    `scale`  — device-pixels-per-point (Retina ≈ 2.0); bounds are given in POINTS.
    `origin` — the window's top-left in screen points, so element screen-bounds map
               to image pixels (pass (0,0) if bounds are already window-relative).
    """

    def __init__(self, image, out_root, scale=1.0, origin=(0, 0)):
        self.img = Image.open(image).convert("RGB") if isinstance(image, str) else image
        self.W, self.H = self.img.size
        self.scale = float(scale)
        self.ox, self.oy = origin
        self.cache = SpriteCache(out_root)
        self._seen = {}

    def _cx(self, v):
        return max(0, min(self.W, int(round(v))))

    def _cy(self, v):
        return max(0, min(self.H, int(round(v))))

    def slice(self, name, x, y, w, h, pad=0) -> str:
        """Crop the element at point (x, y, w, h) → a deduped PNG. Returns the path
        relative to `out_root` (e.g. `cache/sprites/<hash>.png`), or "" if empty."""
        rx, ry = x - self.ox, y - self.oy
        box = (self._cx((rx - pad) * self.scale), self._cy((ry - pad) * self.scale),
               self._cx((rx + w + pad) * self.scale), self._cy((ry + h + pad) * self.scale))
        if box[2] - box[0] < 1 or box[3] - box[1] < 1:
            return ""
        buf = io.BytesIO()
        self.img.crop(box).save(buf, format="PNG")
        return self.cache.put(buf.getvalue(), hint=self._slug(name))

    def _slug(self, name) -> str:
        base = re.sub(r"[^a-z0-9]+", "-", (name or "x").lower()).strip("-") or "x"
        n = self._seen.get(base, 0) + 1
        self._seen[base] = n
        return base if n == 1 else f"{base}-{n}"

    def stats(self) -> dict:
        return self.cache.stats()
