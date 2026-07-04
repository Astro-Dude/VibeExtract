#!/usr/bin/env python3
"""icon_gate — THE runnable icon acceptance gate for /replicate-ui. Converts "are the icons identical
to native?" from a judgment call into a deterministic command you must run and show as green.

Why this exists: the skill's acceptance gates were all PROSE resting on the model's judgment, so a
mis-coloured / wrong icon could (and did) slip through to "done". This emits an unambiguous per-icon
verdict + a native|replica contact sheet + an EXIT CODE, and the skill forbids "done" until it's clean.

Usage:
    python3 icon_gate.py NATIVE.png REPLICA.png icon_boxes.json [--out _icon_gate.png]
      [--color-max 14] [--shape-pass 0.45] [--search 60x28]

  icon_boxes.json: {"<name>": [x, y, w, h], ...}  — each icon's box in the REPLICA render (px). The
  generator already knows these positions, so it emits this map (and renders NATIVE/REPLICA at the
  SAME size). The native glyph is then template-LOCATED (slide the clean replica glyph) — never a fixed
  box, which catches label text ("Pic"/"Extr"/"Sc").

Verdict policy. The HARD gate is GROSS colour error only — `color-max` defaults to 50 because the bug
that actually ships (a body painted the ACCENT colour, e.g. grey #c7c7c7 vs blue #3a82f7 ≈ Δ140) is
huge, while AA/sampling noise on tiny glyphs is ~10–30 and must NOT fail (a ~0.5%% stroke diff is fine).
Subtle differences go to EYEBALL, where the model confirms by looking — that, plus the per-region ≤12/ch
gate (SKILL 8a), is where fine colour is judged. The table prints exact body/accent Δ so they're visible.
    FAIL    : body Δ > color_max, OR (native has accent AND) accent Δ > color_max          -> exit 1
    EYEBALL : couldn't confidently locate (loc < loc_min) OR shape < shape_pass            -> exit 2
    PASS    : located, gross-colour-clean, AND shape >= shape_pass
Exit 0 only when EVERY icon is PASS. Exit 1 if any FAIL. Exit 2 if no FAIL but some EYEBALL (must look).
"""
import argparse
import json
import os
import sys

from PIL import Image, ImageDraw

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import icon_match as im


