// Rebuilds index.html from the hand-drawn replica + harvested real assets.
// Backs up the hand-drawn version, then: swaps fonts→local Slack-Lato, terminal
// + avatars→real PNGs, adds the rail workspace icon, and replaces every
// hand-drawn <svg> (in document order) with the real harvested SVG, colored to
// match the captured computed color.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ICONS = path.join(here, "assets", "icons");
const manifest = JSON.parse(fs.readFileSync(path.join(here, "assets", "manifest.json"), "utf8"));
const colorOf = Object.fromEntries(manifest.svgIcons.map((s) => [s.name, s.color]));
const rectOf = Object.fromEntries(manifest.svgIcons.filter((s) => s.rect).map((s) => [s.name, s.rect]));

// Shared, platform-agnostic semantic layer — the SAME role->tag map + interactivity
// CSS the Excel (AX) replica uses. Slack is a hand-drawn Electron replica, so we map
// its control containers to real semantic tags via this map (never per-app logic).
const roleMap = JSON.parse(fs.readFileSync(path.join(here, "..", "_shared", "role-map.json"), "utf8"));
const INTERACTIVE = fs.readFileSync(path.join(here, "..", "_shared", "interactive.css"), "utf8");
const tagOf = (r) => (roleMap[r] || roleMap._default).tag;
const attrOf = (r) => Object.entries((roleMap[r] || {}).attrs || {}).map(([k, v]) => `${k}="${v}"`).join(" ");

// Resolve a harvested image by identity (label substring) — robust to the
// status suffixes / filename variations that come from live aria-labels.
// `big` picks the largest matching capture (message avatars > sidebar ones).
const pick = (substr, big = true) => {
  const ms = manifest.images
    .filter((im) => (im.label || "").toLowerCase().includes(substr.toLowerCase()))
    .sort((a, b) => (big ? 1 : -1) * ((b.rect?.w || 0) * (b.rect?.h || 0) - (a.rect?.w || 0) * (a.rect?.h || 0)));
  if (!ms.length) { console.warn("MISSING image:", substr); return null; }
  return path.basename(ms[0].file);
};
const AV = {
  ishan: pick("ishan"), anishka: pick("anishka"), naman: pick("naman"),
  naverdo: pick("naverdo"), ashutosh: pick("ashutosh"),
  workspace: pick("team-icon") || pick("team") || pick("scaler"), terminal: pick("thumbnail") || pick("image.png"),
  slackbotAI: pick("slackbot"),
};
// Rail-bottom glyph size, derived from the harvested icon rects (not hardcoded).
const railIcon = Math.round(Math.max(rectOf.plus?.w || 0, rectOf.moon?.w || 0)) || 20;
console.log("resolved images:", AV);

const ic = (name) => {
  const file = path.join(ICONS, `${name}.svg`);
  if (!fs.existsSync(file)) { console.warn("MISSING icon:", name); return null; }
  let svg = fs.readFileSync(file, "utf8").trim();
  // Strip Slack's own width/height/style so the container's `svg{width:Npx}`
  // CSS rules size it; we only set color (the SVGs use fill="currentColor").
  svg = svg.replace(/\sstyle="[^"]*"/i, "").replace(/\s(width|height)="[^"]*"/gi, "");
  const color = colorOf[name] || "currentColor";
  return svg.replace(/^<svg\s/i, `<svg style="color:${color}" `);
};

// Read from the pristine hand-drawn backup if present, so re-runs are idempotent.
const backup = path.join(here, "index-v9-handdrawn.html");
const srcFile = fs.existsSync(backup) ? backup : path.join(here, "index.html");
let html = fs.readFileSync(srcFile, "utf8");
if (!fs.existsSync(backup)) fs.writeFileSync(backup, html);

