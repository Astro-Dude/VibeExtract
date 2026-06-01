// assetHarvester.js — runs inside a live Electron renderer via CDP
// `Runtime.evaluate({ expression: <this file>, awaitPromise: true, returnByValue: true })`.
//
// The whole file is ONE expression that evaluates to a Promise resolving to a
// JSON-serializable manifest of pixel-perfect assets:
//
//   {
//     dpr, viewport:{w,h},
//     fonts:  [{ family, weight, style, format, base64 }],   // @font-face binaries (incl. icon fonts)
//     icons:  [{ className, char, codepoint, fontFamily, label, count }], // rendered glyphs
//     images: [{ label, tag, src, mime, base64?, rect:{x,y,w,h} }],       // <img> + background-image
//   }
//
// Images that the in-page fetch can't read (cross-origin CDN assets with no
// CORS headers) come back WITHOUT base64 but WITH a `rect`; the Rust caller then
// fills them in via CDP `Page.captureScreenshot` clip. Everything is wrapped in
// try/catch so one bad asset never aborts the whole harvest.
(async () => {
  "use strict";

  const out = {
    dpr: window.devicePixelRatio || 1,
    viewport: { w: window.innerWidth, h: window.innerHeight },
    fonts: [],
    icons: [],
    svgIcons: [],
    images: [],
    warnings: [],
  };

  const u8ToB64 = (buf) => {
    const bytes = new Uint8Array(buf);
    let bin = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  };

  const classOf = (el) => {
    const c = el.className;
    if (typeof c === "string") return c;
    return el.getAttribute && el.getAttribute("class") ? el.getAttribute("class") : "";
  };

  const labelOf = (el) => {
    try {
      const direct =
        el.getAttribute("aria-label") ||
        el.getAttribute("data-qa") ||
        el.getAttribute("title") ||
        el.getAttribute("alt");
      if (direct) return direct.trim();
      const anc = el.closest && el.closest("[aria-label],[data-qa],[title]");
      if (anc) {
        const a =
          anc.getAttribute("aria-label") ||
          anc.getAttribute("data-qa") ||
          anc.getAttribute("title");
        if (a) return a.trim();
      }
      const txt = (el.textContent || "").trim();
      if (txt) return txt.slice(0, 48);
    } catch (_) {}
    return "";
  };

  // ---- FONTS: every @font-face binary (icon fonts + text fonts) ----------
  try {
    const seen = new Set();
    const faces = [];
    for (const sheet of document.styleSheets) {
      let rules;
      try { rules = sheet.cssRules; } catch (_) { continue; } // cross-origin sheet
      if (!rules) continue;
      for (const rule of rules) {
        if (rule.type !== 5 && rule.constructor.name !== "CSSFontFaceRule") continue;
        const family = (rule.style.fontFamily || "").replace(/^["']|["']$/g, "");
        if (!family) continue;
        const src = rule.style.src || "";
        const matches = [...src.matchAll(
          /url\(\s*["']?([^"')]+)["']?\s*\)\s*(?:format\(\s*["']?([^"')]+)["']?\s*\))?/gi
        )];
        if (!matches.length) continue;
        const fmtOf = (declared, url) => {
          const d = (declared || "").toLowerCase();
          if (["woff2", "woff", "opentype", "truetype"].includes(d)) return d;
          const p = url.split("#")[0].split("?")[0].toLowerCase();
          if (p.endsWith(".woff2")) return "woff2";
          if (p.endsWith(".woff")) return "woff";
          if (p.endsWith(".otf")) return "opentype";
          if (p.endsWith(".ttf")) return "truetype";
          return "";
        };
        const ranked = matches
          .map((m) => {
            const url = m[1];
            const format = fmtOf(m[2], url);
            const score = { woff2: 4, woff: 3, opentype: 2, truetype: 1 }[format] || 0;
            return { url, format, score };
          })
          .filter((c) => c.score > 0)
          .sort((a, b) => b.score - a.score);
        if (!ranked.length) continue;
        const chosen = ranked[0];
        if (!chosen.url || chosen.url.startsWith("data:")) continue;
        const weight = (rule.style.fontWeight || "400").toString();
        const style = (rule.style.fontStyle || "normal").toString();
        let url = chosen.url;
        try { url = new URL(chosen.url, sheet.href || document.baseURI).href; } catch (_) {}
        const key = `${family.toLowerCase()}|${weight}|${style}|${url}`;
        if (seen.has(key)) continue;
        seen.add(key);
        faces.push({ family, weight, style, format: chosen.format, url });
      }
    }
    // Fetch the binaries (same-origin app:// assets resolve fine).
    const fetched = await Promise.all(
      faces.map(async (f) => {
        try {
          const buf = await (await fetch(f.url)).arrayBuffer();
          return { family: f.family, weight: f.weight, style: f.style, format: f.format, base64: u8ToB64(buf) };
        } catch (e) {
          out.warnings.push(`font fetch failed ${f.family}: ${e}`);
          return null;
        }
      })
    );
    out.fonts = fetched.filter(Boolean);
  } catch (e) {
    out.warnings.push(`fonts: ${e}`);
  }

  // ---- ICONS: rendered glyphs (icon fonts via ::before / ::after) --------
  try {
    const candidates = new Set();
    document.querySelectorAll('[class*="icon" i], i, [data-qa*="icon" i]').forEach((el) => candidates.add(el));
    // General sweep (bounded) so non-Slack apps also work.
    const all = document.querySelectorAll("*");
    for (let i = 0; i < all.length && i < 6000; i++) candidates.add(all[i]);

    const seen = new Set();
    for (const el of candidates) {
      if (out.icons.length >= 400) break;
      for (const pseudo of ["::before", "::after"]) {
        let cs;
        try { cs = getComputedStyle(el, pseudo); } catch (_) { continue; }
        let c = cs.content;
        if (!c || c === "none" || c === "normal") continue;
        c = c.replace(/^["']|["']$/g, "");
        if (!c) continue;
        const cp = c.codePointAt(0);
        // Private-use area = icon glyph (skip ordinary text content).
        if (!(cp >= 0xe000 && cp <= 0xf8ff)) continue;
        const className = classOf(el);
        const key = `${className}|${c}`;
        if (seen.has(key)) {
          const hit = out.icons.find((g) => g.className === className && g.char === c);
          if (hit) hit.count++;
          continue;
        }
        seen.add(key);
        out.icons.push({
          className,
          char: c,
          codepoint: cp.toString(16),
          fontFamily: (cs.fontFamily || "").replace(/^["']|["']$/g, ""),
          label: labelOf(el),
          count: 1,
        });
      }
    }
  } catch (e) {
    out.warnings.push(`icons: ${e}`);
  }

  // ---- SVG ICONS: inline <svg> (modern apps render icons as SVG) ---------
  try {
    const vw = window.innerWidth, vh = window.innerHeight;
    const byName = new Map();
    for (const svg of document.querySelectorAll("svg")) {
      if (byName.size >= 250) break;
      let r;
      try { r = svg.getBoundingClientRect(); } catch (_) { continue; }
      // icon-sized, on-screen (skip big illustrations/logos)
      if (r.width < 10 || r.width > 48 || r.height < 10 || r.height > 48) continue;
      if (r.bottom <= 0 || r.right <= 0 || r.top >= vh || r.left >= vw) continue;
      const host = svg.closest("[data-qa],[aria-label]");
      const label =
        (host && (host.getAttribute("aria-label") || host.getAttribute("data-qa"))) ||
        labelOf(svg) || "";
      // Prefer the svg's own data-qa as the stable icon name.
      const name = svg.getAttribute("data-qa") || label || "icon";
      if (byName.has(name)) continue;
      let color = "currentColor";
      try { color = getComputedStyle(svg).color || color; } catch (_) {}
      byName.set(name, {
        name,
        label,
        viewBox: svg.getAttribute("viewBox") || "",
        color,
        outerHTML: svg.outerHTML.slice(0, 8000),
        rect: {
          x: Math.round(r.left + window.scrollX),
          y: Math.round(r.top + window.scrollY),
          w: Math.round(r.width),
          h: Math.round(r.height),
        },
      });
    }
    out.svgIcons = [...byName.values()];
  } catch (e) {
    out.warnings.push(`svgIcons: ${e}`);
  }

  // ---- IMAGES: <img> + CSS background-image -------------------------------
  // A `Page.captureScreenshot` clip grabs the *visual* pixels at a rect, so an
  // element that's scrolled off-viewport or occluded yields neighbor garbage
  // (e.g. an avatar's first DOM occurrence sitting behind a header → captures
  // the header). So: only keep elements that are fully on-screen, laid out, and
  // topmost at their center; dedup by src keeping the LARGEST such occurrence.
  try {
    const vw = window.innerWidth, vh = window.innerHeight;

    // A meaningful label: nearest accessible name, else the enclosing row's
    // name (so a sidebar DM avatar reads "Naman Bhalla", not the generic
    // data-qa "channel-prefix-im-avatar").
    const bestLabel = (el) => {
      const named = el.closest("[aria-label]");
      if (named) { const a = (named.getAttribute("aria-label") || "").trim(); if (a) return a; }
      const row = el.closest("a,[role=listitem],button,[data-qa]");
      if (row) {
        const t = (row.getAttribute("data-qa") || row.textContent || "").replace(/\s+/g, " ").trim();
        if (t) return t.slice(0, 48);
      }
      return el.getAttribute("alt") || el.getAttribute("title") || "image";
    };

    // On-screen, laid out, and not occluded by another element at its center.
    const onScreenClean = (el, r) => {
      if (r.width < 8 || r.height < 8) return false;
      if (r.top < -1 || r.left < -1 || r.bottom > vh + 1 || r.right > vw + 1) return false;
      let cs; try { cs = getComputedStyle(el); } catch (_) { return false; }
      if (cs.visibility === "hidden" || cs.display === "none" || +cs.opacity === 0) return false;
      if (el.offsetParent === null && cs.position !== "fixed") return false;
      const cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
      let top; try { top = document.elementFromPoint(cx, cy); } catch (_) { return false; }
      if (!top) return false;
      return top === el || el.contains(top) || top.contains(el);
    };

    const bySrc = new Map();
    const consider = (el, src, tag) => {
      if (!src || src.startsWith("data:")) return;
      let r; try { r = el.getBoundingClientRect(); } catch (_) { return; }
      if (!onScreenClean(el, r)) return;
      const area = r.width * r.height;
      const prev = bySrc.get(src);
      if (prev && prev.area >= area) return; // keep the largest clean occurrence
      bySrc.set(src, {
        el, tag, src, area, label: bestLabel(el),
        rect: {
          x: Math.round(r.left + window.scrollX),
          y: Math.round(r.top + window.scrollY),
          w: Math.round(r.width),
          h: Math.round(r.height),
        },
      });
    };

    [...document.images].forEach((img) => consider(img, img.currentSrc || img.src, "img"));
    const all = document.querySelectorAll("*");
    for (let i = 0; i < all.length && i < 6000; i++) {
      const el = all[i];
      let bg;
      try { bg = getComputedStyle(el).backgroundImage; } catch (_) { continue; }
      if (!bg || bg === "none" || !bg.includes("url(")) continue;
      const m = bg.match(/url\(\s*["']?([^"')]+)["']?\s*\)/i);
      if (m) consider(el, m[1], "bg");
    }

    const entries = [...bySrc.values()].slice(0, 60);
    await Promise.all(
      entries.map(async (e) => {
        let mime, base64;
        try {
          const resp = await fetch(e.src, { credentials: "include" });
          if (resp.ok && resp.type !== "opaque") {
            const blob = await resp.blob();
            mime = blob.type || "image/png";
            base64 = u8ToB64(await blob.arrayBuffer());
          }
        } catch (_) { /* CORS-opaque CDN asset → Rust will screenshot-clip it */ }
        out.images.push({
          label: e.label || e.tag,
          tag: e.tag,
          src: e.src.slice(0, 300),
          mime,
          base64,
          rect: e.rect,
        });
      })
    );
  } catch (e) {
    out.warnings.push(`images: ${e}`);
  }

  return out;
})()
