#!/usr/bin/env python3
"""App-agnostic role → semantic-HTML mapping for /replicate-ui replicas.

Single source of truth = `role-map.json` (next to this file). This generalises the
`role_el()` / `attrs_str()` helpers that every per-app generator used to
re-implement identically — any extraction's generator now imports ONE common
toolkit instead of re-deriving the mapping. Platform-agnostic: drive it from the
AX/ARIA role, never special-case per app.

    import sys; sys.path.insert(0, "<skill>/_shared")
    import markup
    tag, attrs = markup.role_el("AXButton")          # ("button", {...})
    html = markup.el("AXButton", inner=icon_svg, cls="iconbtn", extra_attrs={"aria-label": name})
"""

import html as _html
import json
import os

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROLE_MAP = None


def role_map() -> dict:
    """The AX/ARIA-role → tag+attrs table (cached after first load)."""
    global _ROLE_MAP
    if _ROLE_MAP is None:
        with open(os.path.join(_HERE, "role-map.json")) as f:
            _ROLE_MAP = json.load(f)
    return _ROLE_MAP


def role_el(role: str):
    """(tag, attrs) for an AX/ARIA role; falls back to the map's `_default`."""
    m = role_map().get(role) or role_map().get("_default", {"tag": "div", "attrs": {}})
    return m["tag"], dict(m.get("attrs", {}))


def attrs_str(d: dict) -> str:
    """Serialize an attribute dict to an HTML attribute string (values escaped)."""
    return "".join(f' {k}="{_html.escape(str(v))}"' for k, v in (d or {}).items())


def el(role: str, inner: str = "", extra_attrs: dict = None,
       cls: str = None, style: str = None) -> str:
    """Render a complete role-driven element. `cls`/`style` merge with the role's
    default attrs; `extra_attrs` (e.g. aria-label, aria-pressed) override."""
    tag, attrs = role_el(role)
    if cls:
        attrs["class"] = (attrs.get("class", "") + " " + cls).strip()
    if style:
        attrs["style"] = style
    if extra_attrs:
        attrs.update(extra_attrs)
    return f"<{tag}{attrs_str(attrs)}>{inner}</{tag}>"