// 1) Asset CSS (keep Google Lato for text — it's calibrated; the real
//    Slack-Lato-Quip is visually identical but re-drifts the spacing).
const inject = `
  /* shared, platform-agnostic interactivity (../_shared/interactive.css) */
${INTERACTIVE}
  .ricon svg,.tb-icon svg,.fmt-btn svg,.tb-btn svg,.pill-btn svg,.icon-btn svg,.tab svg,.ws-header svg,.send svg{display:block}
  .rail-ws{width:36px;height:36px;border-radius:10px;overflow:hidden;margin-bottom:-9px}
  .rail-ws img{width:100%;height:100%;object-fit:cover;display:block}
  .conv-ava img,.msg .av img,.dm-ava img{width:100%;height:100%;object-fit:cover;display:block;border-radius:inherit}
  /* presence dot is a SEPARATE overlay positioned outside the avatar box; the
     container's overflow:hidden was clipping it (cutting its gap-ring) so it read
     as fused into the photo. overflow:visible lets the dot show as its own
     component — the photo still rounds via the img's border-radius:inherit. */
  .dm-ava,.conv-ava{overflow:visible}
  .term-real{width:356px;height:116px;border-radius:8px;display:block;margin-top:2px}
  .rail-bottom .circle{width:${railIcon + 10}px;height:${railIcon + 10}px}
  .rail-bottom .circle svg{width:${railIcon}px;height:${railIcon}px;display:block}
  .rail-bottom .ava{background:none;overflow:visible;position:relative}
  .rail-bottom .ava img{width:100%;height:100%;object-fit:cover;display:block;border-radius:9px}
  .rail-bottom .pdot{position:absolute;right:-3px;bottom:-3px;width:12px;height:12px;border-radius:50%;background:#1eb183;border:2.5px solid var(--rail)}
  .ws-ava{background:none!important}
  .ws-ava img{width:100%;height:100%;object-fit:cover;display:block}
</style>`;
html = html.replace("</style>", inject);
// roomier rail to match native pitch (~65px) + workspace icon up top
html = html.replace(
  ".rail{width:70px;background:var(--rail);flex:0 0 70px;display:flex;flex-direction:column;\n    align-items:center;padding-top:12px;gap:2px}",
  ".rail{width:70px;background:var(--rail);flex:0 0 70px;display:flex;flex-direction:column;\n    align-items:center;padding-top:6px;gap:15px}"
);
html = html.replace(
  ".rail-item{width:50px;display:flex;flex-direction:column;align-items:center;gap:2px;\n    padding:1px 0 2px;border-radius:8px;color:#cdbcd2;font-size:11px;font-weight:700}",
  ".rail-item{width:50px;display:flex;flex-direction:column;align-items:center;gap:2px;\n    padding:6px 0;border-radius:8px;color:#cdbcd2;font-size:11px;font-weight:700}"
);

// 2) Terminal screenshot → real thumbnail image.
html = html.replace(
  /<div class="term-img">[\s\S]*?\+ ALT<\/div>\s*<\/div>/,
  `<img class="term-real" src="assets/img/${AV.terminal}" alt="image.png">`
);

// 3) Avatars → real images (resolved by identity from the manifest).
const img = (f, extra = "") => `<img src="assets/img/${f}"${extra ? " " + extra : ""}>`;
html = html
  .replace('<div class="conv-ava">🐧<span class="dot"></span></div>',
           `<div class="conv-ava">${img(AV.ishan)}<span class="dot"></span></div>`)
  .replaceAll('<div class="av" style="background:#dfe3e6">🐧</div>',
              `<div class="av">${img(AV.ishan)}</div>`)
  .replaceAll('<div class="av" style="background:linear-gradient(135deg,#f3d9a0,#d94c8e)"></div>',
              `<div class="av">${img(AV.anishka)}</div>`)
  .replace('<span class="dm-ava" style="background:#dfe3e6">🐧<span class="dot"></span></span>',
           `<span class="dm-ava">${img(AV.ishan)}<span class="dot"></span></span>`)
  .replace('<span class="dm-ava" style="background:linear-gradient(135deg,#f3d9a0,#d94c8e)">🧑</span>',
           `<span class="dm-ava">${img(AV.naman)}</span>`)
  .replace('<span class="dm-ava" style="background:#4a90d9">A<span class="badge">3</span></span>',
           `<span class="dm-ava">${img(AV.ashutosh)}</span>`)   // no unread badge (reverted)
  .replace('<span class="dm-ava" style="background:#9b59b6">N</span>',
           `<span class="dm-ava">${img(AV.naverdo)}</span>`);

// 4) Rail workspace icon at the very top.
html = html.replace(
  '<div class="rail">\n      <div class="rail-item active">',
  `<div class="rail">\n      <div class="rail-ws">${img(AV.workspace)}</div>\n      <div class="rail-item active">`
);

// 4b) Rail-bottom profile photo + search-bar Slackbot AI icon (were gradient placeholders).
//     Both resolved from the manifest by label (AV.anishka / AV.slackbotAI). The
//     harvester now captures the Slackbot icon tight via its painted-box rect, so
//     there is no manual crop — re-running the extraction reproduces it.
html = html
  .replace('<div class="ava"></div>',
           `<div class="ava">${img(AV.anishka)}<span class="pdot"></span></div>`)
  .replace('<div class="ws-ava"></div>',
           `<div class="ws-ava">${img(AV.slackbotAI)}</div>`);

