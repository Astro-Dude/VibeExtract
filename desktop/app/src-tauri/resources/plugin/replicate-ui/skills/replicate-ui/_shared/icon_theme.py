#!/usr/bin/env python3
"""icon_theme — recolor a harvested vector icon to a target UI THEME, keeping body vs accent
distinct. THE canonical recolor step; nothing else should hand-edit icon colors.

Why this exists (the bug it kills): kdesign/`_kd` and `colorXStroke` icons paint the monochrome
BODY (document outline, frame) with one theme-following class and the COLOURED ACCENT (a blue "W",
green grid, orange "P", red badge) with a separate named class. A naive recolor that picks ONE
colour per icon and slaps it on every class turns the body into the accent colour — so every icon
WITH an accent ships with e.g. a fully-blue document instead of a grey document + blue badge. (Real
regression: PDF-to-Word/Excel/PPT/Picture-to-PDF all had blue/green/orange/red BODIES.) Monochrome
icons survive that bug (their one colour is grey) which is why it hides until someone eyeballs an
accented icon.

The fix: assign colour by CLASS ROLE, not one-per-icon.
  • BODY   classes -> the theme body colour (light grey on a dark bar): `kd-color-icon-primary`/
    `-secondary`, `color{Black,White}{Stroke,Fill}`, `currentColor`, `var(--kd-color-icon-primary…)`.
  • ACCENT classes -> their named accent (overridable): `kd-color-icon-<colourword>-primary`,
    `color{Blue,Green,Orange,Red,…}{Stroke,Fill}`.
  • stroke-width / unknown rules -> left untouched.
Colours MUST be baked into the file (an icon used via `<img src>` can't inherit page colour, and
qlmanage/Chromium ignore CSS custom properties). Pair this with the COLOUR-AWARE vision gate
(`icon_match.gate_icon`) which re-checks body+accent against fresh native pixels — recolour proposes,
the gate disposes. Pure stdlib regex (the files are flat attribute/style lists).
"""
import re

# WPS / kdesign dark-theme palette. Body is the sampled native dark-mode grey (== raw km_darkmode_*).
# COLOUR SOURCE OF TRUTH = the icon's DESIGNED accent (its named accent CLASS), NOT the screenshot.
# These are the ACTIVE/focused-window dark-theme values — bright body grey + VIVID accents that pop on a
# dark bar. Do NOT match a screenshot's colours: a background/inactive window desaturates the whole toolbar
# (dim grey body + muted accents) and tiny glyphs blend toward grey under anti-aliasing — sampling that
# ships dull/grey icons. Sample the capture ONLY to REFINE a hue when the glyph is genuinely saturated; a
# dull/grey sample must NEVER flatten or dull a designed accent. (Use recolor_designed below as the default.)
DARK_BODY = "#cfcfcf"
DARK_ACCENTS = {
    "blue": "#3d8bf5", "green": "#25b06e", "orange": "#ef7d12", "red": "#ec5347",
    "yellow": "#f2b324", "purple": "#9a6cf2", "cyan": "#18b3a6", "teal": "#18b3a6",
}

_COLORWORDS = "blue|green|orange|red|yellow|purple|cyan|teal|gray|grey|black|white"
_NEUTRAL = {"black", "white", "gray", "grey"}


def _classify(class_name):
    """('body'|'accent'|None, colourword|None) for a CSS class name."""
    n = class_name.lower()
    m = re.search(r"kd-color-icon-(%s)\b" % _COLORWORDS, n)
    if m:
        return ("body", None) if m.group(1) in _NEUTRAL else ("accent", m.group(1))
    if n in ("kd-color-icon-primary", "kd-color-icon-secondary"):
        return ("body", None)
    m = re.search(r"color(%s)(stroke|fill)" % _COLORWORDS, n)
    if m:
        return ("body", None) if m.group(1) in _NEUTRAL else ("accent", m.group(1))
    return (None, None)


def _sub_colors(decl, color):
    """Replace every colour token (var() fallback, #hex, currentColor) in a rule body with `color`.
    Leaves non-colour props (fill-rule, stroke-width values, opacity) intact."""
    decl = re.sub(r"var\(\s*--[^,)]+,\s*[^)]+\)", color, decl)
    decl = re.sub(r"#[0-9a-fA-F]{6,8}\b|#[0-9a-fA-F]{3,4}\b", color, decl)
    decl = decl.replace("currentColor", color)
    return decl


