#!/usr/bin/env python3
"""kui_map — read a WPS/Kingsoft-style app's OWN command->icon binding from its `.kui`/`.kuip`
UI-definition XML, so icon SELECTION is a deterministic LOOKUP instead of a visual guess.

Why this exists: the app ships, in `.kui`/`.kuip`, the exact `id`/`text`/`customTip`/`ksoCmd` ->
`icon` mapping it uses to draw every command (e.g. `PDFToWord` -> `change_to_word_kd`). The AX tree
never exposes which icon resource a button drew, so without this map we reverse-GUESS the icon by
pixel-matching a crop — which is probabilistic and wrong on the hard cases. Reading the map turns
the ~90% of registered ribbon commands into an exact lookup; `icon_match` then only has to
visual-CONFIRM the looked-up icon (and is the fallback for unregistered/dynamic buttons).

Generalises beyond WPS to any app that ships a discoverable command->icon table; for other app
families add their glob to `KUI_GLOBS`. Pure stdlib (regex + glob), no XML dep needed (the files
are flat attribute lists; regex is robust against malformed/huge files)."""
import glob
import os
import re

# Where command tables live, relative to the .app bundle. WPS/Kingsoft = office6/res/*.kui|*.kuip.
KUI_GLOBS = [
    "Contents/Resources/office6/res/*.kui",
    "Contents/Resources/office6/res/*.kuip",
    "Contents/Resources/office6/res/**/*.kuip",
    "Contents/Resources/**/*.kui",
]


def _norm(s):
    """Normalise a label/command id for matching: lowercase, strip a leading '@', drop non-alnum."""
    return re.sub(r"[^a-z0-9]", "", (s or "").lower().lstrip("@"))


def find_kui_files(app_path):
    files = set()
    for g in KUI_GLOBS:
        files.update(glob.glob(os.path.join(app_path, g), recursive=True))
    return sorted(files)


def parse_commands(app_path):
    """All command records that carry an `icon`. Each is the element's attribute dict
    ({id,text,customTip,ksoCmd,icon,...}); later files don't override earlier index entries."""
    recs = []
    for f in find_kui_files(app_path):
        try:
            txt = open(f, encoding="utf-8", errors="ignore").read()
        except OSError:
            continue
        # Elements are flat `<Tag a="b" .../>` with an icon= attr somewhere in the attr list.
        for m in re.finditer(r'<\w+\s+([^>]*?\bicon="[^"]+"[^>]*?)/?>', txt):
            a = dict(re.findall(r'(\w+)="([^"]*)"', m.group(1)))
            if a.get("icon"):
                recs.append(a)
    return recs


def build_index(app_path):
    """norm(key) -> icon, keyed by every customTip/text/ksoCmd/id a command exposes.
    First write wins (earlier files = the primary ribbon definitions)."""
    index = {}
    for a in parse_commands(app_path):
        for key in (a.get("customTip"), a.get("text"), a.get("ksoCmd"), a.get("id")):
            k = _norm(key)
            if k and k not in index:
                index[k] = a["icon"]
    return index


def lookup(index, *aliases, fuzzy=True):
    """Resolve an icon name from one or more label/command aliases.
    Exact-normalised first; then (if `fuzzy`) a conservative containment match (len>=5) — useful
    when the visible label ('Export to Picture') differs slightly from the command text."""
    for a in aliases:
        ic = index.get(_norm(a))
        if ic:
            return ic
    if fuzzy:
        for a in aliases:
            n = _norm(a)
            if len(n) < 5:
                continue
            # prefer a key that equals-or-extends the label, then any containment
            for k, ic in index.items():
                if k == n or k.startswith(n) or n.startswith(k):
                    return ic
            for k, ic in index.items():
                if n in k or k in n:
                    return ic
    return None


if __name__ == "__main__":
    import sys
    idx = build_index(sys.argv[1] if len(sys.argv) > 1 else "/Applications/wpsoffice.app")
    print(f"commands-with-icon indexed: {len(idx)}")
    for q in sys.argv[2:]:
        print(f"  {q!r} -> {lookup(idx, q)}")
