/**
 * Cheater — cross-origin frame harness.
 *
 * A parent cannot read a cross-origin frame; the browser forbids it and no extension
 * trick changes that. But the content script runs in EVERY frame, so an instance
 * inside that frame reads its own document perfectly well. The parent's problem is
 * addressing, not access: it holds an <iframe> element and needs the frameId behind
 * it, which no DOM API exposes. A token handshake through the worker supplies it.
 *
 * This suite stands in for the worker, because only the worker (or here, the CDP
 * driver) can address a frame the parent cannot touch. It covers both kinds Chrome
 * has: a different PORT is cross-origin but same-process, and a different HOST is a
 * different site and therefore its own process.
 *
 * Run: node test/cdp-runner.js run-remote
 */

async (page) => {
  const BASE = 'http://127.0.0.1:8931';

  // A chrome stub that parks outgoing messages for the driver to fulfil. Nothing
  // else can route between frames that cannot see each other.
  await page.addInitScript(() => {
    window.__cheaterOut = [];
    window.__cheaterIn = {};
    window.chrome = {
      runtime: {
        onMessage: {
          addListener(fn) { (window.__cheaterListeners = window.__cheaterListeners || []).push(fn); }
        },
        sendMessage(msg, cb) {
          const id = 'r' + Math.random().toString(36).slice(2);
          window.__cheaterOut.push({ id, msg });
          if (!cb) return;
          const poll = setInterval(() => {
            if (Object.prototype.hasOwnProperty.call(window.__cheaterIn, id)) {
              clearInterval(poll);
              const reply = window.__cheaterIn[id];
              delete window.__cheaterIn[id];
              cb(reply);
            }
          }, 20);
        },
        getManifest: () => ({ version: '3.2.0' }),
        lastError: null
      },
      storage: {
        sync: { get(d, cb) { cb(d || {}); }, set(_v, cb) { cb && cb(); } },
        session: { get(_k, cb) { cb({}); }, set(_v, cb) { cb && cb(); }, remove(_k, cb) { cb && cb(); } }
      }
    };
  });

  // all_frames: true, for real — including out-of-process frames.
  await page.addAllFramesScript('lib/reset.js');
  await page.addAllFramesScript('contentScript.js');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(BASE + '/test/iframes.html');
  await page.waitForTimeout(1500);
  await page.addScriptTag({ url: BASE + '/lib/html-writer.js?v=' + Date.now() });
  await page.addScriptTag({ url: BASE + '/lib/toon-writer.js?v=' + Date.now() });

  const frames = await page.subframes();
  const parties = () => [{ evaluate: page.evaluate, url: 'TOP' }].concat(frames);
  const claimed = new Map();          // token -> the frame that answered it

  const drainHellos = async () => {
    const leftovers = [];
    for (const party of parties()) {
      let outbox = [];
      try {
        outbox = await party.evaluate(() => {
          const o = window.__cheaterOut || [];
          window.__cheaterOut = [];
          return o;
        });
      } catch (_) { continue; }
      for (const item of outbox) {
        const msg = item.msg || {};
        if (msg.type === 'CHEATER_FRAME_HELLO') claimed.set(msg.token, party);
        else leftovers.push({ item, party });
      }
    }
    return leftovers;
  };

  const queue = [];
  const pump = async () => {
    queue.push(...await drainHellos());
    while (queue.length) {
      const { item, party } = queue.shift();
      const msg = item.msg || {};
      let reply = { ok: true };

      if (msg.type === 'CHEATER_CAPTURE_REMOTE') {
        // The real worker polls until a frame claims the token: the parent posts it
        // and asks in the same breath, so the echo can land after the request.
        let owner = claimed.get(msg.token);
        for (let i = 0; i < 60 && !owner; i += 1) {
          queue.push(...await drainHellos());
          owner = claimed.get(msg.token);
          if (!owner) await page.waitForTimeout(25);
        }
        const answered = owner
          ? await owner.evaluate(() => new Promise((resolve) => {
            for (const fn of (window.__cheaterListeners || [])) {
              const kept = fn({ type: 'CHEATER_CAPTURE_FRAME' }, {}, resolve);
              if (kept) return;
            }
            resolve(null);
          }))
          : null;
        reply = answered || { ok: false, payload: null };
      }

      try { await party.evaluate((a) => { window.__cheaterIn[a.id] = a.reply; }, { id: item.id, reply }); }
      catch (_) { /* the frame went away */ }
    }
  };
  const pumpFor = async (ms) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { await pump(); await page.waitForTimeout(30); }
  };

  const capture = async (testName) => {
    const running = page.evaluate(async (name) => {
      const C = window.__cheater;
      C.activate();
      C.clearSelection();
      await C.addSelection(document.querySelector('[data-test="' + name + '"]'), true);
      const payload = C.buildPayload();
      return {
        diagnostics: payload ? payload.diagnostics : null,
        html: payload ? window.CheaterHtmlWriter.build(payload, { fontMode: 'relative' }) : '',
        toon: payload ? window.CheaterToonWriter.toToon(payload) : '',
        fonts: payload ? payload.fonts : null,
        classCount: payload ? Object.keys(payload.styles).length : 0
      };
    }, testName);
    await pumpFor(4000);
    return running;
  };

  const results = [];
  const ok = (name, pass, detail) => results.push({ name, pass: !!pass, detail: pass ? '' : String(detail ?? '') });

  /* ------ the frames really are unreachable from the parent -------------- */
  {
    const seen = await page.evaluate(() => ['frame-cross', 'frame-oop'].map((n) => {
      const el = document.querySelector('[data-test="' + n + '"]');
      try { return { n, doc: !!el.contentDocument }; } catch (_) { return { n, doc: 'threw' }; }
    }));
    ok('setup: the parent cannot read either cross-origin frame',
      seen.every((s) => s.doc === false || s.doc === 'threw'), JSON.stringify(seen));
    ok('setup: an out-of-process frame really is a separate target',
      frames.some((f) => f.kind === 'out-of-process' && /localhost:8932/.test(f.url || '')),
      frames.map((f) => f.kind + ':' + f.url).join(' | '));
  }

  /* ------ cross-origin, same process (a different port) ------------------ */
  {
    const res = await capture('frame-cross-host');
    const body = res.html.slice(res.html.indexOf('<body'));

    ok('cross-origin: captured by asking the frame itself',
      res.diagnostics.framesRemote === 1, 'framesRemote=' + res.diagnostics.framesRemote);
    ok('cross-origin: did NOT fall back to pixels',
      !res.diagnostics.framesPixels, 'framesPixels=' + res.diagnostics.framesPixels);
    ok('cross-origin: the frame content is real markup',
      body.includes('child frame') && body.includes('frame-child.html'),
      'frame content missing from the export');
    ok('cross-origin: the frame\'s OWN stylesheet came along',
      res.html.includes('#1d4ed8') || res.html.includes('rgb(29, 78, 216)'),
      'the badge colour from inside the frame is missing');
    ok('cross-origin: a gradient inside the frame survived', res.html.includes('linear-gradient'));
    ok('cross-origin: exported as a div, not an <iframe>', !/<iframe/i.test(body),
      'an <iframe> tag would reload the live URL instead of showing the capture');

    // The frame named its first shared style .s1 exactly as the parent did. Without
    // renaming, the frame's rows would silently take the parent's styling.
    ok('cross-origin: the frame\'s classes are namespaced',
      /\.cf1s\d+/.test(res.html), 'no cf-prefixed classes, so the tables may have collided');
    // Both sides' styling has to survive together. A style set used by a single node
    // is emitted inline rather than as a class, so assert on the values, not on .sN.
    ok('cross-origin: the parent\'s own styling survives alongside',
      res.html.includes('#e2e8f0') || res.html.includes('rgb(226, 232, 240)'),
      'the host card border from the parent page is missing');

    ok('cross-origin: reaches the TOON handoff too', res.toon.includes('child frame'),
      'the LLM handoff still has nothing for this frame');
  }

  /* ------ out-of-process (a different host, so a different site) --------- */
  {
    const res = await capture('frame-oop-host');
    const body = res.html.slice(res.html.indexOf('<body'));

    ok('out-of-process: captured by asking the frame itself',
      res.diagnostics.framesRemote === 1, 'framesRemote=' + res.diagnostics.framesRemote);
    ok('out-of-process: content is real markup',
      body.includes('remote widget') && body.includes('€4.62Bn'),
      'the remote widget content is missing');
    ok('out-of-process: its own stylesheet applied',
      res.html.includes('#6ee7b7') || res.html.includes('rgb(110, 231, 183)'),
      'the widget colour from its own stylesheet is missing');
    ok('out-of-process: a gradient inside it survived', res.html.includes('linear-gradient'));
    // The widget paints its backdrop on <html>, which only that frame can observe.
    ok('out-of-process: the frame\'s <html> backdrop came along',
      res.html.includes('#052e2b') || res.html.includes('rgb(5, 46, 43)'),
      'the frame backdrop is missing, so it renders transparent');
  }

  /* ------ a frame with nothing to answer with must still degrade --------- */
  {
    // sandbox="" forces an opaque origin AND blocks scripts, so no instance exists
    // in there to answer the handshake. Pixels stay the honest fallback.
    const res = await capture('frame-sandbox-host');
    ok('sandboxed: no remote capture claimed',
      !res.diagnostics.framesRemote, 'framesRemote=' + res.diagnostics.framesRemote);
    ok('sandboxed: degrades to pixels rather than hanging or throwing',
      res.diagnostics.framesPixels >= 1 || res.diagnostics.pixelsRecovered >= 1,
      'framesPixels=' + res.diagnostics.framesPixels);
  }

  /* ------ same-origin frames must NOT take the remote path --------------- */
  {
    const res = await capture('frame-same-host');
    ok('same-origin: still inlined directly, no handshake needed',
      res.diagnostics.framesInlined >= 1 && !res.diagnostics.framesRemote,
      'inlined=' + res.diagnostics.framesInlined + ' remote=' + res.diagnostics.framesRemote);
  }

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
