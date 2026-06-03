// Standalone CDP driver that runs ../../assetHarvester.js against the live Slack
// renderer and saves assets — mirrors the Rust `cdp::harvest_assets` so it
// validates the harvester end-to-end and produces the real assets.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const HARVESTER = fs.readFileSync(path.join(here, "../../assetHarvester.js"), "utf8");
const OUT = path.join(here, "assets");
fs.mkdirSync(path.join(OUT, "fonts"), { recursive: true });
fs.mkdirSync(path.join(OUT, "img"), { recursive: true });

const targets = await (await fetch("http://127.0.0.1:9222/json")).json();
const page = targets.find((t) => t.type === "page" && (t.url || "").includes("app.slack.com"))
  || targets.find((t) => t.type === "page");
if (!page) throw new Error("no Slack page target on :9222");
console.log("target:", page.title);

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
  }
});
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const i = ++id;
    pending.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
await new Promise((r) => ws.addEventListener("open", r));

await send("Runtime.enable");
await send("Page.enable");

const r = await send("Runtime.evaluate", {
  expression: HARVESTER,
  awaitPromise: true,
  returnByValue: true,
});
if (r.exceptionDetails) throw new Error("harvester threw: " + JSON.stringify(r.exceptionDetails));
const manifest = r.result.value;
const dpr = Math.max(1, manifest.dpr || 1);
console.log(`dpr=${dpr} fonts=${manifest.fonts.length} icons=${manifest.icons.length} images=${manifest.images.length}`);
if (manifest.warnings?.length) console.log("warnings:", manifest.warnings);

const slug = (s) =>
  (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);

// fonts
const fontsOut = [];
const usedF = new Set();
for (const f of manifest.fonts) {
  if (!f.base64) continue;
  const ext = { woff: "woff", opentype: "otf", truetype: "ttf" }[f.format] || "woff2";
  let stem = `${slug(f.family)}-${f.weight}-${slug(f.style)}`, name = stem, i = 1;
  while (usedF.has(name)) name = `${stem}-${i++}`;
  usedF.add(name);
  const file = path.join(OUT, "fonts", `${name}.${ext}`);
  fs.writeFileSync(file, Buffer.from(f.base64, "base64"));
  fontsOut.push({ family: f.family, weight: f.weight, style: f.style, format: f.format, file });
}

// images — capture clips for any the page fetch couldn't read
const imgsOut = [];
const usedI = new Set();
for (let i = 0; i < manifest.images.length; i++) {
  const im = manifest.images[i];
  let b64 = im.base64, mime = im.mime, via = "fetch";
  if (!b64 && im.rect && im.rect.w >= 1 && im.rect.h >= 1) {
    try {
      const shot = await send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: true,
        fromSurface: true,
        clip: { x: im.rect.x, y: im.rect.y, width: im.rect.w, height: im.rect.h, scale: dpr },
      });
      b64 = shot.data; mime = "image/png"; via = "captureScreenshot";
    } catch (e) { console.log("clip failed:", im.label, e.message); }
  }
  if (!b64) continue;
  const ext = /jpe?g/.test(mime) ? "jpg" : /webp/.test(mime) ? "webp" : /svg/.test(mime) ? "svg" : "png";
  let stem = slug(im.label) || `image-${i}`, name = stem, k = 1;
  while (usedI.has(name)) name = `${stem}-${k++}`;
  usedI.add(name);
  const file = path.join(OUT, "img", `${name}.${ext}`);
  fs.writeFileSync(file, Buffer.from(b64, "base64"));
  imgsOut.push({ label: im.label, file, rect: im.rect, via });
}

// svg icons (real inline SVG markup)
const iconsDir = path.join(OUT, "icons");
fs.mkdirSync(iconsDir, { recursive: true });
const svgOut = [];
const usedS = new Set();
for (const ic of manifest.svgIcons || []) {
  let stem = slug(ic.name) || "icon", name = stem, j = 1;
  while (usedS.has(name)) name = `${stem}-${j++}`;
  usedS.add(name);
  const file = path.join(iconsDir, `${name}.svg`);
  fs.writeFileSync(file, ic.outerHTML);
  svgOut.push({ name: ic.name, label: ic.label, viewBox: ic.viewBox, color: ic.color, file, rect: ic.rect });
}

const out = { dpr, fonts: fontsOut, icons: manifest.icons, svgIcons: svgOut, images: imgsOut };
fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(out, null, 2));
console.log("\nFONTS:"); fontsOut.forEach((f) => console.log(" ", f.family, f.weight, f.style, "->", path.basename(f.file)));
console.log("\nSVG ICONS:"); svgOut.forEach((s) => console.log(" ", s.name, JSON.stringify(s.rect), "color", s.color, "->", path.basename(s.file)));
console.log("\nIMAGES:"); imgsOut.forEach((im) => console.log(" ", JSON.stringify(im.rect), im.via, "->", path.basename(im.file)));
console.log(`\nwrote ${fontsOut.length} fonts, ${svgOut.length} svg icons, ${imgsOut.length} images, ${manifest.icons.length} font glyphs to ${OUT}`);
ws.close();
