#!/usr/bin/env python3
# Adobe Acrobat Reader — Home/"Starred" screen replica generator.
#
# LAYOUT MODEL (the convention): a NESTED, SEMANTIC DOM laid out with NORMAL DOCUMENT
# FLOW + flexbox — NOT a flat pile of position:absolute elements. Containers are real
# landmarks (<header>/<nav>/<aside>/<main>/<section>); spacing is flex gap / margin /
# margin-left:auto / padding, never per-element left/top. `position:absolute` is reserved
# for genuine overlays pinned inside a position:relative parent (a presence dot, a caret,
# a focus ring) — this capture has none, so it is ZERO absolute. Slack's build.mjs is the
# DOM-sourced sibling of this model; both keep the same shared role-map + interactive.css.
#
# Acrobat's Home is an AX-opaque CEF surface, so structure/role is inferred visually and
# the proprietary glyphs + the empty-state illustration are sliced from capture/window.png
# (scale 2) as sprites placed INSIDE real semantic controls. Text is live in the real
# Adobe Clean UX font (harvested to fonts/). Static clone (no JS). Window 1440x900 pt.

from PIL import Image
import os, json, html as H

HERE = os.path.dirname(os.path.abspath(__file__))
CAP  = os.path.join(HERE, "capture")
SPR  = os.path.join(HERE, "sprites")
SHARED = os.path.join(HERE, "..", "_shared")
ROLE_MAP = json.load(open(os.path.join(SHARED, "role-map.json")))
INTERACTIVE_CSS = open(os.path.join(SHARED, "interactive.css")).read()
esc = H.escape

W, Hpt, SCALE = 1440, 900, 2
img = Image.open(os.path.join(CAP, "window.png")).convert("RGB")

for f in (os.listdir(SPR) if os.path.isdir(SPR) else []):
    if f.endswith(".png") and not f.startswith("_"):
        os.remove(os.path.join(SPR, f))
os.makedirs(SPR, exist_ok=True)

def slice_sprite(name, x, y, w, h):
    img.crop((round(x*SCALE), round(y*SCALE), round((x+w)*SCALE), round((y+h)*SCALE))).save(
        os.path.join(SPR, name + ".png"))
    return name

# role -> (tag, attrs) via the shared platform-agnostic map (tag is orthogonal to layout)
def role_el(role):
    m = ROLE_MAP.get(role) or ROLE_MAP["_default"]
    return m["tag"], dict(m.get("attrs", {}))
def attrs_str(d):
    return "".join(f' {k}="{esc(str(v))}"' for k, v in d.items())

# ---- colours (sampled from the screenshot) ----
BG, TOPBAR, SEL = "#323233", "#1d1d1d", "#3e3e3e"
NAVTXT, HDRTXT, WELTXT = "#d3d3d3", "#e0e0e0", "#e8e8e8"
EMPTY, SUBTXT, LINK = "#e5e5e5", "#929292", "#598cd5"
BLUE, BLUE2 = "#3973de", "#4580e0"

# ---- leaf controls: a sprite INSIDE a real semantic element (size only, no position) ----
def spr_btn(name, sx, sy, sw, sh, label, popup=False, cls="iconbtn"):
    slice_sprite(name, sx, sy, sw, sh)
    tag, ra = role_el("AXMenuButton" if popup else "AXButton")
    return (f'<{tag} class="{cls}"{attrs_str(ra)} aria-label="{esc(label)}" title="{esc(label)}"'
            f' style="width:{sw}px;height:{sh}px"><img src="sprites/{name}.png" alt=""></{tag}>')

def spr_img(name, sx, sy, sw, sh, alt, cls):
    slice_sprite(name, sx, sy, sw, sh)
    return f'<img class="{cls}" src="sprites/{name}.png" alt="{esc(alt)}" style="width:{sw}px;height:{sh}px">'

# ============================ TOP STRIP (flex row, h35) =======================
home   = spr_btn("home", 9, 5, 33, 26, "Home")
create = ('<button class="createbtn" aria-haspopup="menu" aria-label="Create">'
          '<span class="plus">+</span><span>Create</span></button>')
helpb  = spr_btn("help",   1267, 10, 19, 18, "Help")
bell   = spr_btn("bell",   1300, 10, 18, 19, "Notifications")
waffle = spr_btn("waffle", 1333,  8, 19, 19, "Apps", popup=True)
signin = '<button class="txtbtn" aria-label="Sign in">Sign in</button>'
topstrip = (f'<header class="topstrip"><div class="ts-left">{home}{create}</div>'
            f'<nav class="ts-right" aria-label="Account">{helpb}{bell}{waffle}{signin}</nav></header>')

# ============================ APP BAR (flex row, h47) =========================
logo = spr_img("adobe", 15, 46, 26, 26, "Adobe Acrobat", "logo")
slice_sprite("search", 1238, 50, 18, 18)
search = ('<button class="searchbtn" aria-label="Search">'
          '<img src="sprites/search.png" alt="" style="width:18px;height:18px"><span>Search</span></button>')
