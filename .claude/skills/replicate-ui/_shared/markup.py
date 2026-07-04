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


def _bounds_str(b) -> str:
    """`{x,y,w,h}` (an AX node's serialized bounds) → "x,y,w,h" in points, or ""."""
    if not b:
        return ""
    try:
        return f"{b['x']:.0f},{b['y']:.0f},{b['w']:.0f},{b['h']:.0f}"
    except (KeyError, TypeError):
        return ""


def el_from_node(node: dict, inner: str = "", extra_attrs: dict = None,
                 cls: str = None, style: str = None) -> str:
    """Render an element straight from an AX node dict (a node from `ax_tree.json`
    / the `ax_tree` MCP result) — the role drives the tag, AND the node's semantics
    are stamped on as `data-ax-*` so the generated HTML carries the AX tree itself
    (self-describing markup + enables an AX overlay; see SKILL step 6). The single
    choke point for AX metadata so no per-app generator re-implements it.

        markup.el_from_node(node, inner=icon, cls="ctl", style=f"left:{x}px;top:{y}px")
        # → <button class="ve-btn ctl" data-ax-role="AXButton" data-ax-name="Share"
        #           data-ax-bounds="1081,65,91,24" style="left:…">…</button>

    `extra_attrs` (e.g. aria-pressed, aria-label) win on conflict."""
    role = node.get("role", "_default")
    ax = {"data-ax-role": role}
    if node.get("name"):
        ax["data-ax-name"] = node["name"]
    bs = _bounds_str(node.get("bounds"))
    if bs:
        ax["data-ax-bounds"] = bs
    if node.get("value"):
        ax["data-ax-value"] = str(node["value"])
    if node.get("identifier"):
        ax["data-ax-id"] = node["identifier"]
    if node.get("subrole"):
        ax["data-ax-subrole"] = node["subrole"]
    if extra_attrs:
        ax.update(extra_attrs)
    return el(role, inner=inner, cls=cls, style=style, extra_attrs=ax)