def run_gate(native_path, replica_path, boxes, out="_icon_gate.png",
             color_max=50, shape_pass=0.45, loc_min=0.20, search=(60, 28),
             lock_map=None):
    """Returns (results, code). results = [{name, verdict, shape, loc, body_delta, accent_delta, lock}].
    code: 0 all PASS, 1 any FAIL, 2 some EYEBALL (no FAIL).

    lock_map: path to icon_map.json. When given, every PASS icon that has a
    resource entry there gets its lock written/refreshed via
    `icon_match.confirm_pick` with THIS run's located native crop — the gate is
    the one place that both verifies an icon and holds the verified pixels, so
    it is where crop_hash gets recorded (prose instructions to do this manually
    never happened, which is why legacy maps have no hashes)."""
    nat = Image.open(native_path).convert("RGB")
    rep = Image.open(replica_path).convert("RGB")
    locks = im.load_map(lock_map) if lock_map else {}
    results, tiles = [], []
    for name, box in boxes.items():
        g, nc, rc = im.gate_at(nat, rep, tuple(box), search=search, color_max=color_max)
        nb, rb = g["native_body"], g["replica_body"]
        na, ra = g["native_accent"], g["replica_accent"]
        # Did we CONFIDENTLY find the native glyph? If not, no colour verdict is trustworthy → LOOK.
        located = g["loc"] >= loc_min and nb is not None
        # HARD FAIL only when CONFIDENT of a gross error (both sides sampled AND delta gross). AA noise
        # on tiny crops is ~10–30; the bug that ships (body painted the accent) is ~140. We deliberately
        # do NOT chase exact — heuristic colour metrics on tiny AA'd glyphs are noisy, so the gate's real
        # power is forcing the EYEBALL of the contact sheet (recolor_svg already prevents the bug at build).
        body_gross = nb is not None and rb is not None and g["body_delta"] > color_max
        acc_gross = na is not None and ra is not None and g["accent_delta"] > color_max
        if not located:
            verdict = "EYEBALL"
        elif body_gross or acc_gross:
            verdict = "FAIL"
        elif g["shape"] >= shape_pass:
            verdict = "PASS"
        else:
            verdict = "EYEBALL"   # located + colour-clean but low shape (thin/complex glyph) → LOOK
        lock_state = "-"
        if lock_map:
            entry = locks.get(name)
            if verdict == "PASS" and entry and entry.get("resource"):
                im.confirm_pick(lock_map, name, entry["resource"], nc,
                                gate={"verdict": verdict, "shape": g["shape"], "loc": g["loc"],
                                      "body_delta": g["body_delta"], "accent_delta": g["accent_delta"]})
                lock_state = "LOCKED"
            elif entry and entry.get("confirmed"):
                # confirmed but not gate-PASSED this run — the lock stays but is
                # NOT refreshed; an EYEBALL confirmed by eye must be locked
                # explicitly via icon_match.confirm_pick.
                lock_state = "stale"
            else:
                lock_state = "unlocked"
        results.append({"name": name, "verdict": verdict, "shape": g["shape"], "loc": g["loc"],
                        "body_delta": g["body_delta"], "accent_delta": g["accent_delta"],
                        "lock": lock_state})
        # native | replica tile for the contact sheet
        w = max(nc.width, rc.width)
        t = Image.new("RGB", (2 * w + 6, max(nc.height, rc.height)), "#202020")
        t.paste(nc, (0, 0)); t.paste(rc, (w + 6, 0))
        tiles.append((name, verdict, t.resize((t.width * 3, t.height * 3))))

    if any(r["verdict"] == "FAIL" for r in results):
        code = 1
    elif any(r["verdict"] == "EYEBALL" for r in results):
        code = 2
    else:
        code = 0

    if out and tiles:
        cols = 4
        cw = max(t.width for *_, t in tiles) + 16
        ch = max(t.height for *_, t in tiles) + 24
        rows = (len(tiles) + cols - 1) // cols
        sheet = Image.new("RGB", (cols * cw, rows * ch), "#101010")
        d = ImageDraw.Draw(sheet)
        color = {"PASS": "#4caf50", "EYEBALL": "#e6b800", "FAIL": "#f44336"}
        for i, (name, verdict, t) in enumerate(tiles):
            x, y = (i % cols) * cw, (i // cols) * ch
            sheet.paste(t, (x + 8, y + 4))
            d.text((x + 8, y + t.height + 6), f"{name} {verdict}", fill=color.get(verdict, "#bbb"))
        sheet.save(out)
    return results, code


def main():
    ap = argparse.ArgumentParser(description="Icon acceptance gate (native vs replica).")
    ap.add_argument("native"); ap.add_argument("replica"); ap.add_argument("boxes")
    ap.add_argument("--out", default="_icon_gate.png")
    ap.add_argument("--color-max", type=int, default=50)   # GROSS-error hard gate (body-as-accent ≈140)
    ap.add_argument("--shape-pass", type=float, default=0.45)
    ap.add_argument("--loc-min", type=float, default=0.20)
    ap.add_argument("--search", default="60x28")
    ap.add_argument("--update-locks", metavar="ICON_MAP",
                    help="icon_map.json — every PASS icon gets its lock written/refreshed "
                         "(records crop_hash of this run's located native crop)")
    ap.add_argument("--only", metavar="NAMES",
                    help="comma-separated icon names — gate just this subset (pages 2+ reverify)")
    a = ap.parse_args()
    sx, sy = (int(v) for v in a.search.lower().split("x"))
    boxes = json.load(open(a.boxes))
    if a.only:
        keep = {n.strip() for n in a.only.split(",") if n.strip()}
        missing = keep - set(boxes)
        if missing:
            print(f"WARNING: --only names not in {a.boxes}: {sorted(missing)}", file=sys.stderr)
        boxes = {n: b for n, b in boxes.items() if n in keep}
        if not boxes:
            print("ERROR: --only filtered every icon out; nothing to gate", file=sys.stderr)
            sys.exit(1)
    results, code = run_gate(a.native, a.replica, boxes, out=a.out, color_max=a.color_max,
                             shape_pass=a.shape_pass, loc_min=a.loc_min, search=(sx, sy),
                             lock_map=a.update_locks)
    print(f"{'icon':14s} {'verdict':8s} {'shape':>6s} {'loc':>5s} {'bodyΔ':>6s} {'accΔ':>5s} {'lock':>8s}")
    for r in results:
        acc = "-" if r["accent_delta"] is None else r["accent_delta"]
        print(f"{r['name']:14s} {r['verdict']:8s} {r['shape']:6.3f} {r['loc']:5.2f} "
              f"{r['body_delta']:6d} {str(acc):>5s} {r.get('lock', '-'):>8s}")
    n = len(results)
    npass = sum(r["verdict"] == "PASS" for r in results)
    fails = [r["name"] for r in results if r["verdict"] == "FAIL"]
    eye = [r["name"] for r in results if r["verdict"] == "EYEBALL"]
    tag = {0: "PASS", 1: "FAIL", 2: "REVIEW"}[code]
    print(f"\nVERDICT: {tag}  ({npass}/{n} auto-PASS)  sheet={a.out}")
    if fails:
        print(f"  FAIL (colour off — fix + re-run): {fails}")
    if eye:
        print(f"  EYEBALL (confirm these tiles by eye before 'done'): {eye}")
    sys.exit(code)


if __name__ == "__main__":
    main()
