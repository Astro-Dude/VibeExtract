/**
 * Cheater — performance + progress harness.
 *
 * Reproduces the failure reported against YouTube Music: on a page with a very
 * large stylesheet, capture appeared to never finish. The cause was matching
 * every element against every CSS rule (O(elements x rules)); this measures that
 * the inverted index keeps it fast, that progress is actually reported for long
 * walks, and that the Polymer-shaped control bar is selectable and captured.
 *
 * Run: browser_run_code_unsafe { filename: "test/run-stress.js" }
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
  await page.goto(BASE + '/test/stress.html');
  await page.waitForTimeout(500);
  for (const s of ['lib/reset.js', 'contentScript.js', 'lib/html-writer.js', 'lib/toon-writer.js']) {
    await page.addScriptTag({ url: BASE + '/' + s + '?v=' + Date.now() });
  }

  const results = await page.evaluate(async () => {
    const C = window.__cheater;
    const out = [];
    const ok = (name, pass, detail) => out.push({ name, pass: !!pass, detail: pass ? '' : String(detail ?? '') });
    const q = (sel) => document.querySelector(`[data-test="${sel}"]`);
    const html = (p) => window.CheaterHtmlWriter.build(p, { fontMode: 'relative' });

    C.activate();

    const sheetRules = (() => {
      let n = 0;
      for (const sheet of document.styleSheets) {
        try { n += sheet.cssRules.length; } catch (_) { /* noop */ }
      }
      return n;
    })();
    ok('fixture: stylesheet is genuinely large', sheetRules > 8000, 'rules=' + sheetRules);

    /* ------------------------------------------ the reported YTM control bar */
    let barPayload = null;
    {
      // The icon <svg> is pointer-events:none, so a real pointer lands on the
      // wrapper div — start expansion from there, exactly as a click would.
      const iconDiv = q('ytm-buttons').querySelector('yt-icon div');
      ok('ytm: pointer lands on a real element, not the pointer-events:none svg',
        !!iconDiv && iconDiv.tagName.toLowerCase() === 'div', iconDiv && iconDiv.tagName);

      const target = C.smartExpand(iconDiv);
      ok('ytm: expansion reaches the button or the control row, not the page',
        target !== document.body && target !== document.documentElement &&
        q('ytm-window').contains(target),
        target ? target.tagName.toLowerCase() + '.' + (target.className || '') : 'null');

      const t0 = performance.now();
      C.clearSelection();
      await C.addSelection(q('ytm-buttons'), true);
      barPayload = C.buildPayload();
      const ms = performance.now() - t0;

      ok('ytm: control bar captured at all', !!barPayload && barPayload.nodes.length > 0,
        'payload=' + JSON.stringify(!!barPayload));
      ok('ytm: capture completes quickly despite the huge stylesheet (<2000ms)',
        ms < 2000, Math.round(ms) + 'ms');

      const source = html(barPayload);
      ok('ytm: all four icon buttons present',
        (source.match(/aria-label="/g) || []).length >= 4,
        (source.match(/aria-label="[^"]*"/g) || []).join(', '));
      ok('ytm: icon svg geometry survives', source.includes('<svg') && source.includes('M21 3a2 2'));
      ok('ytm: currentcolor fill resolved on the icon wrapper',
        /fill:\s*(#|rgb)/.test(source) || source.includes('fill="#'),
        (source.match(/fill[:=][^;"]{0,24}/g) || []).slice(0, 5).join(' | '));
      ok('ytm: button hover state captured from the huge sheet',
        barPayload.hovers.length > 0, 'hovers=' + barPayload.hovers.length);
    }

    /* ------------------------------------------------ progress on a big walk */
    {
      const samples = [];
      C.clearSelection();
      const t0 = performance.now();
      await C.captureRaw(document.body, { onProgress: (f) => samples.push(f) });
      const ms = performance.now() - t0;

      ok('progress: reported during a long capture', samples.length > 0, 'samples=' + samples.length);
      ok('progress: fractions are in range and non-decreasing',
        samples.every((f, i) => f >= 0 && f <= 1 && (i === 0 || f >= samples[i - 1])),
        JSON.stringify(samples.slice(0, 8).map((f) => Math.round(f * 100))));
      ok('progress: never claims 100% before finishing',
        samples.every((f) => f < 1), 'max=' + Math.max(...samples.map((f) => Math.round(f * 100))));
      ok('progress: full-body capture finishes in reasonable time (<8000ms)',
        ms < 8000, Math.round(ms) + 'ms');
      out.push({ name: `[timing] body capture ${Math.round(ms)}ms, ${samples.length} progress ticks, ` +
        `${sheetRules} css rules`, pass: true, detail: '' });
    }

    /* -------------------------------------------- yielding keeps UI responsive */
    {
      // If the walk never yielded, no timer could fire during it.
      let ticks = 0;
      const timer = setInterval(() => { ticks += 1; }, 10);
      await C.captureRaw(q('deep-tree'), { onProgress: () => {} });
      clearInterval(timer);
      ok('yield: the page event loop runs during capture (not frozen)', ticks > 0, 'ticks=' + ticks);
    }

    /* --------------------------------------------- guard against overlap */
    {
      C.clearSelection();
      const first = C.addSelection(q('deep-tree'), true);
      const second = C.addSelection(q('ytm-buttons'), true);   // must be ignored
      await Promise.all([first, second]);
      ok('overlap: a second capture during one in flight is rejected, not interleaved',
        C.state.selections.length === 1, 'selections=' + C.state.selections.length);
    }

    /* --------------------------------------------- wheel gating */
    {
      C.clearSelection();
      await C.addSelection(q('ytm-buttons'), true);
      C.state.hovered = q('ytm-buttons');
      ok('wheel: plain scroll over the selection walks the tree',
        C.shouldWalkOnWheel({ altKey: false }) === true);
      C.state.hovered = q('deep-tree');
      ok('wheel: plain scroll elsewhere leaves the page scrollable',
        C.shouldWalkOnWheel({ altKey: false }) === false);
      ok('wheel: Alt+scroll always walks', C.shouldWalkOnWheel({ altKey: true }) === true);
    }

    /* --------------------------------------------- Alt+Arrow follows selection */
    {
      C.clearSelection();
      const start = q('deep-tree').firstElementChild;
      await C.addSelection(start, true);
      const selected = C.state.selections[0].el;

      // Move the mouse somewhere unrelated; the arrows must ignore it.
      C.state.hovered = q('ytm-window');
      ok('nav: subject is the selection, not the hovered element',
        C.nav.subject() === selected,
        'subject=' + (C.nav.subject() && C.nav.subject().className));

      C.nav.anchor(C.nav.subject());
      const up = C.nav.up();
      ok('nav: Alt+Up from the selection reaches its parent',
        up === selected.parentElement, up && up.className);
      const down = C.nav.down();
      ok('nav: Alt+Down returns to the original selection', down === selected, down && down.className);
    }

    C.deactivate();
    return out;
  });

  const failed = results.filter((r) => !r.pass);
  const lines = [
    `${results.length - failed.length}/${results.length} passed`,
    ...results.map((r) => `${r.pass ? '  ok  ' : '  FAIL'}  ${r.name}`)
  ];
  if (failed.length) {
    lines.push('', 'FAILURE DETAIL:');
    for (const f of failed) lines.push(`  ${f.name}\n    ${f.detail.slice(0, 400)}`);
  }
  return lines.join('\n');
}
