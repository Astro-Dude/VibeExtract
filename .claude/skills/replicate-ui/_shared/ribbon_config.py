#!/usr/bin/env python3
"""ribbon_config.py — DETERMINISTIC command->icon resolver for config-driven ribbon apps
(WPS / Kingsoft and any app that ships a .kui/.kuip XML ribbon definition).

WHY THIS EXISTS (read this): the #1 recurring /replicate-ui failure is GUESSING ribbon icon names
(or trusting the silhouette matcher on tiny dark glyphs) and shipping the WRONG glyph. The app
ALREADY ships the exact command->icon map inside its ribbon config. This tool reads ALL of it so a
session never has to guess. Prose telling you to "read the .kui" was not enough — sessions still
guessed — so this is the mechanical replacement: RUN IT, use its output.

MANDATORY for any config-driven ribbon (WPS PDF/Sheets/Writer/Presentation, etc.), BEFORE you pick
any ribbon icon:

    # dump the full command->icon table (what every button maps to):
    python3 _shared/ribbon_config.py --app /Applications/wpsoffice.app
    # or locate the app by the running pid:
    python3 _shared/ribbon_config.py --pid 630
    # resolve specific button labels straight to their icon basenames:
    python3 _shared/ribbon_config.py --app /Applications/wpsoffice.app \
        --labels "Full Screen;Zoom;Arrange All;New Window;Freeze Panes;Split"
    # search the table when a button's UI label differs from the command text:
    python3 _shared/ribbon_config.py --app /Applications/wpsoffice.app --grep reading

Then pull each returned `icon` basename from the .rcc pool (resource_extract) and recolour by class
(icon_theme.recolor_svg, keep accents). ALWAYS still eyeball each final glyph against a fresh native
crop (the map is exact, but you must confirm placement + colour) — see icon_match.gate_icon.

NOTES on the config format (so the table is complete):
  * Scans the WHOLE res/ tree recursively, including commands/ subdirs and every <import> target —
    the top-level `*ongmani.kui` is mostly titlebar/file-menu; the ribbon bindings live in its
    imports (etcommon.kuip / etentries.kuip / commands/<app>/ for ET; pdfcommon.kuip for PDF; etc.).
  * The binding element carries the icon on `icon="basename[;state;...]"` and is keyed by
    `id=` / `ksoCmd=` / `text="@Label"` — NOT `name=` (a name= regex finds nothing).
  * `text` may use HTML entities (&amp; &#10;) — decoded here.
  * A few buttons have a UI label that differs from the command text (e.g. WPS-Sheets
    "Highlight Row & Column" is the **Reading Layout** command -> reading_mode_kd). For those,
    --labels won't exact-match; use --grep / the full dump and match by meaning, then VERIFY the
    glyph against the native crop.
"""
import os, re, sys, json, glob, html, subprocess, argparse


def find_res_dir(app=None, pid=None, res=None):
    if res and os.path.isdir(res):
        return res
    cands = []
    if app:
        cands.append(app)
    if pid:
        try:
            comm = subprocess.check_output(["ps", "-p", str(pid), "-o", "comm="]).decode().strip()
            m = re.match(r"(.*\.app)/", comm)
            if m:
                cands.append(m.group(1))
        except Exception:
            pass
    if not cands:
        cands += sorted(glob.glob("/Applications/*.app"))
    for base in cands:
        if base.endswith(".kui") or base.endswith(".kuip"):
            return os.path.dirname(base)
        for sub in ("Contents/Resources/office6/res", "Contents/Resources/res",
                    "Contents/Resources", "Resources/res", ""):
            d = os.path.join(base, sub) if sub else base
            if os.path.isdir(d) and (glob.glob(d + "/*.kui") or glob.glob(d + "/*.kuip")
                                     or glob.glob(d + "/**/*.kuip", recursive=True)):
                return d
    return None


_TAG = re.compile(r"<(\w+)\b([^>]*?)/?>", re.S)


def _attr(a, name):
    m = re.search(r'\b' + name + r'="([^"]*)"', a)
    return html.unescape(m.group(1)) if m else ""


def parse_bindings(res_dir):
    """Every element under res_dir carrying icon=, as {icon,id,ksoCmd,text,file}."""
    files = (glob.glob(res_dir + "/**/*.kui", recursive=True)
             + glob.glob(res_dir + "/**/*.kuip", recursive=True))
    out = []
    for f in files:
        try:
            t = open(f, encoding="utf-8", errors="replace").read()
        except Exception:
            continue
        rel = os.path.relpath(f, res_dir)
        for m in _TAG.finditer(t):
            a = m.group(2)
            ic = re.search(r'\bicon="([^";]+)', a)        # first of icon="a;hover;down;..."
            if not ic:
                continue
            out.append({"icon": ic.group(1), "id": _attr(a, "id"),
                        "ksoCmd": _attr(a, "ksoCmd"),
                        "text": _attr(a, "text").lstrip("@").replace("\n", " ").strip(),
                        "file": rel})
    return out


def _norm(s):
    return re.sub(r"\s+", " ", s.lower()).strip()