freetrial = f'<button class="pill" style="height:30px;background:{BLUE}">Free Trial</button>'
appbar = (f'<header class="appbar"><div class="ab-left">{logo}'
          f'<h1 class="brand">Welcome to Acrobat Reader</h1></div>'
          f'<div class="ab-right">{search}{freetrial}</div></header>')

# ============================ SIDEBAR (flex column) ==========================
# Vertical placement is derived ONCE from the measured row centre-Ys; flow margins
# (computed below) reproduce the pixels while resetting drift at every section anchor.
ROW_H, HDR_H, SIDE_TOP = 32, 28, 82
PRIMARY  = [("Recent", 114, False), ("Starred", 150, True), ("Chats", 186, False)]
SECTIONS = [
    ("Files", 238, [("Your documents", 274, False), ("PDF Spaces", 310, False),
                    ("Curated PDF Spaces", 346, False), ("Scans", 383, False),
                    ("Shared by you", 419, False), ("Shared by others", 454, False)]),
    ("Other file storage", 507, [("Your computer", 542, False), ("Add file storage", 578, True)]),
    ("Agreements", 635, [("All agreements", 671, False)]),
]
CARD_TOP = 747

def navbtn(label, selected=False, link=False):
    cls = "nav" + (" sel" if selected else "") + (" link" if link else "")
    cur = ' aria-current="page"' if selected else ""
    return f'<button class="{cls}"{cur}>{esc(label)}</button>'

side = ['<nav class="navlist" aria-label="Primary">'
        + "".join(navbtn(l, sel) for l, cy, sel in PRIMARY) + '</nav>']
prev_bottom = PRIMARY[-1][1] + ROW_H / 2                      # bottom of last primary row
for hdr, hcy, items in SECTIONS:
    htop = hcy - HDR_H / 2
    mt   = htop - prev_bottom                                 # section anchor (resets drift)
    listmt = (items[0][1] - ROW_H / 2) - (htop + HDR_H)       # header -> first item
    rows = "".join(navbtn(l, link=lk) for l, cy, lk in items)
    side.append(f'<section class="navgroup" style="margin-top:{mt:.0f}px">'
                f'<h3 class="sec-hdr">{esc(hdr)}</h3>'
                f'<nav class="navlist" style="margin-top:{listmt:.0f}px">{rows}</nav></section>')
    prev_bottom = items[-1][1] + ROW_H / 2

card = (f'<aside class="trialcard" style="margin-top:{CARD_TOP - prev_bottom:.0f}px">'
        f'<h4 class="card-title">Free trial</h4>'
        f'<p class="cardbody">Get unlimited access to PDF and e-signing tools.</p>'
        f'<button class="pill card-cta" style="height:30px;background:{BLUE}">Free Trial</button></aside>')
sidebar = f'<aside class="sidebar">{"".join(side)}{card}</aside>'

# ============================ CONTENT (flex column) ==========================
view_list = spr_btn("view_list", 1340, 115, 17, 16, "List view")
view_grid = spr_btn("view_grid", 1383, 115, 16, 16, "Grid view")
content_head = (f'<div class="content-head"><h2 class="page-title">Starred</h2>'
                f'<div class="view-toggle">{view_list}{view_grid}</div></div>')
illus = spr_img("illus", 732, 212, 196, 133, "No starred files", "illus")
empty = (f'<div class="empty-state">{illus}'
         f'<h3 class="empty-title">No starred files yet.</h3>'
         f'<p class="empty-sub">Your starred files will appear here.</p>'
         f'<div class="cta-wrap"><button class="pill cta" style="height:31px;background:{BLUE2}">'
         f'Star from Recent</button></div></div>')
content = f'<main class="content">{content_head}{empty}</main>'

