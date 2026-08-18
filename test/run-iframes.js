/**
 * Cheater — iframe harness.
 *
 * Every iframe used to become a flat screenshot crop, same-origin ones included. It
 * looked right in the preview and carried no DOM at all, so the TOON handed an LLM a
 * placeholder and "rebuild this in React" had nothing to work from.
 *
 * A same-origin frame is readable and its content belongs in the export as real
 * markup, with its own stylesheets. A cross-origin frame genuinely cannot be read
 * from the parent, so pixels stay the honest fallback — and this suite checks the
 * line between the two is drawn in the right place, using a REAL second origin
 * (port 8932, served by the runner) rather than a simulated one.
 *
 * Run: node test/cdp-runner.js run-iframes
 */

async (page) => {
  const BASE = 'http://127.0.0.1:8931';

  await page.addInitScript(() => {
    window.chrome = {
      runtime: { onMessage: { addListener() {} }, sendMessage(_m, cb) { cb && cb({ ok: true }); },
                 getManifest: () => ({ version: '3.2.0' }), lastError: null },
      storage: { sync: { get(d, cb) { cb(d || {}); }, set(_v, cb) { cb && cb(); } },
                 session: { get(_k, cb) { cb({}); }, set(_v, cb) { cb && cb(); }, remove(_k, cb) { cb && cb(); } } }
    };
  });

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(BASE + '/test/iframes.html');
  // Frames load independently of the parent's load event.
  await page.waitForTimeout(900);
  for (const s of ['lib/reset.js', 'contentScript.js', 'lib/html-writer.js', 'lib/toon-writer.js']) {
    await page.addScriptTag({ url: BASE + '/' + s + '?v=' + Date.now() });
  }

  const results = await page.evaluate(async () => {
    const C = window.__cheater;
    const W = window.CheaterHtmlWriter;
    const out = [];
    const ok = (name, pass, detail) => out.push({ name, pass: !!pass, detail: pass ? '' : String(detail ?? '') });
    const q = (sel) => document.querySelector(`[data-test="${sel}"]`);
    const cap = async (el) => { C.clearSelection(); await C.addSelection(el, true); return C.buildPayload(); };
    const html = (p) => W.build(p, { fontMode: 'relative' });

    C.activate();

    /* ------------------------------------------------ srcdoc, with its own CSS */
    {
      const payload = await cap(q('frame-srcdoc-host'));
      const source = html(payload);
      const body = source.slice(source.indexOf('<body'));

      ok('srcdoc: the frame content is real markup in the export',
        body.includes('Subtotal') && body.includes('$267.84'),
        'frame content missing — it was probably flattened to pixels');
      ok('srcdoc: reported as inlined', payload.diagnostics.framesInlined >= 1,
        'framesInlined=' + payload.diagnostics.framesInlined);
      ok('srcdoc: NOT counted as a pixel fallback', !payload.diagnostics.framesPixels,
        'framesPixels=' + payload.diagnostics.framesPixels);
      ok('srcdoc: no placeholder label left behind', !body.includes('cross-origin iframe'));

      // The frame's own stylesheet is in a different document, so without treating
      // that document as a style scope the content would come out unstyled.
      ok('srcdoc: the frame\'s OWN stylesheet was captured',
        source.includes('#0f172a') || source.includes('rgb(15, 23, 42)'),
        'the frame body background from its own <style> is missing');
      ok('srcdoc: a frame-only class rule was captured',
        source.includes('#fbbf24') || source.includes('rgb(251, 191, 36)'),
        'the .total colour from inside the frame is missing');
      // Markup only: the reset stylesheet declares overflow of its own.
      ok('srcdoc: the box states its own overflow',
        /overflow:(hidden|auto)/.test(body), 'the frame box has no overflow at all');
      ok('srcdoc: exported as a div, not an empty <iframe>',
        !/<iframe/i.test(body), 'an <iframe> tag survived and would load the live URL');
      ok('srcdoc: the title became a label', source.includes('Pricing summary'));
    }

    /* ------------------------------------------- same-origin frame loaded by URL */
    {
      const payload = await cap(q('frame-same-host'));
      const source = html(payload);
      ok('same-origin: content inlined', source.includes('frame-child.html') &&
        source.includes('child frame'), 'frame content missing');
      ok('same-origin: the frame stylesheet came along',
        source.includes('#1d4ed8') || source.includes('rgb(29, 78, 216)'),
        'the badge colour from the child stylesheet is missing');
      ok('same-origin: a gradient inside the frame survived',
        source.includes('linear-gradient'), 'the swatch gradient is missing');
      ok('same-origin: reported as inlined', payload.diagnostics.framesInlined >= 1);
    }

    /* --------------------------------------------------- genuinely cross-origin */
    {
      // Nothing can read this from here. Pixels are the only truthful answer, and
      // it must degrade rather than throw or abort the capture.
      const frame = q('frame-cross');
      ok('cross-origin: the fixture really is unreadable', (() => {
        try { return !frame.contentDocument; } catch (_) { return true; }
      })(), 'the fixture is not actually cross-origin, so this proves nothing');

      const payload = await cap(q('frame-cross-host'));
      const source = html(payload);
      ok('cross-origin: capture still completes', !!payload && !!payload.nodes.length);
      ok('cross-origin: counted as a pixel fallback', payload.diagnostics.framesPixels >= 1,
        'framesPixels=' + payload.diagnostics.framesPixels);
      ok('cross-origin: not claimed as inlined', !payload.diagnostics.framesInlined,
        'framesInlined=' + payload.diagnostics.framesInlined);
      // Either recovered pixels or a labelled placeholder — never a silent blank.
      ok('cross-origin: says so, or shows the pixels',
        source.includes('cross-origin iframe') || payload.diagnostics.pixelsRecovered >= 1,
        'the frame became a silent empty box');
    }

    /* ----------------------------------------------------------- nested frames */
    {
      const payload = await cap(q('frame-nested-host'));
      const source = html(payload);
      ok('nested: the outer frame is inlined',
        source.includes('outer frame, holding another'), 'outer frame content missing');
      ok('nested: the INNER frame is inlined too',
        source.includes('child frame'), 'the frame inside the frame was not reached');
      ok('nested: both levels reported', payload.diagnostics.framesInlined >= 2,
        'framesInlined=' + payload.diagnostics.framesInlined);
      ok('nested: styles from both levels captured',
        (source.includes('#fefce8') || source.includes('rgb(254, 252, 232)')) &&
        (source.includes('#eff6ff') || source.includes('rgb(239, 246, 255)')),
        'a nested frame stylesheet is missing');
    }

    /* ------------------------------------------- about:blank written by script */
    {
      const payload = await cap(q('frame-blank-host'));
      const source = html(payload);
      ok('about:blank: script-written content is captured',
        source.includes('document.write'), 'the written frame content is missing');
      ok('about:blank: its inline stylesheet applied',
        source.includes('#ecfdf5') || source.includes('rgb(236, 253, 245)'),
        'the written frame background is missing');
    }

    /* ------------------------------ sandboxed frame: an opaque origin, unreadable */
    {
      // sandbox="" forces a unique origin, so a same-origin URL is still unreadable.
      // Worth its own case because the src looks readable and is not.
      const frame = q('frame-sandbox');
      ok('sandbox: the fixture really is unreadable', (() => {
        try { return !frame.contentDocument || !frame.contentDocument.body; } catch (_) { return true; }
      })(), 'the sandboxed frame is readable, so this proves nothing');

      const payload = await cap(q('frame-sandbox-host'));
      ok('sandbox: degrades to pixels rather than throwing',
        payload.diagnostics.framesPixels >= 1 || payload.diagnostics.pixelsRecovered >= 1,
        'framesPixels=' + payload.diagnostics.framesPixels);
    }

    /* ------------------------------------------------------------ scrolled frame */
    {
      // The frame is scrolled, so its content sits at a negative offset inside its
      // own viewport. Rects inside a frame are frame-relative, which is exactly the
      // trap: anything using them as page coordinates samples the wrong region.
      const payload = await cap(q('frame-scrolled-host'));
      const source = html(payload);
      ok('scrolled: content is captured despite the scroll offset',
        source.includes('band three'), 'the visible band is missing');
      ok('scrolled: scrolled-away content still captured as markup',
        source.includes('band one'),
        'content scrolled out of the frame viewport was dropped');
    }

    /* --------------------------------------------- a frame as the selection root */
    {
      // Selecting the iframe itself, not a container around it.
      const payload = await cap(q('frame-root'));
      const source = html(payload);
      ok('root: an iframe works as the capture root',
        source.includes('child frame'), 'selecting the frame itself captured nothing');
      ok('root: reported as inlined', payload.diagnostics.framesInlined >= 1);
    }

    /* ------------------------------------------------------------ the whole page */
    {
      // All eight frames at once: the readable ones inlined, the unreadable ones
      // degraded, and no exceptions in between.
      const payload = await cap(document.body);
      const source = html(payload);
      ok('page: every readable frame inlined', payload.diagnostics.framesInlined >= 6,
        'framesInlined=' + payload.diagnostics.framesInlined);
      ok('page: the unreadable ones degraded', payload.diagnostics.framesPixels >= 2,
        'framesPixels=' + payload.diagnostics.framesPixels);
      ok('page: no <iframe> tag survives in the export', !/<iframe/i.test(source),
        'an iframe tag would try to load the live URL from the saved file');
      ok('page: our own probe iframe never captured', !source.includes('cheater-probe'));
    }

    /* ------------------------------------------------------------------- TOON */
    {
      const payload = await cap(q('frame-srcdoc-host'));
      const toon = window.CheaterToonWriter.toToon(payload);
      ok('toon: frame content reaches the LLM handoff', toon.includes('$267.84'),
        'the frame is still a placeholder in the TOON — which was the whole problem');
      const reparsed = window.CheaterToonWriter.parseToon(toon);
      ok('toon: frame content round-trips through the parser',
        html(reparsed).includes('$267.84'));
    }

    /* ------------------- a whole document, taller than its frame ------------- */
    {
      // The complaint this covers: the frame content was all in the markup, and the
      // export box was a fixed rectangle with overflow:hidden, so everything past the
      // first screenful was unreachable.
      const frameEl = q('frame-doc');
      const inner = frameEl.contentDocument;
      const rowCount = inner.querySelectorAll('.row').length;
      const frameHeight = frameEl.getBoundingClientRect().height;
      const contentHeight = inner.documentElement.scrollHeight;
      ok('whole doc: the fixture content really overflows its frame',
        contentHeight > frameHeight * 1.5,
        'content ' + contentHeight + 'px in a ' + Math.round(frameHeight) + 'px frame');

      const payload = await cap(q('frame-doc-host'));
      const source = html(payload);

      // Every row, not just the visible ones.
      const missing = [];
      for (let i = 1; i <= rowCount; i += 1) {
        const label = 'value-' + String(i).padStart(2, '0');
        if (!source.includes(label)) missing.push(label);
      }
      ok('whole doc: every one of the ' + rowCount + ' rows is captured',
        missing.length === 0, 'missing: ' + missing.join(', '));
      ok('whole doc: the header is captured', source.includes('Full document inside a frame'));
      ok('whole doc: the FOOTER past the fold is captured',
        source.includes('end of document'), 'the last element was dropped');
      // Scoped to the markup: lib/reset.js contains `overflow:auto` of its own, so
      // testing the whole document would pass regardless of what the frame got.
      const docBody = source.slice(source.indexOf('<body'));
      ok('whole doc: the frame box is scrollable, not clipped',
        /overflow:auto/.test(docBody), 'overflow is not auto, so the rest is unreachable');
      // The frame paints its backdrop on <html>, not <body>. CSS propagates that to
      // the canvas — and there is no canvas once the frame becomes a div, so it has
      // to be carried onto the box explicitly or the frame renders transparent and
      // the host page shows through.
      ok('whole doc: the <html> backdrop came along',
        source.includes('#1e1b4b') || source.includes('rgb(30, 27, 75)'),
        'the frame document background from <html> is missing');

      // Behavioural: render it and confirm the box really does scroll.
      const view = document.createElement('iframe');
      view.setAttribute('sandbox', 'allow-same-origin');
      view.style.cssText = 'position:fixed;left:-9999px;top:0;width:900px;height:700px;border:0';
      view.srcdoc = source;
      document.body.appendChild(view);
      await new Promise((resolve) => { view.onload = resolve; });
      const doc2 = view.contentDocument;
      const box = doc2.querySelector('[aria-label="Whole document"]');
      ok('whole doc: the frame box exists in the export', !!box);
      if (box) {
        const cs = doc2.defaultView.getComputedStyle(box);
        ok('whole doc: computed overflow allows scrolling',
          cs.overflowY === 'auto' || cs.overflowY === 'scroll', 'overflow-y=' + cs.overflowY);
        ok('whole doc: there is genuinely more content than box',
          box.scrollHeight > box.clientHeight + 10,
          'scrollHeight=' + box.scrollHeight + ' clientHeight=' + box.clientHeight);
        // Scroll it and confirm the far end of the document is reachable.
        box.scrollTop = box.scrollHeight;
        ok('whole doc: scrolling actually moves', box.scrollTop > 10, 'scrollTop=' + box.scrollTop);
        const footer = Array.from(box.querySelectorAll('*'))
          .find((n) => n.textContent.trim().startsWith('end of document'));
        ok('whole doc: the footer is reachable by scrolling', !!footer &&
          footer.getBoundingClientRect().bottom <= box.getBoundingClientRect().bottom + 2 &&
          footer.getBoundingClientRect().top >= box.getBoundingClientRect().top - 2,
          'the footer never comes into view');
      }
      view.remove();
    }

    /* ------------------- a frame that is MEANT to be clipped ----------------- */
    {
      // scrolling="no" is deliberate. Handing it a scrollbar would invent behaviour.
      const frameEl = q('frame-scrolled');
      frameEl.setAttribute('scrolling', 'no');
      const payload = await cap(q('frame-scrolled-host'));
      const source = html(payload);
      const clippedBody = source.slice(source.indexOf('<body'));
      ok('clipped: scrolling="no" stays hidden, not auto',
        /overflow:hidden/.test(clippedBody) && !/overflow:auto/.test(clippedBody),
        (clippedBody.match(/overflow:[a-z]+/g) || ['none found']).join(' '));
      ok('clipped: its content is still all captured',
        source.includes('band one') && source.includes('band four'));

      // Confirm in a render, not just in the text.
      const cview = document.createElement('iframe');
      cview.setAttribute('sandbox', 'allow-same-origin');
      cview.style.cssText = 'position:fixed;left:-9999px;top:0;width:800px;height:500px;border:0';
      cview.srcdoc = source;
      document.body.appendChild(cview);
      await new Promise((resolve) => { cview.onload = resolve; });
      const cbox = cview.contentDocument.querySelector('[aria-label="Scrolled"]');
      ok('clipped: renders with overflow hidden', !!cbox &&
        cview.contentDocument.defaultView.getComputedStyle(cbox).overflowY === 'hidden',
        cbox ? cview.contentDocument.defaultView.getComputedStyle(cbox).overflowY : 'box missing');
      cview.remove();
      frameEl.removeAttribute('scrolling');
    }

    /* ------------------------------------------------------------- fidelity */
    {
      // Markup being present proves nothing about whether it LOOKS right. Compare
      // the same element's computed style in the original frame and in the export.
      const payload = await cap(q('frame-same-host'));
      const source = html(payload);

      const frame = document.createElement('iframe');
      frame.setAttribute('sandbox', 'allow-same-origin');
      frame.style.cssText = 'position:fixed;left:-9999px;top:0;width:900px;height:600px;border:0';
      frame.srcdoc = source;
      document.body.appendChild(frame);
      await new Promise((resolve) => { frame.onload = resolve; });

      const original = q('frame-same').contentDocument;
      const exported = frame.contentDocument;
      // The capture replaces class names with generated style classes, so elements
      // are located by their text instead — deepest match, so we get the leaf that
      // actually carries the styling rather than an ancestor.
      const byText = (doc, text) => {
        const hits = Array.from(doc.querySelectorAll('*'))
          .filter((el) => el.textContent.trim() === text);
        return hits.length ? hits[hits.length - 1] : null;
      };
      const style = (doc, el, prop) => doc.defaultView.getComputedStyle(el)[prop];

      const cases = [
        ['badge', () => byText(original, 'child frame'), () => byText(exported, 'child frame'), 'backgroundColor'],
        ['badge', () => byText(original, 'child frame'), () => byText(exported, 'child frame'), 'borderTopLeftRadius'],
        ['badge', () => byText(original, 'child frame'), () => byText(exported, 'child frame'), 'fontSize'],
        ['badge', () => byText(original, 'child frame'), () => byText(exported, 'child frame'), 'paddingLeft'],
        ['mono label', () => byText(original, 'frame-child.html'), () => byText(exported, 'frame-child.html'), 'fontFamily'],
        ['mono label', () => byText(original, 'frame-child.html'), () => byText(exported, 'frame-child.html'), 'color'],
        ['swatch', () => byText(original, 'frame-child.html').previousElementSibling,
          () => byText(exported, 'frame-child.html').previousElementSibling, 'backgroundImage'],
        ['swatch', () => byText(original, 'frame-child.html').previousElementSibling,
          () => byText(exported, 'frame-child.html').previousElementSibling, 'width'],
        ['frame body', () => original.body,
          // In the export the frame's body becomes a div; find it by its label.
          () => exported.querySelector('[aria-label="Same origin child"]').firstElementChild,
          'backgroundColor'],
        ['frame body', () => original.body,
          () => exported.querySelector('[aria-label="Same origin child"]').firstElementChild,
          'paddingTop']
      ];
      for (const [label, getA, getB, prop] of cases) {
        let a = null; let b = null;
        try { a = getA(); b = getB(); } catch (_) { /* reported below */ }
        if (!a || !b) { ok(`fidelity: ${label} found in both`, false, 'orig=' + !!a + ' export=' + !!b); continue; }
        const av = style(original, a, prop);
        const bv = style(exported, b, prop);
        ok(`fidelity: ${label} ${prop} matches the original`, av === bv, av + ' vs ' + bv);
      }

      // The frame's own body styling must NOT have leaked onto the export's <body>:
      // a nested <body> tag is discarded by the parser and its attributes merged up,
      // which would tint the whole page with the frame's background.
      ok('fidelity: the frame body did not leak onto the export body',
        style(exported, exported.body, 'backgroundColor') !==
          style(original, original.body, 'backgroundColor'),
        'export body took the frame background: ' + style(exported, exported.body, 'backgroundColor'));
      ok('fidelity: no nested <body> in the export', exported.querySelectorAll('body').length === 1,
        'found ' + exported.querySelectorAll('body').length + ' body elements');

      // Rendered text width is the strictest check: a different font or size shows
      // up here even when the declarations happen to look similar.
      const measure = (doc, el) => {
        const range = doc.createRange();
        range.selectNodeContents(el);
        return Math.round(range.getBoundingClientRect().width * 10) / 10;
      };
      const wa = measure(original, byText(original, 'frame-child.html'));
      const wb = measure(exported, byText(exported, 'frame-child.html'));
      ok('fidelity: rendered text width matches (' + wa + 'px)', Math.abs(wa - wb) < 1,
        wa + ' vs ' + wb);

      frame.remove();
    }

    C.deactivate();
    return out;
  });

  /* ============ a hover card INSIDE a frame ================================= */
  // composedPath() does not cross a frame boundary, so the top frame sees no hover
  // at all when the cursor is inside an iframe: no state.hovered, no pointer, and
  // its MutationObserver never sees the card because the card is in the frame's
  // document. The frame's own instance has all of it — which is why grab is
  // broadcast to every frame rather than handled where the keystroke landed.
  const frameHover = await (async () => {
    const spot = await page.evaluate((base) => new Promise((resolve) => {
      const f = document.querySelector('[data-test="frame-tip"]');
      f.scrollIntoView({ block: 'center' });
      const d = f.contentDocument;
      let left = 2;
      for (const src of ['lib/reset.js', 'contentScript.js']) {
        const el = d.createElement('script');
        el.src = base + '/' + src + '?v=' + Date.now();
        el.onload = () => {
          if (--left) return;
          f.contentWindow.__cheater.activate();
          f.contentWindow.__cheater.setPaused(true);
          const tile = d.querySelector('[data-test="iframe-tile"]');
          const fr = f.getBoundingClientRect();
          const ir = tile.getBoundingClientRect();
          resolve({ x: Math.round(fr.left + ir.left + ir.width / 2),
                    y: Math.round(fr.top + ir.top + ir.height / 2) });
        };
        d.head.appendChild(el);
      }
    }), BASE);

    await page.mouse.move(spot.x, spot.y);
    await page.waitForTimeout(250);

    return page.evaluate(async () => {
      const res = [];
      const ok = (name, pass, detail) => res.push({ name, pass: !!pass, detail: pass ? '' : String(detail ?? '') });
      const f = document.querySelector('[data-test="frame-tip"]');
      const inner = f.contentWindow.__cheater;
      const W = window.CheaterHtmlWriter;

      ok('frame hover: the card really appeared inside the frame',
        !!f.contentDocument.querySelector('[data-test="iframe-card"]'),
        'the fixture card never appeared');
      // The fact that forces the broadcast to exist.
      ok('frame hover: the TOP frame sees no hover at all',
        window.__cheater.state.hovered === null,
        'the top frame somehow tracked a hover across a frame boundary');
      ok('frame hover: the FRAME does see it',
        !!inner.state.hovered, 'the frame instance is not tracking the hover either');
      ok('frame hover: the frame noticed the card appearing',
        inner.state.appeared.size >= 1, 'appeared=' + inner.state.appeared.size);

      inner.clearSelection();
      const grabbed = await inner.grabHovered();
      const payload = inner.buildPayload() || { nodes: [], diagnostics: {} };
      const source = W.build(payload, { fontMode: 'relative' });

      ok('frame hover: the frame grabs successfully', grabbed === true);
      ok('frame hover: the CARD is in the export', source.includes('17,453'),
        'the in-frame hover card is missing');
      // Grab takes what appeared, not the tile it appeared from.
      ok('frame hover: the card alone, one selection',
        (payload.nodes || []).length === 1, (payload.nodes || []).length + ' selections');
      ok('frame hover: the tile itself was not captured', !source.includes('12,104'),
        'the trigger came along too');

      inner.deactivate();
      return res;
    });
  })();

  results.push(...frameHover);

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