def recolor_svg(svg, body_hex=DARK_BODY, accents=None):
    """Recolour an icon SVG: BODY classes -> `body_hex`, ACCENT classes -> their named accent
    (from `accents`, falling back to `DARK_ACCENTS`). Handles both the raw `var(--…, fallback)`
    form and an already-hardcoded `#hex` form, in `<style>` rules and inline fill/stroke attrs.

    Returns the recoloured SVG as str. Unknown colour schemes (e.g. `stylebaseStroke*`) are left
    untouched on purpose — re-match such an icon to a `_kd`/`colorXStroke` resource (which this
    understands), or rely on the vision gate to reject it."""
    if isinstance(svg, (bytes, bytearray)):
        svg = bytes(svg).decode("utf-8", "ignore")
    palette = {**DARK_ACCENTS, **(accents or {})}

    def fix_rule(m):
        name, body = m.group(1), m.group(2)
        kind, word = _classify(name)
        if kind == "body":
            return ".%s {%s}" % (name, _sub_colors(body, body_hex))
        if kind == "accent" and palette.get(word):
            return ".%s {%s}" % (name, _sub_colors(body, palette[word]))
        return m.group(0)

    svg = re.sub(r"\.([\w-]+)\s*\{([^}]*)\}", fix_rule, svg)
    # Inline (non-<style>) body references.
    svg = re.sub(r'(fill|stroke)="currentColor"', lambda m: '%s="%s"' % (m.group(1), body_hex), svg)
    svg = re.sub(
        r'(fill|stroke)="var\(\s*--kd-color-icon-(?:primary|secondary)[^"]*\)"',
        lambda m: '%s="%s"' % (m.group(1), body_hex),
        svg,
    )
    return svg


def has_accent(svg):
    """True if the icon is DESIGNED with a named accent (a real colour-word accent class) — i.e. it must
    render coloured, not grey. False => monochrome line icon (grey)."""
    if isinstance(svg, (bytes, bytearray)):
        svg = bytes(svg).decode("utf-8", "ignore")
    for m in re.finditer(r"kd-color-icon-(%s)\b" % _COLORWORDS, svg.lower()):
        if m.group(1) not in _NEUTRAL:
            return True
    return bool(re.search(r"color(%s)(stroke|fill)" % _COLORWORDS, svg.lower()))


def recolor_designed(svg, body_hex=DARK_BODY, refine=None):
    """THE DEFAULT recolour — capture-INDEPENDENT, correct on the first pass.

    BODY -> `body_hex` (active-window bright grey). Each named ACCENT class -> its DESIGNED vivid
    dark-theme accent (DARK_ACCENTS, the active/focused look). An icon with a named accent class is ALWAYS
    coloured & vivid; an icon with none stays monochrome grey. The screenshot is NOT consulted here.

    `refine`: optional {word: (r,g,b)} of accent colours SAMPLED from the native glyph — used ONLY to nudge
    the HUE, and ONLY when the sample is genuinely saturated/bright. A dull/grey/desaturated sample is
    ignored, so a background/inactive-window capture can never flatten or dull a designed accent.
    """
    import colorsys
    accents = dict(DARK_ACCENTS)
    if refine:
        for word, rgb in refine.items():
            if not rgb:
                continue
            h, s, v = colorsys.rgb_to_hsv(*[c / 255 for c in rgb])
            if s < 0.30 or v < 0.30:          # dull/grey sample -> ignore, keep the vivid designed accent
                continue
            r, g, b = colorsys.hsv_to_rgb(h, max(s, 0.70), max(v, 0.86))   # keep sampled hue, force vivid
            accents[word] = "#%02x%02x%02x" % (round(r * 255), round(g * 255), round(b * 255))
    return recolor_svg(svg, body_hex=body_hex, accents=accents)


def classify_classes(svg):
    """Diagnostic: {class_name: ('body'|'accent'|None, word)} for every class defined in <style>.
    Lets the gate report which icons use an unknown scheme this recolour can't reason about."""
    if isinstance(svg, (bytes, bytearray)):
        svg = bytes(svg).decode("utf-8", "ignore")
    out = {}
    for name in set(re.findall(r"\.([\w-]+)\s*\{", svg)):
        out[name] = _classify(name)
    return out


if __name__ == "__main__":
    import sys
    data = open(sys.argv[1], "rb").read()
    body = sys.argv[2] if len(sys.argv) > 2 else DARK_BODY
    sys.stdout.write(recolor_svg(data, body))