# WPS module prefixes: a label like "Split"/"Normal" exists in several modules with DIFFERENT icons.
# `et`=Spreadsheets, `wps`=Writer, `wpp`=Presentation, `pdf`=PDF. Pass --module to disambiguate.
def _ribbon_score(b, module):
    """Higher = more likely the ACTUAL ribbon button (vs a menu/legacy/other-module duplicate)."""
    s = 0
    f = b["file"].lower()
    if module:
        m = module.lower()
        if f.startswith(m) or ("/" + m + "/") in f or f.startswith("commands/" + m):
            s += 4
        elif any(f.startswith(o) or ("/" + o + "/") in f for o in ("et", "wps", "wpp", "pdf") if o != m):
            s -= 3                                   # penalise a different module's duplicate
    cid = b["id"]
    if re.match(r"r[A-Z]", cid) or cid.startswith(("RB", "Rb", "rb")) or "ribbon" in cid.lower() \
            or "rainbow" in cid.lower():
        s += 3                                       # WPS ribbon commands are r-prefixed / *Ribbon
    if b["text"]:
        s += 1
    return s


def build_index(bindings):
    idx = {}
    for kf in ("text", "ksoCmd", "id"):
        for b in bindings:
            if b[kf]:
                idx.setdefault((kf, _norm(b[kf])), b["icon"])
    return idx


def resolve(label, bindings, idx, module=None):
    """Return (icon, how, alternates). Prefers the module's ribbon binding; lists other distinct
    icon candidates so a wrong auto-pick is always visible (then confirm vs the native crop)."""
    nl = _norm(label)
    cands = [b for b in bindings if (_norm(b["text"]) == nl or _norm(b["ksoCmd"]) == nl or _norm(b["id"]) == nl)]
    how = "exact"
    if not cands:                                    # fall back to substring on the command text
        cands = [b for b in bindings if b["text"] and (nl in _norm(b["text"]) or
                 (len(b["text"]) > 3 and _norm(b["text"]) in nl))]
        how = "fuzzy"
    if not cands:
        return None, "NOT FOUND (UI label may differ from command text — use --grep <keyword>)", []
    cands.sort(key=lambda b: -_ribbon_score(b, module))
    best = cands[0]
    alts = []
    seen = {best["icon"]}
    for b in cands[1:]:
        if b["icon"] not in seen:
            seen.add(b["icon"])
            alts.append({"icon": b["icon"], "id": b["id"], "ksoCmd": b["ksoCmd"], "file": b["file"]})
    note = f"{how}; id={best['id'] or '-'} ksoCmd={best['ksoCmd'] or '-'} [{best['file']}]"
    return best["icon"], note, alts


def main():
    ap = argparse.ArgumentParser(description="Resolve ribbon command->icon from the app's .kui/.kuip config")
    ap.add_argument("--app", help="path to the .app bundle (e.g. /Applications/wpsoffice.app)")
    ap.add_argument("--pid", type=int, help="locate the app by a running pid")
    ap.add_argument("--res", help="point straight at the res/ config dir")
    ap.add_argument("--labels", help="';'-separated UI button labels to resolve to icon basenames")
    ap.add_argument("--module", help="app module to disambiguate duplicate labels: et|wps|wpp|pdf "
                                      "(et=Sheets, wps=Writer, wpp=Presentation)")
    ap.add_argument("--grep", help="substring filter for the full-table dump")
    args = ap.parse_args()

    res = find_res_dir(args.app, args.pid, args.res)
    if not res:
        print("ERROR: could not locate the ribbon config dir. Pass --res <dir>, --app <App.app>, "
              "or --pid <pid>.", file=sys.stderr)
        sys.exit(2)
    print(f"# config dir: {res}", file=sys.stderr)
    bindings = parse_bindings(res)
    if not bindings:
        print("ERROR: no icon= bindings found (is this a config-driven ribbon app?)", file=sys.stderr)
        sys.exit(2)
    idx = build_index(bindings)

    if args.labels:
        result = {}
        for lab in re.split(r"[;,]", args.labels):
            lab = lab.strip()
            if lab:
                ic, how, alts = resolve(lab, bindings, idx, args.module)
                result[lab] = {"icon": ic, "match": how}
                if alts:
                    result[lab]["alternates"] = alts        # other modules/states — verify vs native crop
        print(json.dumps(result, indent=2, ensure_ascii=False))
        missing = [k for k, v in result.items() if not v["icon"]]
        if missing:
            print(f"# UNRESOLVED (UI label != command text): {missing} — use --grep <keyword> and "
                  f"match by meaning, then verify the glyph vs the native crop.", file=sys.stderr)
        if not args.module:
            print("# TIP: pass --module et|wps|wpp|pdf to disambiguate labels shared across app "
                  "modules (e.g. 'Split','Normal'). Always confirm each glyph vs the native crop.",
                  file=sys.stderr)
        return

    seen, rows = set(), []
    for b in bindings:
        if not b["text"]:
            continue
        key = (b["text"], b["icon"])
        if key in seen:
            continue
        seen.add(key)
        if args.grep and args.grep.lower() not in (b["text"] + b["ksoCmd"] + b["id"]).lower():
            continue
        rows.append(b)
    for b in sorted(rows, key=lambda x: x["text"].lower()):
        print(f'{b["text"][:36]:38} icon={b["icon"]:30} ksoCmd={b["ksoCmd"] or "-"}')
    print(f"# {len(rows)} text-bound commands{' matching ' + repr(args.grep) if args.grep else ''}",
          file=sys.stderr)


if __name__ == "__main__":
    main()
