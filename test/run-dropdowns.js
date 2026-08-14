/**
 * Cheater — closed-dropdown harness.
 *
 * Covers the case that actually matters and that the portal fixtures in
 * fixtures.html do not: a dropdown whose menu is CLOSED when you select it.
 *
 * A closed menu is `display:none`, and a `display:none` subtree was dropped
 * outright — which is why exported dropdowns had nothing to open, no matter what
 * the export did with them. The menu now gets revealed on the live page for the
 * few milliseconds it takes to capture, then restored.
 *
 * Every assertion here is behavioural where it can be: the generated export is
 * rendered in an iframe carrying export.html's exact sandbox attribute (no
 * allow-scripts), and focus is moved to check the menu really opens.
 *
 * Run: node test/cdp-runner.js run-dropdowns
 * or:  browser_run_code_unsafe { filename: "test/run-dropdowns.js" }
 *      (serve the repo first: python3 -m http.server 8931 --bind 127.0.0.1)
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
  await page.goto(BASE + '/test/dropdowns.html');
  await page.waitForTimeout(400);
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
    const live = (p) => W.build(p, { fontMode: 'relative', interactive: true });
    const flat = (p) => W.build(p, { fontMode: 'relative' });

    // Render an export the way export.html does, and hand back a live document.
    const render = async (html) => {
      const frame = document.createElement('iframe');
      frame.setAttribute('sandbox', 'allow-same-origin allow-popups allow-popups-to-escape-sandbox');
      frame.style.cssText = 'position:fixed;left:-9999px;top:0;width:1000px;height:700px;border:0';
      frame.srcdoc = html;
      document.body.appendChild(frame);
      await new Promise((resolve) => { frame.onload = resolve; });
      return {
        doc: frame.contentDocument,
        win: frame.contentDocument.defaultView,
        done: () => frame.remove()
      };
    };

    C.activate();

    /* ------------------------------------------------- every way to hide a menu */
    // Each of these is a real library's mechanism. The menu text is what proves the
    // subtree actually came along rather than just the trigger.
    const shapes = [
      ['dd-display', 'Healthcare', 'inline display:none (bootstrap-shaped)'],
      ['dd-visibility', 'EMEA', 'visibility:hidden + opacity'],
      ['dd-attr', 'USD', 'the hidden attribute'],
      ['dd-links', 'Funds', 'a menu of real links'],
      ['dd-class', '4 stars and up', 'a stylesheet class with !important'],
      ['dd-div', '1 year', 'a non-focusable div trigger'],
      ['dd-nested', 'Deep one', 'menu nested deeper than the trigger']
    ];

    for (const [name, text, label] of shapes) {
      const payload = await cap(q(name));
      const source = live(payload);

      ok(`closed[${label}]: the menu subtree is captured`,
        source.includes(text), 'menu text missing from the export entirely');
      ok(`closed[${label}]: reported as wired`,
        (payload.diagnostics.closedMenusWired || 0) >= 1,
        'wired=' + payload.diagnostics.closedMenusWired);

      const view = await render(source);
      const menu = view.doc.querySelector('.cheater-dd-menu');
      const trigger = view.doc.querySelector('.cheater-dd-trigger') ||
        view.doc.querySelector('.cheater-dd[tabindex]');

      if (!menu || !trigger) {
        ok(`closed[${label}]: markers present`, false,
          'menu=' + !!menu + ' trigger=' + !!trigger);
        view.done();
        continue;
      }

      const display = () => view.win.getComputedStyle(menu).display;
      const before = display();
      trigger.focus();
      const opened = display();
      const height = menu.getBoundingClientRect().height;
      const below = menu.getBoundingClientRect().top >= trigger.getBoundingClientRect().bottom - 3;
      trigger.blur();
      const reclosed = display();

      ok(`closed[${label}]: renders CLOSED`, before === 'none', 'display=' + before);
      ok(`closed[${label}]: OPENS on click`, opened !== 'none', 'display stayed ' + opened);
      // A flex menu reopened as `block` would lose its gaps and column direction.
      ok(`closed[${label}]: reopens with its captured display`, opened === 'flex',
        'display=' + opened);
      ok(`closed[${label}]: the open menu has real height`, height > 20, 'height=' + height);
      ok(`closed[${label}]: sits under its trigger`, below,
        'menu top ' + Math.round(menu.getBoundingClientRect().top) +
        ' vs trigger bottom ' + Math.round(trigger.getBoundingClientRect().bottom));
      ok(`closed[${label}]: closes again`, reclosed === 'none', 'display=' + reclosed);
      view.done();
    }

    /* ----------------------------------------- the page must be left untouched */
    {
      // Revealing a menu mutates the live page. Anything left behind would be a
      // visible dropdown stuck open on someone's site.
      const checks = [
        ['dd-display-menu', (el) => /display:\s*none/.test(el.getAttribute('style') || '')],
        ['dd-visibility-menu', (el) => /visibility:\s*hidden/.test(el.getAttribute('style') || '')],
        ['dd-attr-menu', (el) => el.hasAttribute('hidden')],
        ['dd-class-menu', (el) => el.classList.contains('js-collapsed')]
      ];
      for (const [name, intact] of checks) {
        const el = q(name);
        ok(`restore: ${name} is hidden again after capture`, intact(el),
          'style="' + (el.getAttribute('style') || '') + '" class="' + el.className + '"');
        ok(`restore: ${name} computes as hidden again`,
          getComputedStyle(el).display === 'none' || getComputedStyle(el).visibility === 'hidden',
          'display=' + getComputedStyle(el).display);
      }
    }

    /* ------------------------------------------- hidden things that are NOT menus */
    {
      // Capturing every hidden subtree would bloat exports and carry along content
      // nobody selected — tracking markup, unopened promos.
      const payload = await cap(q('dd-notmenu'));
      const source = live(payload);
      ok('non-menu: a hidden tracking beacon stays dropped',
        !source.includes('tracking beacon'), 'hidden non-menu content leaked into the export');
      ok('non-menu: a hidden promo stays dropped',
        !source.includes('Seasonal promo'), 'hidden promo leaked into the export');
      ok('non-menu: nothing was wired', !payload.diagnostics.closedMenusWired,
        'wired=' + payload.diagnostics.closedMenusWired);
    }

    /* ------------------------------------------------ two dropdowns, independent */
    {
      // One shared rule would open both menus at once, which looks like a bug even
      // though both menus are present.
      const payload = await cap(q('dd-twin-a').parentElement);
      const source = live(payload);
      ok('twins: both menus captured',
        source.includes('A one') && source.includes('B one'), 'a menu is missing');
      ok('twins: two distinct pairs', (() => {
        const ids = new Set();
        const visit = (n) => { if (n && n.ddId) ids.add(n.ddId); (n.ch || []).forEach(visit); };
        (payload.nodes || []).forEach(visit);
        return ids.size === 2;
      })(), 'distinct dd ids != 2');

      const view = await render(source);
      const menus = view.doc.querySelectorAll('.cheater-dd-menu');
      ok('twins: both menus rendered', menus.length === 2, 'found ' + menus.length);
      if (menus.length === 2) {
        const display = (i) => view.win.getComputedStyle(menus[i]).display;
        const triggers = view.doc.querySelectorAll('.cheater-dd-trigger');
        ok('twins: both closed initially',
          display(0) === 'none' && display(1) === 'none', display(0) + ' / ' + display(1));
        triggers[0].focus();
        ok('twins: focusing A opens ONLY A',
          display(0) !== 'none' && display(1) === 'none',
          'A=' + display(0) + ' B=' + display(1));
        triggers[1].focus();
        ok('twins: focusing B opens ONLY B',
          display(1) !== 'none' && display(0) === 'none',
          'A=' + display(0) + ' B=' + display(1));
      }
      view.done();
    }

    /* --------------------------------------------------------- static mode parity */
    {
      const payload = await cap(q('dd-display'));
      const source = flat(payload);
      ok('static: no wrapper or marker classes', !source.includes('cheater-dd'),
        'interactive scaffolding leaked into static output');
      ok('static: no :focus-within rules', !source.includes(':focus-within'));
      ok('static: the menu is still captured', source.includes('Healthcare'),
        'static mode should include the menu, just not hide it');
      ok('static: no tabindex added', !/tabindex/.test(source));
      ok('static: ships no JavaScript', !/<script/i.test(source));
    }

    /* ------------------------------------------------- the toggle appears at all */
    {
      // export.js shows its Static/Interactive control based on this, and an in-tree
      // menu is nested inside its host — a top-level-only scan would report false
      // and the feature would silently never turn on.
      const withMenu = await cap(q('dd-display'));
      ok('toggle: reported for a nested in-tree dropdown', W.hasDropdowns(withMenu) === true);
      const without = await cap(q('dd-notmenu'));
      ok('toggle: not reported when there is no dropdown', W.hasDropdowns(without) === false);
    }

    /* --------------------------------------------------- native details/summary */
    {
      // Already interactive with no help at all. Wrapping it would be a regression.
      const payload = await cap(q('dd-details'));
      const source = live(payload);
      // The markup only — the interactive stylesheet always names these classes.
      const markup = source.slice(source.indexOf('<body'));
      ok('details: kept as a real <details>', /<details/.test(markup));
      ok('details: not wrapped as a dropdown', !markup.includes('cheater-dd'),
        'details was treated as a closed menu');
      ok('details: its content came along despite being closed',
        markup.includes('Include closed funds'),
        'a closed <details> exported with nothing inside it');
      ok('details: still renders closed', !/<details[^>]*\sopen/.test(markup),
        'the temporary open leaked into the export');
      const view = await render(source);
      const details = view.doc.querySelector('details');
      ok('details: works natively in the export', !!details && typeof details.open === 'boolean');
      view.done();
    }

    /* ------------------------------------------------------------- no JavaScript */
    {
      const payload = await cap(q('dd-display'));
      const source = live(payload);
      ok('interactive: ships no JavaScript at all', !/<script/i.test(source),
        'a script tag leaked into the export');
      ok('interactive: no inline event handlers', !/\son[a-z]+=/i.test(source),
        (source.match(/\son[a-z]+=/i) || [''])[0]);
    }

    /* ----------------------------------------------------- TOON stays scaffold-free */
    {
      const payload = await cap(q('dd-display'));
      const toon = window.CheaterToonWriter.toToon(payload);
      ok('toon: the captured menu is present', toon.includes('Healthcare'));
      ok('toon: no cheater- scaffolding classes', !toon.includes('cheater-dd'),
        'interactive scaffolding leaked into the LLM handoff');
    }

    /* ============================ interact mode + hover grab ================ */
    // Selection mode swallows every click, which is what made anything you have to
    // OPEN unreachable. These cover the way out of that.
    {
      C.clearSelection();
      C.activate();

      // Synthesise a pointer move so the extension knows what is under the cursor,
      // the same way a real move would.
      const point = (el) => {
        const r = el.getBoundingClientRect();
        el.dispatchEvent(new PointerEvent('pointermove', {
          bubbles: true, composed: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2
        }));
      };
      const clickIt = (el) => {
        const r = el.getBoundingClientRect();
        const at = { bubbles: true, composed: true, cancelable: true,
          clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
        el.dispatchEvent(new PointerEvent('pointerdown', at));
        el.dispatchEvent(new MouseEvent('mousedown', at));
        el.dispatchEvent(new MouseEvent('mouseup', at));
        el.dispatchEvent(new MouseEvent('click', at));
      };

      // Capture is async, and an empty selection has no payload at all.
      const settle = () => new Promise((r) => setTimeout(r, 120));
      const held = () => (C.buildPayload() || { nodes: [] }).nodes.length;

      /* -- select mode still protects the page from selection gestures --------- */
      const button = q('real-btn');
      button.dataset.clicked = '0';
      C.setPaused(false);
      point(button);
      clickIt(button);
      await settle();
      ok('select mode: the page does NOT receive the click',
        button.dataset.clicked === '0', 'clicks=' + button.dataset.clicked);
      ok('select mode: the click selected instead', held() >= 1, 'nothing was selected');

      /* -- interact mode hands clicks back ------------------------------------ */
      C.clearSelection();
      C.setPaused(true);
      point(button);
      clickIt(button);
      await settle();
      ok('interact mode: the page DOES receive the click',
        button.dataset.clicked === '1', 'clicks=' + button.dataset.clicked);
      ok('interact mode: clicking did not select anything', held() === 0,
        'a click still selected in interact mode');

      /* -- hover keeps working while interacting ------------------------------ */
      // Without this the mode is just an off switch: nothing shows what the grab
      // key would take, and a hover-only menu can never be captured.
      point(q('dd-display-trigger'));
      ok('interact mode: hover is still tracked', !!C.state.hovered,
        'hover tracking stopped, so there is nothing to grab');

      /* -- grab reports honestly with nothing under the cursor ---------------- */
      C.clearSelection();
      C.state.hovered = null;
      const empty = await C.grabHovered();
      ok('grab: refuses politely when nothing is hovered', empty === false);

      /* -- interact mode leaves the keyboard alone --------------------------- */
      C.setPaused(true);
      let escapeSeen = false;
      const onEsc = () => { escapeSeen = true; };
      document.addEventListener('keydown', onEsc);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      document.removeEventListener('keydown', onEsc);
      ok('interact mode: Escape reaches the page (menus close on it)', escapeSeen);
      ok('interact mode: Escape did not tear the extension down', C.state.active === true);

      C.setPaused(false);
      C.clearSelection();
    }

    return out;
  });

  /* ==================== hover-revealed menu, with a REAL cursor ============== */
  // The prize case, and the one that cannot be tested from inside the page: a menu
  // that exists only while the pointer is inside its host. Synthetic pointer events
  // do not move the cursor, so `:hover` never matches — only the driver can.
  const hoverResults = await (async () => {
    const rects = await page.evaluate(() => {
      const q = (n) => document.querySelector(`[data-test="${n}"]`);
      const box = (el) => { const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, top: r.top, h: r.height }; };
      q('dd-hover').scrollIntoView({ block: 'center' });
      return { trigger: box(q('dd-hover-trigger')), hostTop: q('dd-hover').getBoundingClientRect().top };
    });

    // Hover the trigger for real. The menu appears below it, still inside the host,
    // so moving down onto the menu keeps :hover matching.
    await page.mouse.move(rects.trigger.x, rects.trigger.y);
    await page.waitForTimeout(120);
    const visible = await page.evaluate(() => {
      const menu = document.querySelector('[data-test="dd-hover-menu"]');
      return { display: getComputedStyle(menu).display, height: menu.getBoundingClientRect().height,
               top: menu.getBoundingClientRect().top, x: menu.getBoundingClientRect().left + 40 };
    });

    await page.mouse.move(visible.x, visible.top + Math.max(8, visible.height / 2));
    await page.waitForTimeout(120);

    return page.evaluate(async (probe) => {
      const C = window.__cheater;
      const W = window.CheaterHtmlWriter;
      const res = [];
      const ok = (name, pass, detail) => res.push({ name, pass: !!pass, detail: pass ? '' : String(detail ?? '') });

      ok('hover: a real cursor actually opens the menu', probe.display === 'flex',
        'display=' + probe.display);
      ok('hover: the open menu has height', probe.height > 20, 'height=' + probe.height);

      const hovered = C.state.hovered;
      ok('hover: the extension tracks the menu under the cursor while interacting',
        !!hovered && document.querySelector('[data-test="dd-hover-menu"]').contains(hovered),
        'hovered=' + (hovered && hovered.getAttribute('data-test')) + ' tag=' + (hovered && hovered.tagName));

      // No click anywhere in this sequence. A click would have closed it.
      C.clearSelection();
      await C.grabHovered();
      const payload = C.buildPayload() || { nodes: [], diagnostics: {} };
      const source = W.build(payload, { fontMode: 'relative', interactive: true });

      ok('hover: grabbed without a single click', (payload.nodes || []).length >= 1,
        'nothing was captured');
      ok('hover: the menu content is in the export', source.includes('Hover two'),
        'the hover-only menu is missing from the export');
      ok('hover: it captured the menu, not the whole page',
        (payload.diagnostics.selections || []).every((sel) => sel.tag !== 'body'),
        JSON.stringify((payload.diagnostics.selections || []).map((s) => s.tag)));

      C.setPaused(false);
      C.clearSelection();
      C.deactivate();
      return res;
    }, visible);
  })();

  results.push(...hoverResults);

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
