/**
 * Cheater — font fidelity harness.
 *
 * Answers one question per font family: does the EXPORT render text with the
 * same font the original used?
 *
 * Declarations are not evidence. A `font-family: "Playfair Display"` that never
 * loads still reports that family in getComputedStyle while silently rendering
 * in Georgia. So the check here is RENDERED TEXT WIDTH: measure the same string
 * in the original and in the export, and require the widths to match. Different
 * font file, different advance widths, different total — there is nowhere to hide.
 *
 * Also verifies the routing decision per family:
 *   Google-hosted   -> LINKED in the export (small file, no zip needed)
 *   self-hosted     -> BUNDLED as a binary (zip required for offline)
 *   system/generic  -> neither (never fetched)
 *   nonexistent     -> costs nothing, breaks nothing, reported as not loadable
 *
 * Run: browser_run_code_unsafe { filename: "test/run-fonts.js" }
 * (serve the repo first: python3 -m http.server 8931 --bind 127.0.0.1)
 */

async (page) => {
  const BASE = 'http://127.0.0.1:8931';

  await page.addInitScript(() => {
    window.chrome = {
      runtime: { onMessage: { addListener() {} }, sendMessage(_m, cb) { cb && cb({ ok: true }); },
                 getManifest: () => ({ version: '3.1.0' }), lastError: null },
      storage: { sync: { get(d, cb) { cb(d || {}); }, set(_v, cb) { cb && cb(); } },
                 session: { get(_k, cb) { cb({}); }, set(_v, cb) { cb && cb(); }, remove(_k, cb) { cb && cb(); } } }
    };
  });

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(BASE + '/test/fixtures.html');
  // Webfonts must be fully loaded before measuring anything.
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1200);
  for (const s of ['lib/reset.js', 'contentScript.js', 'lib/html-writer.js']) {
    await page.addScriptTag({ url: BASE + '/' + s + '?v=' + Date.now() });
  }

  const TARGETS = [
    { key: 'f-serif',    family: 'Playfair Display', route: 'link' },
    { key: 'f-serif-i',  family: 'Playfair Display', route: 'link' },
    { key: 'f-mono',     family: 'JetBrains Mono',   route: 'link' },
    { key: 'f-mono-b',   family: 'JetBrains Mono',   route: 'link' },
    { key: 'f-var',      family: 'Roboto Slab',      route: 'link' },
    { key: 'f-selfhost', family: 'Fixture Sans',     route: 'bundle' },
    { key: 'f-missing',  family: 'Fixture Sans',     route: 'bundle' },
    { key: 'f-system',   family: null,               route: 'none' }
  ];

  // Original: computed font + rendered width of each sample.
  const original = await page.evaluate((keys) => {
    const out = {};
    for (const k of keys) {
      const el = document.querySelector(`[data-test="${k}"]`);
      const cs = getComputedStyle(el);
      const range = document.createRange();
      range.selectNodeContents(el);
      out[k] = {
        text: el.textContent.trim(),
        family: cs.fontFamily,
        size: cs.fontSize,
        weight: cs.fontWeight,
        style: cs.fontStyle,
        // Range width measures the glyph run itself, not the block box.
        textWidth: Math.round(range.getBoundingClientRect().width * 100) / 100
      };
    }
    return out;
  }, TARGETS.map((t) => t.key));

  // Capture the whole font section once, with the service worker's font fetch
  // emulated so the inline (preview) path has real binaries.
  const bundle = await page.evaluate(async () => {
    const C = window.__cheater;
    C.activate();
    C.clearSelection();
    await C.addSelection(document.querySelector('[data-test="font-row"]'), true);
    const payload = C.buildPayload();
    C.deactivate();

    const toB64 = (buf) => {
      const b = new Uint8Array(buf); let s = '';
      for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
      return btoa(s);
    };
    payload.fontBinaries = [];
    for (const f of payload.fontFaces) {
      if (f.inline) continue;
      try {
        const r = await fetch(f.url);
        const buf = await r.arrayBuffer();
        payload.fontBinaries.push({ url: f.url, ok: true, base64: toB64(buf), mime: f.mime, bytes: buf.byteLength });
      } catch (e) {
        payload.fontBinaries.push({ url: f.url, ok: false, error: String(e) });
      }
    }
    return {
      previewHtml: window.CheaterHtmlWriter.build(payload, { fontMode: 'inline' }),
      savedHtml: window.CheaterHtmlWriter.build(payload, { fontMode: 'relative' }),
      googleLinked: (payload.fonts.google || []).map((g) => ({
        family: g.family, weights: g.weights, italics: g.italics, confirmed: !!g.confirmed
      })),
      bundledFamilies: payload.fontFaces.map((f) => ({ family: f.family, path: f.path, bytes: 0 })),
      fetched: payload.fontBinaries.map((b) => ({ ok: b.ok, bytes: b.bytes || 0 })),
      primary: payload.fonts.primary,
      primaryLoadable: payload.fonts.primaryLoadable
    };
  });

  // Measure the same samples inside the rendered export.
  const measureExport = async (html, label) => {
    const p2 = await page.context().newPage();
    await p2.setViewportSize({ width: 1280, height: 900 });
    await p2.setContent(html, { waitUntil: 'load' });
    await p2.evaluate(() => document.fonts.ready);
    await p2.waitForTimeout(1500);
    const measured = await p2.evaluate((keys) => {
      const out = {};
      // The export has no data-test attributes stripped, so the samples are still
      // addressable; fall back to matching on text if a key is missing.
      for (const k of keys) {
        let el = document.querySelector(`[data-test="${k}"]`);
        if (!el) { out[k] = null; continue; }
        const cs = getComputedStyle(el);
        const range = document.createRange();
        range.selectNodeContents(el);
        const first = cs.fontFamily.split(',')[0].replace(/^["']|["']$/g, '').trim();
        out[k] = {
          family: cs.fontFamily,
          size: cs.fontSize,
          weight: cs.fontWeight,
          style: cs.fontStyle,
          textWidth: Math.round(range.getBoundingClientRect().width * 100) / 100,
          // Did the family actually load in this document?
          loaded: document.fonts.check(`${cs.fontStyle === 'italic' ? 'italic ' : ''}${cs.fontWeight} 16px "${first}"`)
        };
      }
      return out;
    }, TARGETS.map((t) => t.key));
    await p2.close();
    return { label, measured };
  };

  const preview = await measureExport(bundle.previewHtml, 'preview(inline fonts)');
  const saved = await measureExport(bundle.savedHtml, 'saved(relative paths, fonts NOT unzipped)');

  /* ------------------------------------------------------------- assertions */
  const results = [];
  const ok = (name, pass, detail) => results.push({ name, pass: !!pass, detail: pass ? '' : String(detail ?? '') });

  for (const t of TARGETS) {
    const o = original[t.key];
    const p = preview.measured[t.key];
    if (!p) { ok(`${t.key}: present in export`, false, 'sample missing from export'); continue; }

    const drift = Math.abs(p.textWidth - o.textWidth);
    ok(`font ${t.key}: rendered text width matches original (${o.textWidth}px)`,
      drift <= 0.5, `original ${o.textWidth}px vs export ${p.textWidth}px (drift ${drift.toFixed(2)}px)`);

    ok(`font ${t.key}: same family/size/weight/style declared`,
      p.family === o.family && p.size === o.size && p.weight === o.weight && p.style === o.style,
      `orig ${o.family} ${o.size}/${o.weight}/${o.style} vs exp ${p.family} ${p.size}/${p.weight}/${p.style}`);

    if (t.family) {
      ok(`font ${t.key}: "${t.family}" actually loaded in the export`, p.loaded,
        'document.fonts.check() says the family is not available');
    }
  }

  // Routing: Google-hosted linked, self-hosted bundled.
  const linked = bundle.googleLinked.map((g) => g.family);
  const bundled = bundle.bundledFamilies.map((b) => b.family);

  ok('route: Google-hosted families are LINKED, not bundled',
    ['Playfair Display', 'JetBrains Mono', 'Roboto Slab'].every((f) => linked.includes(f)) &&
    !['Playfair Display', 'JetBrains Mono', 'Roboto Slab'].some((f) => bundled.includes(f)),
    `linked=${JSON.stringify(linked)} bundled=${JSON.stringify(bundled)}`);

  ok('route: self-hosted family is BUNDLED as a binary',
    bundled.includes('Fixture Sans') && !linked.includes('Fixture Sans'),
    `linked=${JSON.stringify(linked)} bundled=${JSON.stringify(bundled)}`);

  ok('route: system/generic families never requested',
    !linked.some((f) => /^(system-ui|-apple-system|Segoe UI|Roboto|Arial|sans-serif|serif|monospace|Georgia|Menlo)$/i.test(f)),
    JSON.stringify(linked));

  ok('route: a nonexistent family costs nothing and is never requested',
    !linked.includes('Absolutely Proprietary Grotesk') && !bundled.includes('Absolutely Proprietary Grotesk'),
    JSON.stringify(linked));

  ok('route: italic variant recorded for the family that uses one',
    bundle.googleLinked.some((g) => g.family === 'Playfair Display' && g.italics.includes(true)),
    JSON.stringify(bundle.googleLinked.find((g) => g.family === 'Playfair Display')));

  ok('route: both weights recorded for the mono family',
    bundle.googleLinked.some((g) => g.family === 'JetBrains Mono' &&
      g.weights.includes(400) && g.weights.includes(700)),
    JSON.stringify(bundle.googleLinked.find((g) => g.family === 'JetBrains Mono')));

  ok('route: every Google link resolves (no HTTP 400 from a guessed family)',
    bundle.googleLinked.every((g) => g.confirmed),
    'unconfirmed: ' + JSON.stringify(bundle.googleLinked.filter((g) => !g.confirmed).map((g) => g.family)));

  ok('fetch: self-hosted binary fetched successfully',
    bundle.fetched.length > 0 && bundle.fetched.every((f) => f.ok && f.bytes > 1000),
    JSON.stringify(bundle.fetched));

  // The saved (un-unzipped) variant is EXPECTED to drift on bundled families —
  // that is exactly what the "unzip the fonts next to the saved HTML" note is for.
  const selfhostSaved = saved.measured['f-selfhost'];
  const selfhostPreview = preview.measured['f-selfhost'];
  ok('saved-without-fonts: bundled family drifts (proves the zip is load-bearing)',
    selfhostSaved && Math.abs(selfhostSaved.textWidth - original['f-selfhost'].textWidth) > 0.5,
    `saved ${selfhostSaved && selfhostSaved.textWidth} vs original ${original['f-selfhost'].textWidth}`);
  ok('saved-without-fonts: LINKED families still match exactly (no zip needed)',
    Math.abs(saved.measured['f-serif'].textWidth - original['f-serif'].textWidth) <= 0.5 &&
    Math.abs(saved.measured['f-mono'].textWidth - original['f-mono'].textWidth) <= 0.5,
    `serif ${saved.measured['f-serif'].textWidth}/${original['f-serif'].textWidth}, mono ${saved.measured['f-mono'].textWidth}/${original['f-mono'].textWidth}`);
  ok('preview: inline binaries make the bundled family exact',
    selfhostPreview && Math.abs(selfhostPreview.textWidth - original['f-selfhost'].textWidth) <= 0.5,
    `preview ${selfhostPreview && selfhostPreview.textWidth} vs original ${original['f-selfhost'].textWidth}`);

  const failed = results.filter((r) => !r.pass);
  const lines = [
    `${results.length - failed.length}/${results.length} passed`,
    '',
    'primary font: ' + bundle.primary + '  loadable=' + bundle.primaryLoadable,
    'linked : ' + bundle.googleLinked.map((g) => `${g.family}[${g.weights.join(',')}${g.italics.includes(true) ? ',i' : ''}]`).join('  '),
    'bundled: ' + bundle.bundledFamilies.map((b) => b.path).join('  '),
    '',
    ...results.map((r) => `${r.pass ? '  ok  ' : '  FAIL'}  ${r.name}`)
  ];
  if (failed.length) {
    lines.push('', 'FAILURE DETAIL:');
    for (const f of failed) lines.push(`  ${f.name}\n    ${f.detail.slice(0, 400)}`);
  }
  return lines.join('\n');
}