// 5) Replace hand-drawn <svg> blocks in document order (null = keep hand-drawn).
const order = [
  // top bar (7)
  "sidebar-left", "arrow-left", "arrow-right", "clock", "search", "add-bot", "help-icon",
  // rail (7): home, dms, activity, files, more, +(bottom), moon
  "home-filled", "direct-messages", "notifications", "canvas-browser", "ellipsis-horizontal-filled",
  "plus", "moon",
  // ws header (2)
  "settings", "compose",
  // sidebar nav + starred + locks (7) — not harvested distinctly → keep
  null, null, null, null, null, null, null,
  // conv header (6): star, headphones, caret, bell(keep), search, kebab
  "star", "headphones", "caret-down", null, "search", "ellipsis-vertical-filled",
  // tabs (3): messages, add-canvas, files(keep)
  "message-filled", "add-channel-canvas", null,
  // composer fmt (6): link, ol, ul, quote, code, code-block
  "link", "numbered-list", "bulleted-list", "quote", "code", "code-block",
  // composer toolbar (9): plus, formatting, emoji, mentions, video, mic, slash, send, send-caret(keep)
  "plus", "formatting", "emoji", "mentions", "video", "microphone", "slash-box", "send-filled", null,
];
let i = 0, swapped = 0;
html = html.replace(/<svg[\s\S]*?<\/svg>/g, (m) => {
  const name = order[i++];
  if (!name) return m;
  const real = ic(name);
  if (!real) return m;
  swapped++;
  return real;
});
console.log(`svg blocks seen: ${i}, swapped: ${swapped} (order entries: ${order.length})`);

// 6) Semantic markup (platform-agnostic, via _shared/role-map.json): turn each
//    interactive container into a REAL element. Icon containers (single <svg>) ->
//    <button>; rail nav items + conversation tabs -> <button role="tab">. The real
//    SVG/text stays inside. Static (no JS); aria-selected/labels set at build time.
const BTN = tagOf("button"), TAB = tagOf("tab"), TABATTR = attrOf("tab");  // button, button + role=tab
let semBtn = 0, semTab = 0;
// leaf icon/text buttons (single-level container: one <svg> or a glyph like B/I/U/S).
// content-agnostic but guarded against a nested <div> so we only convert leaves.
for (const k of ["tb-icon", "fmt-btn", "tb-btn", "pill-btn", "icon-btn", "circle", "gear", "pencil"]) {
  const re = new RegExp(`<div class="(${k})"((?:\\s+[a-z-]+="[^"]*")*)>((?:(?!<div)[\\s\\S])*?)<\\/div>`, "g");
  html = html.replace(re, (_m, cls, attrs, inner) => {
    semBtn++;
    const dq = (inner.match(/data-qa="([^"]+)"/) || [])[1];
    const al = dq ? ` aria-label="${dq.replace(/[-_]/g, " ")}"` : "";
    return `<${BTN} type="button" class="${cls}"${attrs}${al}>${inner}</${BTN}>`;
  });
}
// rail nav items (icon box + text label) -> button role=tab
html = html.replace(/<div class="(rail-item[^"]*)">(<div class="ricon">[\s\S]*?<\/div>[^<]*)<\/div>/g,
  (_m, cls, inner) => {
    semTab++;
    const txt = ((inner.match(/<\/div>([^<]*)$/) || [])[1] || "").trim();
    const sel = /\bactive\b/.test(cls) ? "true" : "false";
    return `<${TAB} type="button" class="${cls}" ${TABATTR} aria-selected="${sel}"${txt ? ` aria-label="${txt}"` : ""}>${inner}</${TAB}>`;
  });
// conversation tabs (Messages / Files / +) -> button role=tab  (not the `.tabs` container)
html = html.replace(/<div class="(tab(?: active| plus)?)">([\s\S]*?)<\/div>/g,
  (_m, cls, inner) => {
    semTab++;
    const sel = /\bactive\b/.test(cls) ? "true" : "false";
    return `<${TAB} type="button" class="${cls}" ${TABATTR} aria-selected="${sel}">${inner}</${TAB}>`;
  });
console.log(`semantic: ${semBtn} icon <button>, ${semTab} role=tab`);

fs.writeFileSync(path.join(here, "index.html"), html);
console.log("wrote index.html (backup: index-v9-handdrawn.html)");