# ================================ CSS ========================================
FONTS = """
  @font-face{font-family:'Adobe Clean UX';font-weight:400;font-style:normal;src:url('fonts/AdobeCleanUX-Regular.otf')}
  @font-face{font-family:'Adobe Clean UX';font-weight:400;font-style:italic;src:url('fonts/AdobeCleanUX-It.otf')}
  @font-face{font-family:'Adobe Clean UX';font-weight:500;font-style:normal;src:url('fonts/AdobeCleanUX-Medium.otf')}
  @font-face{font-family:'Adobe Clean UX';font-weight:700;font-style:normal;src:url('fonts/AdobeCleanUX-Bold.otf')}
"""
CSS = f"""
  *{{box-sizing:border-box;margin:0;padding:0}}
  html,body{{width:{W}px;height:{Hpt}px;overflow:hidden;background:{BG};
    font-family:"Adobe Clean UX","Helvetica Neue",-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;
    -webkit-font-smoothing:antialiased;color:{NAVTXT}}}
  .app{{display:flex;flex-direction:column;width:{W}px;height:{Hpt}px}}
  img{{display:block}}
  .iconbtn{{display:block;overflow:hidden}}
  .iconbtn img{{width:100%;height:100%}}

  /* ---- top strip ---- */
  .topstrip{{display:flex;align-items:center;height:35px;background:{TOPBAR};padding:0 28px 0 9px}}
  .ts-left{{display:flex;align-items:center;gap:0}}
  .ts-right{{display:flex;align-items:center;gap:17px;margin-left:auto}}
  .createbtn{{display:flex;align-items:center;gap:6px;height:25px;margin-left:-8px;padding:0 11px;
    border:1px solid rgba(255,255,255,.30);border-radius:5px;color:{HDRTXT};font-size:14px;line-height:1}}
  .createbtn .plus{{font-size:18px;font-weight:300;line-height:1}}
  .txtbtn{{display:flex;align-items:center;height:24px;color:{HDRTXT};font-size:14px;line-height:1}}

  /* ---- app bar ---- */
  .appbar{{display:flex;align-items:center;height:47px;background:{BG};padding:0 20px 0 15px;
    border-bottom:1px solid rgba(255,255,255,.06)}}
  .ab-left{{display:flex;align-items:center;gap:15px}}
  .ab-right{{display:flex;align-items:center;gap:31px;margin-left:auto}}
  .brand{{font-size:15px;font-weight:500;color:{WELTXT};line-height:1}}
  .searchbtn{{display:flex;align-items:center;gap:7px;color:{NAVTXT};font-size:14px;line-height:1}}
  .pill{{display:inline-flex;align-items:center;justify-content:center;padding:0 16px;border-radius:16px;
    color:#fff;font-size:14px;font-weight:600;line-height:1;white-space:nowrap}}

  /* ---- body split ---- */
  .body{{display:flex;flex:1 1 auto;min-height:0}}

  /* ---- sidebar ---- */
  .sidebar{{display:flex;flex-direction:column;flex:0 0 220px;width:220px;padding-top:16px}}
  .navlist{{display:flex;flex-direction:column;gap:4px}}
  .nav{{display:flex;align-items:center;height:32px;margin:0 16px;padding-left:12px;
    border-radius:6px;font-size:13px;color:{NAVTXT};line-height:1;white-space:nowrap}}
  .nav.sel{{background:{SEL};color:#f0f0f0}}
  .nav.link{{color:{LINK}}}
  .navgroup{{display:flex;flex-direction:column}}
  .sec-hdr{{display:flex;align-items:center;height:28px;padding-left:28px;
    font-size:13px;font-weight:500;color:{HDRTXT};line-height:1}}
  .trialcard{{display:flex;flex-direction:column;width:202px;height:133px;margin:0 0 0 12px;
    border:1px solid {BLUE};border-radius:10px;padding:0 18px 0 24px}}
  .card-title{{font-size:16px;font-weight:700;color:#fff;line-height:1;margin-top:15px}}
  .cardbody{{font-size:13px;color:{NAVTXT};line-height:17px;width:158px;margin-top:8px}}
  .card-cta{{margin-top:13px;margin-left:-6px;align-self:flex-start;width:92px}}

  /* ---- content ---- */
  .content{{display:flex;flex-direction:column;flex:1 1 auto;min-width:0;padding:26px 43px 0 33px}}
  .content-head{{display:flex;align-items:center;height:30px}}
  .page-title{{font-size:20px;font-weight:600;color:{WELTXT};line-height:1}}
  .view-toggle{{display:flex;align-items:center;gap:26px;margin-left:auto}}
  .empty-state{{display:flex;flex-direction:column;align-items:center;margin-top:73px}}
  .empty-title{{font-size:27px;font-weight:400;color:{EMPTY};line-height:1;margin-top:50px}}
  .empty-sub{{font-size:14px;font-style:italic;color:{SUBTXT};line-height:1;margin-top:19px}}
  .cta-wrap{{margin-top:25px}}
"""

doc = ('<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Acrobat replica</title>'
       '<style>\n/* real harvested font */' + FONTS +
       '\n/* shared, platform-agnostic interactivity (../_shared/interactive.css) */\n'
       + INTERACTIVE_CSS + '\n/* Acrobat layout (nested hierarchy + normal flow) */' + CSS +
       '</style></head><body>\n<div class="app">\n'
       + topstrip + "\n" + appbar + '\n<div class="body">\n' + sidebar + "\n" + content +
       '\n</div>\n</div>\n</body></html>')
open(os.path.join(HERE, "index.html"), "w").write(doc)

n_spr = len([f for f in os.listdir(SPR) if f.endswith(".png") and not f.startswith("_")])
n_abs = doc.count("position:absolute")
n_btn = doc.count("<button")
print(f"wrote index.html | {n_spr} sprites | {n_btn} <button> | position:absolute = {n_abs} "
      f"| landmarks: header/nav/aside/main/section nested in flow")
