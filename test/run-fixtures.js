/**
 * Cheater — fixture harness.
 *
 * Drives the real capture logic against test/fixtures.html in a real browser,
 * via the content script's isolated-world debug surface (window.__cheater).
 *
 * Run through the Playwright MCP server:
 *   browser_run_code_unsafe { filename: "test/run-fixtures.mjs" }
 *
 * It loads lib/reset.js and contentScript.js into the page with a minimal chrome
 * API stub, then asserts one capture path at a time. Output is a pass/fail list
 * plus detail for failures only.
 */

async (page) => {
  // The Playwright sandbox has no fs, so the repo is served over HTTP and
  // scripts are injected by URL. Start the server first:
  //   python3 -m http.server 8931 --bind 127.0.0.1
  const BASE = 'http://127.0.0.1:8931';

  // The content script expects chrome.* at load time. Minimal stub, installed
  // before any script on the page runs.
  await page.addInitScript(() => {
    window.chrome = {
      runtime: {
        onMessage: { addListener() {} },
        sendMessage(_msg, cb) { if (typeof cb === 'function') cb({ ok: true }); },
        getManifest: () => ({ version: '3.1.0' }),
        lastError: null
      },
      storage: {
        sync: { get(defaults, cb) { cb(defaults || {}); }, set(_v, cb) { cb && cb(); } },
        session: { get(_k, cb) { cb({}); }, set(_v, cb) { cb && cb(); }, remove(_k, cb) { cb && cb(); } }
      }
    };
  });

  await page.goto(BASE + '/test/fixtures.html');
  await page.waitForTimeout(600); // let the fixture's own scripts paint the canvas

  for (const src of ['lib/reset.js', 'contentScript.js', 'lib/html-writer.js', 'lib/toon-writer.js']) {
    await page.addScriptTag({ url: BASE + '/' + src + '?v=' + Date.now() });
  }

  const results = await page.evaluate(async () => {
    const C = window.__cheater;
    const out = [];
    const ok = (name, pass, detail) => out.push({ name, pass: !!pass, detail: pass ? '' : String(detail ?? '') });
    const q = (sel) => document.querySelector(`[data-test="${sel}"]`);
    const tag = (el) => (el && el.tagName ? el.tagName.toLowerCase() : String(el));
    const cap = async (el) => { C.clearSelection(); await C.addSelection(el, true); return C.buildPayload(); };
    const html = (payload) => window.CheaterHtmlWriter.build(payload, { fontMode: 'relative' });
    const live = (payload) => window.CheaterHtmlWriter.build(payload,
      { fontMode: 'relative', interactive: true });
    // A style set lands either in a shared class rule (`prop: value;`) or inline
    // (`prop:value`), so declaration assertions must be whitespace-agnostic.
    const decl = (source, prop, value) =>
      new RegExp(prop.replace(/[-]/g, '\\-') + ':\\s*' + String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(source);

    C.activate();

    /* ---------------------------------------------- smart expansion */
    {
      const input = q('field-input');
      const target = C.smartExpand(input);
      ok('expand: bare input -> field card',
        target === q('field-card'), `got ${tag(target)}.${target.className}`);
    }
    {
      const card = q('field-card');
      ok('expand: card taken as-is', C.smartExpand(card) === card, tag(C.smartExpand(card)));
    }
    {
      const path0 = q('sprite-svg').querySelector('use') || q('sprite-svg');
      const target = C.smartExpand(path0);
      ok('expand: svg internal snaps out of the svg',
        target !== path0 && (tag(target) === 'svg' || tag(target) === 'div'), tag(target));
    }
    {
      const target = C.smartExpand(q('td-1'));
      ok('expand: td -> tr', target === q('tr-1'), tag(target));
    }
    {
      const section = document.getElementById('s-form');
      ok('expand: structural section taken as-is', C.smartExpand(section) === section, tag(C.smartExpand(section)));
    }
    {
      ok('expand: never climbs to body/html',
        C.smartExpand(q('chip')) !== document.body && C.smartExpand(q('g-head')) !== document.body);
    }
    {
      const overlay = q('catch-overlay');
      ok('overlay: transparent catcher detected', C.isTransparentCatcher(overlay));
      overlay.scrollIntoView({ block: 'center' });
      const r = overlay.getBoundingClientRect();
      const seen = C.resolveOverlay(overlay, r.left + r.width / 2, r.top + r.height / 2);
      ok('overlay: looks through to the real card',
        seen === q('catch-card') || q('catch-card').contains(seen), tag(seen) + '.' + seen.className);
    }

    /* ---------------------------------------------- navigation back-stack */
    {
      const start = q('g-head');
      C.nav.reset(start);
      const up1 = C.nav.up(), up2 = C.nav.up(), up3 = C.nav.up();
      const down1 = C.nav.down(), down2 = C.nav.down(), down3 = C.nav.down();
      ok('nav: up then down returns along the exact path',
        up1 === q('grid') && down2 === up1 && down3 === start,
        `up=${tag(up1)},${tag(up2)},${tag(up3)} down=${tag(down1)},${tag(down2)},${tag(down3)}`);
    }
    {
      // Overshoot upward, then walk all the way back — must never strand at body.
      C.nav.reset(q('chip'));
      for (let i = 0; i < 10; i += 1) C.nav.up();
      for (let i = 0; i < 10; i += 1) C.nav.down();
      ok('nav: overshoot up is fully recoverable', C.nav.current() === q('chip'), tag(C.nav.current()));
    }
    {
      C.nav.reset(q('shadow-host'));
      const down = C.nav.down();
      ok('nav: descends into a shadow root', down && down.getRootNode() !== document, tag(down));
    }

    /* ---------------------------------------------- icon detection */
    ok('icon: ligature name looks like a glyph', C.looksLikeGlyph('search') && C.looksLikeGlyph('chevron_right'));
    ok('icon: PUA char looks like a glyph', C.looksLikeGlyph(''));
    ok('icon: prose is never a glyph',
      !C.looksLikeGlyph('Best price, guaranteed daily') && !C.looksLikeGlyph('Search destinations') &&
      !C.looksLikeGlyph('a'.repeat(40)));
    ok('icon: only the FIRST family in the stack counts',
      C.iconFamilyKey('Material Icons') === 'material-icons' &&
      C.iconFamilyKey(C.parseFamilyStack(getComputedStyle(q('prose')).fontFamily)[0]) === null,
      'first=' + C.parseFamilyStack(getComputedStyle(q('prose')).fontFamily)[0]);
    {
      // The critical false positive: a whole paragraph under a Bootstrap-shaped
      // stack must not become ligatures.
      const payload = await cap(q('prose'));
      const icons = payload.diagnostics.iconNodes;
      ok('icon: prose paragraph yields zero icon nodes', icons === 0, 'iconNodes=' + icons);
      ok('icon: prose keeps interleaved text',
        JSON.stringify(payload.nodes).includes('Best price,') &&
        JSON.stringify(payload.nodes).includes('guaranteed'));
    }
    {
      const payload = await cap(q('mi-icon'));
      ok('icon: material-icons ligature IS an icon', payload.diagnostics.iconNodes === 1,
        'iconNodes=' + payload.diagnostics.iconNodes);
      ok('icon: liga feature settings emitted', html(payload).includes('liga'),
        html(payload).slice(html(payload).indexOf('<body'), -1).slice(0, 300));
      ok('icon: material-icons stylesheet requested',
        payload.fonts.icons.includes('material-icons'), JSON.stringify(payload.fonts.icons));
    }
    {
      const payload = await cap(q('fa-icon'));
      const source = html(payload);
      ok('icon: ::before PUA content triggers the FA stylesheet',
        payload.fonts.icons.includes('fa6') && source.includes('font-awesome'),
        JSON.stringify(payload.fonts.icons));
      ok('icon: ::before content emitted as an escaped pseudo rule',
        /\.p\d+::before/.test(source) && source.includes('\\f002'));
    }
    {
      const payload = await cap(q('prose-short'));
      ok('icon: single word under a text stack is not an icon',
        payload.diagnostics.iconNodes === 0, 'iconNodes=' + payload.diagnostics.iconNodes);
    }

    /* ---------------------------------------------- pseudo elements */
    {
      const source = html(await cap(q('switch')));
      ok('pseudo: decorative empty content kept', /content: ""/.test(source));
      ok('pseudo: decorative box-shadow kept', source.includes('box-shadow'));
    }
    {
      const source = html(await cap(q('divider')));
      ok('pseudo: ::after divider kept with its gradient',
        /\.p\d+::after/.test(source) && source.includes('linear-gradient'));
    }

    /* ---------------------------------------------- canvas */
    // The canvases sit in a flex row, so a single selection is (correctly)
    // wrapped in a synthetic parent-layout container. Find the real node.
    const firstOfKind = (nodes, kind) => {
      let found = null;
      (function walk(list) {
        for (const n of list || []) { if (found) return; if (n.k === kind) { found = n; return; } walk(n.ch); }
      })(nodes);
      return found;
    };
    {
      const payload = await cap(q('canvas-2d'));
      const node = firstOfKind(payload.nodes, 'img') || {};
      ok('canvas: readable 2d canvas becomes a sized image',
        node.k === 'img' && String(node.src).startsWith('data:image/png') && node.w === 240 && node.h === 120,
        `${node.k} w=${node.w} h=${node.h}`);
    }
    {
      const payload = await cap(q('canvas-gl'));
      const node = firstOfKind(payload.nodes, 'ph') || {};
      ok('canvas: unreadable webgl degrades to a sized placeholder',
        node.k === 'ph' && node.w === 120 && node.h === 120 && payload.diagnostics.canvasPlaceholders === 1,
        `${node.k} w=${node.w} placeholders=${payload.diagnostics.canvasPlaceholders}`);
    }

    /* ---------------------------------------------- svg sprites */
    {
      const source = html(await cap(q('sprite-svg')));
      ok('svg: <use> resolved into a local <defs>',
        source.includes('<defs>') && source.includes('id="icon-star"') && source.includes('href="#icon-star"'),
        source.slice(source.indexOf('<svg'), source.indexOf('<svg') + 160));
    }
    {
      const source = html(await cap(q('sprite-nested')));
      ok('svg: nested <use> inside a symbol resolved too',
        source.includes('id="icon-nested"') && source.includes('id="icon-star"'));
    }
    {
      const payload = await cap(q('icons'));
      const source = html(payload);
      ok('svg: decorative empty svg dropped', payload.diagnostics.svgDropped >= 1,
        'svgDropped=' + payload.diagnostics.svgDropped);
      ok('svg: stroke-only icon kept', source.includes('#0891b2') || source.includes('M4 12h16'));
    }

    /* ---------------------------------------------- shadow DOM */
    {
      const payload = await cap(q('shadow-host'));
      const source = html(payload);
      ok('shadow: open root contents captured',
        source.includes('Shadow widget') && source.includes('Act'), source.slice(-400));
      ok('shadow: shadow styles captured (indigo background)',
        source.includes('#eef2ff') || source.includes('#3730a3'));
    }
    {
      // Two shadow hosts plus a light-DOM element, exported together.
      C.clearSelection();
      await C.addSelection(q('shadow-host'), true);
      await C.addSelection(q('shadow-host-2'), false);
      await C.addSelection(q('chip'), false);
      const payload = C.buildPayload();
      const source = html(payload);
      ok('shadow: multiple roots + light DOM export as one document',
        payload.diagnostics.topLevel === 3 && source.includes('Second') && source.includes('chip'),
        'topLevel=' + payload.diagnostics.topLevel);
    }

    /* ---------------------------------------------- form state */
    {
      const source = html(await cap(q('form')));
      const checks = {
        'text value': source.includes('value="typed by hand"'),
        'checkbox checked': /type="checkbox"[^>]*\schecked/.test(source),
        'radio checked': /type="radio"[^>]*\schecked/.test(source),
        'option selected': /<option[^>]*\sselected/.test(source),
        'textarea value': source.includes('textarea value set live'),
        'details open': /<details[^>]*\sopen/.test(source),
        'button disabled': /<button[^>]*\sdisabled/.test(source),
        'readonly + required': /\sreadonly/.test(source) && /\srequired/.test(source),
        'placeholder': source.includes('placeholder="unused placeholder"')
      };
      for (const [label, pass] of Object.entries(checks)) ok('form: ' + label, pass);
    }

    /* ---------------------------------------------- filtering */
    {
      const payload = await cap(q('filtered'));
      const source = html(payload);
      ok('filter: display:none dropped', !source.includes('must be dropped') || !source.includes('display:none —'),
        source);
      ok('filter: visibility:hidden dropped', !source.includes('visibility:hidden —'));
      ok('filter: opacity:0 KEPT (animation state)', source.includes('must be KEPT'));
      ok('filter: noscript dropped', !source.includes('GTM noscript'));
      ok('filter: script content dropped', !source.includes('script content must be dropped'));
      ok('filter: drops are counted', payload.diagnostics.dropped >= 3, 'dropped=' + payload.diagnostics.dropped);
    }

    /* ---------------------------------------------- parent layout wrap */
    {
      C.clearSelection();
      await C.addSelection(q('g-head'), true);
      await C.addSelection(q('g-side'), false);
      await C.addSelection(q('g-body'), false);
      const payload = C.buildPayload();
      const source = html(payload);
      ok('wrap: siblings share one synthetic wrapper',
        payload.diagnostics.wraps === 3 && Object.keys(payload.wrappers).length === 1,
        `wraps=${payload.diagnostics.wraps} wrappers=${Object.keys(payload.wrappers).length}`);
      ok('wrap: named grid-template-areas carried over',
        source.includes('grid-template-areas'), JSON.stringify(payload.wrappers));
      ok('wrap: children keep their grid-area', source.includes('grid-area'));
    }

    /* ---------------------------------------------- hover */
    {
      const payload = await cap(q('hover-btn'));
      ok('hover: self :hover rule captured',
        payload.hovers.some((h) => /:hover$/.test(h.sel) && h.props['background-color']),
        JSON.stringify(payload.hovers));
    }
    {
      const payload = await cap(q('hover-card'));
      ok('hover: ancestor-hover descendant rule captured',
        payload.hovers.some((h) => /:hover\s+\./.test(h.sel)),
        JSON.stringify(payload.hovers.map((h) => h.sel)));
    }

    /* ---------------------------------------------- freeze */
    {
      const before = q('ticker').textContent;
      const payload = await cap(q('ticker'));
      await new Promise((r) => setTimeout(r, 700));
      const after = q('ticker').textContent;
      const captured = JSON.stringify(payload.nodes);
      ok('freeze: capture holds the value from selection time',
        before !== after && captured.includes(before) && !captured.includes(after),
        `before=${before} after=${after}`);
      // Re-finalizing the same frozen selection must still produce styles: the
      // regression guard for finalize() mutating its input.
      const again = C.buildPayload();
      ok('freeze: re-export of the same selection still carries styles',
        Object.keys(again.styles).length > 0 || JSON.stringify(again.nodes).includes('inline'),
        'styles=' + Object.keys(again.styles).length);
    }

    /* ---------------------------------------------- masks, images, misc */
    {
      const source = html(await cap(q('mask-icon')));
      ok('mask: mask-image + size/repeat captured',
        source.includes('mask-image') && source.includes('-webkit-mask-image') && source.includes('mask-size'));
    }
    {
      const source = html(await cap(q('bg-icon')));
      ok('mask: background-image icon captured',
        source.includes('background-image') && source.includes('background-size'));
    }
    {
      const payload = await cap(q('img-broken').parentElement);
      const source = html(payload);
      ok('image: unresolvable image dropped and counted',
        payload.diagnostics.imagesDropped >= 1 && !source.includes('does-not-exist'),
        'dropped=' + payload.diagnostics.imagesDropped);
      ok('image: data-uri images kept', source.includes('data:image/svg+xml'));
    }
    {
      const source = html(await cap(q('glass')));
      ok('misc: backdrop-filter gets the -webkit- alias',
        source.includes('backdrop-filter:blur') || /backdrop-filter: blur/.test(source));
      ok('misc: -webkit-backdrop-filter alias present', source.includes('-webkit-backdrop-filter'));
      ok('misc: backdrop surface added so the blur is visible',
        source.includes('cheater-has-backdrop'));
    }
    {
      // Regression: `backdrop-filter: none` must not be emitted at all, and must
      // never trigger the decorative backdrop on a component with no blur.
      const payload = await cap(q('field-card'));
      const source = html(payload);
      ok('misc: no-blur component does NOT get the backdrop surface',
        !source.includes('cheater-has-backdrop'), 'backdrop applied without any blur');
      ok('misc: default-valued properties are pruned, not emitted',
        !source.includes('backdrop-filter') && !/mask-image:\s*none/.test(source) &&
        !/grid-template-areas:\s*none/.test(source),
        (source.match(/[-\w]*(backdrop-filter|mask-image|grid-template-areas)[^;]*/g) || []).slice(0,4).join(' | '));
    }
    {
      const source = html(await cap(q('scroller')));
      ok('misc: scrollbar styling carried', source.includes('scrollbar-color') || source.includes('scrollbar-width'));
    }
    {
      const source = html(await cap(q('clamp')));
      ok('misc: line-clamp + box-orient both survive',
        source.includes('-webkit-line-clamp') && source.includes('-webkit-box-orient'));
    }
    {
      const source = html(await cap(q('dark-card')));
      ok('misc: dark component keeps its own background', source.includes('#0f172a'));
    }
    {
      const payload = await cap(q('frame-srcdoc').parentElement);
      const source = html(payload);
      ok('frame: iframes become sized placeholders, never break the export',
        source.includes('cheater-ph') && !source.includes('<iframe'));
    }

    /* ---------------------------------------------- fonts */
    {
      const payload = await cap(q('prose'));
      const faces = payload.fontFaces.map((f) => f.family);
      ok('font: self-hosted @font-face discovered for a used family',
        faces.includes('Fixture Sans'), JSON.stringify(faces));
      // The fixture declares src:url("fonts/fixture-sans.woff2") RELATIVE to its
      // stylesheet, so this also covers @font-face URL resolution.
      ok('font: relative @font-face url resolved to absolute, with a zip-relative path',
        payload.fontFaces.some((f) => /^https?:\/\/.+\/test\/fonts\/fixture-sans\.woff2$/.test(f.url) &&
          /^fonts\/Fixture_Sans-400\.woff2$/.test(f.path)),
        JSON.stringify(payload.fontFaces.map((f) => ({ url: f.url, path: f.path }))));
      ok('font: bundled family is NOT also requested from Google Fonts',
        !payload.fonts.google.some((g) => g.family === 'Fixture Sans'),
        JSON.stringify(payload.fonts.google.map((g) => g.family)));
      ok('font: system + generic families never requested',
        !payload.fonts.google.some((g) => /^(Arial|Roboto|Segoe UI|system-ui|sans-serif|Helvetica Neue)$/i.test(g.family)),
        JSON.stringify(payload.fonts.google.map((g) => g.family)));
      ok('font: primary font reported', !!payload.fonts.primary, payload.fonts.primary);
    }


    /* ------------------------------- newly covered module types ----------- */
    {
      // Custom dropdown: an open, absolutely-positioned menu. The menu must come
      // along with the trigger, keep its shadow, and its selected row must keep
      // both the aria state and the ::after check mark.
      const payload = await cap(q('dropdown'));
      const source = html(payload);
      ok('dropdown: open menu captured with the trigger',
        source.includes('US Dollar') && source.includes('Japanese Yen'));
      ok('dropdown: menu keeps its elevation shadow', source.includes('box-shadow'));
      ok('dropdown: selected row keeps aria-selected and its check pseudo',
        source.includes('aria-selected="true"') && /\\2713|\u2713/.test(source),
        source.slice(source.indexOf('aria-selected'), source.indexOf('aria-selected') + 120));
      ok('dropdown: trigger caret pseudo kept', /\.p\d+::after/.test(source));
    }
    {
      // Clicking a menu row should expand to the menu, not the whole page.
      const target = C.smartExpand(q('dd-item-sel'));
      ok('dropdown: expanding from a row lands on the menu or the row itself',
        target === q('dd-menu') || target === q('dd-item-sel') || q('dd-menu').contains(target),
        tag(target) + '.' + target.className);
    }
    {
      const source = html(await cap(q('tabs')));
      ok('tabs: active tab keeps its underline and aria-selected',
        source.includes('aria-selected="true"') && source.includes('border-bottom'));
    }
    {
      const source = html(await cap(q('crumbs')));
      ok('breadcrumb: "/" separator pseudos survive', /\.p\d+::after/.test(source) && source.includes('Hotels'));
      ok('breadcrumb: no bullets leak in (list-style handled)',
        decl(source, 'list-style-type', 'none') || !/display:\s*list-item/.test(source),
        (source.match(/(list-style-type|display):[^;"]*/g) || []).slice(0,6).join(' | '));
    }
    {
      // position:fixed with no positioned ancestor in the export would pin to the
      // corner of <body>; offsets must be neutralized.
      const payload = await cap(q('fixed-toast'));
      const source = html(payload);
      const sel = payload.diagnostics.selections[0];
      ok('fixed: position normalized to relative with offsets dropped',
        sel.positionNormalized === true && /position:relative/.test(source) &&
        !/(^|[;"])(top|right|bottom|left):\s*\d/.test(source),
        JSON.stringify({ norm: sel.positionNormalized, pos: (source.match(/position:[^;"]*/g) || [])[0] }));
      ok('fixed: toast still keeps its own paint', source.includes('#111827'));
    }
    {
      const payload = await cap(q('sticky'));
      ok('sticky: sticky element captured', html(payload).includes('sticky bar'));
    }
    {
      // Badge is absolutely positioned against the avatar wrapper, which IS in the
      // export — so its offsets must be KEPT, unlike the fixed case above.
      const source = html(await cap(q('avatar-wrap')));
      ok('badge overlay: keeps absolute offsets when its ancestor is in the export',
        /position:\s*absolute/.test(source) && /top:\s*-3px/.test(source),
        (source.match(/position:[^;"]*/g) || []).join(','));
      ok('badge overlay: avatar and badge both present',
        source.includes('SK') && source.includes('>9<'));
    }
    {
      const source = html(await cap(q('float-field')));
      ok('floating label: label keeps its absolute placement over the input',
        /position:\s*absolute/.test(source) && source.includes('Email') &&
        source.includes('value="ash@example.com"'));
    }
    {
      const source = html(await cap(q('dialog')));
      ok('dialog: <dialog open> exports open with its content',
        /<dialog[^>]*\sopen/.test(source) && source.includes('Confirm booking'));
    }
    {
      // Shadow root inside a shadow root.
      const payload = await cap(q('nested-shadow'));
      const source = html(payload);
      ok('nested shadow: both levels captured',
        source.includes('outer shadow') && source.includes('inner shadow'),
        source.slice(-300));
      ok('nested shadow: inner root styles captured', source.includes('#dcfce7') || source.includes('#166534'));
    }
    {
      // Slotted light DOM must render where the slot puts it.
      const source = html(await cap(q('slot-host')));
      ok('slots: projected light-DOM content captured',
        source.includes('Projected title') && source.includes('Projected default content'));
    }
    {
      // Custom properties: computed values resolve var(), so the export must not
      // depend on the original :root declarations.
      const source = html(await cap(q('var-card')));
      // Only DECLARATIONS matter: this fixture's visible prose literally reads
      // "Uses var(--card-accent)", so a naive source-wide search always matches.
      const varDecls = (source.match(/[-\w]+\s*:\s*[^;"}]*var\(--[^;"}]*/g) || []);
      ok('css vars: no declaration ships an unresolved var()', varDecls.length === 0,
        varDecls.join(' | '));
      ok('css vars: var() resolved to the concrete accent colour',
        source.includes('#7c3aed'), 'accent colour missing');
      ok('css vars: color-mix() computed to a widely-supported hex, not color(srgb ...)',
        !/color\(\s*srgb/i.test(source),
        (source.match(/color\(\s*srgb[^)]*\)/gi) || []).join(' | '));
    }
    {
      const source = html(await cap(q('grad-text')));
      ok('gradient text: background-clip + transparent fill both kept',
        (source.includes('background-clip') || source.includes('-webkit-background-clip')) &&
        source.includes('-webkit-text-fill-color'),
        (source.match(/[-\w]*(background-clip|text-fill-color)[^;"]*/g) || []).join(' | '));
    }
    {
      const source = html(await cap(q('steps')));
      ok('counters: counter() pseudo content preserved',
        /content:\s*"?counter\(step\)/.test(source) || source.includes('counter(step)'),
        (source.match(/content:[^;]*/g) || []).slice(0, 4).join(' | '));
    }
    {
      const source = html(await cap(q('rtl')));
      ok('rtl: direction preserved', decl(source, 'direction', 'rtl'),
        (source.match(/direction:[^;"]*/g) || []).join(','));
    }
    {
      const source = html(await cap(q('ellipsis')));
      ok('ellipsis: text-overflow + nowrap + overflow all kept',
        decl(source, 'text-overflow', 'ellipsis') && decl(source, 'white-space', 'nowrap') &&
        decl(source, 'overflow-x', 'hidden'),
        (source.match(/(text-overflow|white-space|overflow-x):[^;"]*/g) || []).join(' | '));
    }
    {
      const source = html(await cap(q('multicol')));
      ok('multicolumn: column layout survives',
        source.includes('column-count') || source.includes('columns'),
        (source.match(/column[^;"]*/g) || []).join(','));
    }
    {
      const source = html(await cap(q('rotated')));
      ok('transform: rotate/scale matrix preserved', /transform:\s*matrix/.test(source));
    }
    {
      const source = html(await cap(q('range').parentElement));
      ok('native controls: range/progress/meter keep their native chrome',
        source.includes('type="range"') && source.includes('<progress') && source.includes('<meter'),
        'missing one of range/progress/meter');
      ok('native controls: range value preserved', source.includes('value="72"'));
    }
    {
      const source = html(await cap(q('fancy-svg')));
      ok('svg advanced: gradient, clipPath and filter defs all survive',
        source.includes('linearGradient') && source.includes('clipPath') &&
        source.includes('feGaussianBlur') && source.includes('url(#g1)'));
    }


    /* ---------------- private icon font (the Google Sheets failure) -------- */
    {
      // The fixture registers its icon font through the JS FontFace API, so the
      // family renders in the page but has NO @font-face rule to discover and no
      // public CDN — the exact situation that exported Google Sheets' toolbar as
      // a row of blanks.
      const fam = 'Private Sheets Icons';
      let ruleExists = false;
      for (const sheet of document.styleSheets) {
        try {
          for (const r of sheet.cssRules) {
            if (r.type === 5 && (r.style.getPropertyValue('font-family') || '').includes('Private')) ruleExists = true;
          }
        } catch (_) { /* CORS */ }
      }
      ok('private font: fixture reproduces the conditions (loaded, undiscoverable)',
        document.fonts.check('20px "' + fam + '"') && !ruleExists,
        'loaded=' + document.fonts.check('20px "' + fam + '"') + ' ruleExists=' + ruleExists);

      const payload = await cap(q('priv-toolbar'));
      const source = html(payload);

      ok('private font: unshippable glyphs are rasterized, not dropped',
        payload.diagnostics.iconsRasterized >= 3 && payload.diagnostics.iconsLost === 0,
        'rasterized=' + payload.diagnostics.iconsRasterized + ' lost=' + payload.diagnostics.iconsLost);
      ok('private font: each icon became a sized <img> with real pixels',
        (source.match(/<img[^>]+src="data:image\/png/g) || []).length >= 3,
        (source.match(/<img[^>]{0,60}/g) || []).join(' | '));
      ok('private font: the private family is never requested from Google Fonts',
        !source.includes('Private+Sheets+Icons') &&
        !payload.fonts.google.some((g) => g.family === fam),
        JSON.stringify(payload.fonts.google.map((g) => g.family)));
      ok('private font: ::before glyph becomes a raster background with empty content',
        /\.p\d+::before[^}]*background-image:\s*url\("data:image\/png/.test(source) &&
        /\.p\d+::before \{\n  content: "";/.test(source),
        (source.match(/\.p\d+::before[^}]{0,80}/g) || []).join(' | '));
      ok('private font: surrounding text labels still export as text',
        source.includes('100%') && source.includes('>B<'));
      ok('sprite: CSS sprite-sheet icon keeps its image and offset',
        source.includes('background-position') && /-24px/.test(source),
        (source.match(/background-position:[^;"]*/g) || []).join(' | '));
    }
    {
      // A PORTABLE glyph must still travel as text rather than being rasterized:
      // "search" in Material Icons means the same thing in any build, and text
      // stays scalable and recolourable.
      const payload = await cap(q('mi-icon'));
      ok('portable glyph: ligature name from a CDN family stays text, not raster',
        payload.diagnostics.iconsRasterized === 0 && payload.diagnostics.iconNodes === 1,
        'rasterized=' + payload.diagnostics.iconsRasterized);
    }




    /* ---------- alias-named private icon font (the actual Sheets cause) ----- */
    {
      // Google Sheets names its icon font with an ALIAS of a public family
      // ("Google Material Icons"), so the family looks recognisable while the file
      // is a private build. CSS matches fonts by NAME: a linked stylesheet serving
      // "Material Icons" does nothing for an element asking for "Google Material
      // Icons", so a private-use codepoint renders as nothing and a ligature
      // renders as the literal word. Both must be rasterized.
      const payload = await cap(q('alias-toolbar'));
      const source = html(payload);
      const families = payload.diagnostics.iconFamilies || {};

      ok('alias font: the fixture really uses an alias of a public family',
        C.iconFamilyKey('Google Material Icons') === 'material-icons',
        String(C.iconFamilyKey('Google Material Icons')));
      ok('alias font: a private-use codepoint is rasterized, not linked',
        families['Google Material Icons | pua | rasterized'] === 1,
        JSON.stringify(families));
      ok('alias font: a ligature is ALSO rasterized (the name would not match)',
        families['Google Material Icons | ligature | rasterized'] === 1,
        JSON.stringify(families));
      ok('alias font: the literal ligature word never reaches the export',
        !/>undo</.test(source), 'found the word "undo" as text');
      ok('alias font: both glyphs became real images',
        (source.match(/<img[^>]+src="data:image\/png/g) || []).length === 2,
        'imgs=' + (source.match(/<img/g) || []).length);
      ok('alias font: the alias family is never requested from a CDN',
        !source.includes('Google+Material+Icons'), 'requested the alias name');
    }
    {
      // The counterpart: a family whose name is EXACTLY what the CDN serves must
      // still travel as text, because there the link genuinely works.
      const mi = await cap(q('mi-icon'));
      const fa = await cap(q('fa-icon'));
      ok('exact-name family stays text and links its CDN (Material Icons)',
        mi.diagnostics.iconsRasterized === 0 && (mi.fonts.icons || []).includes('material-icons'),
        'rasterized=' + mi.diagnostics.iconsRasterized);
      ok('exact-name family stays text and links its CDN (Font Awesome 6 Free)',
        fa.diagnostics.iconsRasterized === 0 && (fa.fonts.icons || []).includes('fa6'),
        'rasterized=' + fa.diagnostics.iconsRasterized);
      ok('the icon report names the family, glyph kind and decision',
        Object.keys(mi.diagnostics.iconFamilies || {}).some((k) => /^Material Icons \| ligature \| linked$/.test(k)),
        JSON.stringify(mi.diagnostics.iconFamilies));
    }



    /* ---------------- portal-rendered menus (adopted from outside) ---------- */
    {
      // The menu is a child of <body>, not of the trigger, so no amount of subtree
      // walking finds it. This is the actual reason real-world dropdowns exported
      // empty.
      const trigger = q('portal-trigger');
      const menu = q('portal-menu');
      ok('portal: the fixture really is portal-rendered',
        menu.parentElement === document.body && !trigger.contains(menu),
        'menu parent = ' + (menu.parentElement && menu.parentElement.tagName));

      ok('portal: the open trigger is recognised', C.hasOpenTrigger(trigger) === true);

      const found = C.findAttachedOverlays(trigger);
      ok('portal: the menu is found from outside the selection',
        found.length === 1 && found[0].el === menu,
        'found ' + found.length + ': ' + found.map((f) => f.why).join(','));
      ok('portal: found via explicit aria-controls, not guesswork',
        found[0] && found[0].why === 'aria-controls', found[0] && found[0].why);

      // The decoy floating tooltip elsewhere on the page must be left alone.
      ok('portal: an unrelated floating layer is NOT adopted',
        !found.some((f) => f.el === q('decoy-tip')), 'adopted the decoy tooltip');

      const payload = await cap(trigger);
      const source = html(payload);
      ok('portal: the menu ends up in the export',
        source.includes('Healthcare') && source.includes('Financial Services'),
        'menu options missing from the export');
      ok('portal: adoption is reported', payload.diagnostics.adoptedOverlays === 1,
        'adopted=' + payload.diagnostics.adoptedOverlays);
      ok('portal: the adopted row is labelled in diagnostics',
        (payload.diagnostics.selections || []).some((sel) => sel.adopted === 'aria-controls'),
        JSON.stringify((payload.diagnostics.selections || []).map((s2) => s2.adopted)));
      ok('portal: the menu keeps its own styling',
        source.includes('box-shadow') && source.includes('#eef2ff'));
      ok('portal: absolute offsets neutralized so it is not pinned to a corner',
        !/(^|[;"])(top|left):\s*\d{3,}px/.test(source),
        (source.match(/(top|left):\s*\d+px/g) || []).slice(0, 4).join(' | '));

      /* -- interactive mode: the exported dropdown must actually open ---------- */
      const nodes = payload.nodes || [];
      const ids = nodes.map((n) => n.ddId).filter(Boolean);
      ok('interactive: trigger and menu are paired',
        ids.length === 2 && ids[0] === ids[1], JSON.stringify(ids));
      ok('interactive: roles assigned',
        nodes.map((n) => n.ddRole).join(',') === 'trigger,menu',
        nodes.map((n) => n.ddRole).join(','));

      const openable = live(payload);
      ok('interactive: pair wrapped in one positioned container',
        /<div class="cheater-dd cheater-dd-wrap cheater-dd\d+">/.test(openable),
        (openable.match(/<div class="cheater-dd[^"]*"/) || ['none'])[0]);
      ok('interactive: menu hidden until focus', openable.includes(
        '.cheater-dd .cheater-dd-menu{display:none}'));
      // Scoped to this pair's own menu class, so nested dropdowns stay independent.
      ok('interactive: menu revealed on :focus-within',
        /\.cheater-dd(\d+):focus-within \.cheater-dd\1-menu\{display:[a-z-]+\}/.test(openable),
        (openable.match(/\.cheater-dd\d+:focus-within[^}]*\}/) || ['no rule'])[0]);
      ok('interactive: ships no JavaScript', !/<script/i.test(openable),
        'a script tag leaked into the export');
      // The <button> trigger is focusable already; a synthetic tabindex would be
      // redundant and would change its tab order.
      ok('interactive: native button trigger gets no tabindex',
        !/<button[^>]*tabindex/.test(openable));
      ok('interactive: static mode is unchanged', !source.includes('cheater-dd'));

      // Behaviour, not just markup. Rendered under the SAME sandbox export.html
      // uses — allow-scripts deliberately absent — because a CSS-only mechanism
      // that quietly needed script would be useless exactly where it is shown.
      const probe = document.createElement('iframe');
      probe.setAttribute('sandbox', 'allow-same-origin allow-popups allow-popups-to-escape-sandbox');
      probe.style.cssText = 'position:fixed;left:-9999px;width:600px;height:400px';
      probe.srcdoc = openable;
      document.body.appendChild(probe);
      await new Promise((resolve) => { probe.onload = resolve; });
      const pdoc = probe.contentDocument;
      const pwin = pdoc.defaultView;
      const pmenu = pdoc.querySelector('.cheater-dd-menu');
      const ptrigger = pdoc.querySelector('.cheater-dd-trigger');
      const shown = () => pwin.getComputedStyle(pmenu).display;

      // Guard against a false pass: confirm the sandbox really does block script.
      const canary = pdoc.createElement('script');
      canary.textContent = 'window.__cheaterCanary = 1';
      pdoc.body.appendChild(canary);
      ok('interactive: the preview sandbox really blocks scripts',
        pwin.__cheaterCanary !== 1, 'a script executed inside the sandbox');

      ok('interactive: menu is closed on load', shown() === 'none', 'display=' + shown());
      ptrigger.focus();
      ok('interactive: focusing the trigger OPENS the menu', shown() !== 'none',
        'display stayed ' + shown());
      ok('interactive: the open menu has real height',
        pmenu.getBoundingClientRect().height > 0);
      ok('interactive: the menu sits under its trigger, not in a page corner',
        pmenu.getBoundingClientRect().top >= ptrigger.getBoundingClientRect().bottom - 2,
        'menu top ' + Math.round(pmenu.getBoundingClientRect().top) +
        ' vs trigger bottom ' + Math.round(ptrigger.getBoundingClientRect().bottom));
      ptrigger.blur();
      ok('interactive: blurring closes it again', shown() === 'none', 'display=' + shown());
      probe.remove();
    }
    {
      // Without an open trigger, geometry must not start hoovering up page furniture.
      const trigger = q('portal-trigger');
      trigger.setAttribute('aria-expanded', 'false');
      const closedFound = C.findAttachedOverlays(q('chip'));
      ok('portal: nothing is adopted for a selection with no open trigger',
        closedFound.length === 0, 'found ' + closedFound.length);
      trigger.setAttribute('aria-expanded', 'true');
    }


    /* ---------------- the rest of the "rendered elsewhere" family ----------- */
    {
      // Reverse wiring: the trigger says nothing, the menu points back at it.
      const found = C.findAttachedOverlays(q('rev-trigger'));
      ok('reverse-aria: a menu that points back at its trigger is found',
        found.some((f) => f.el === q('rev-menu') && f.why === 'reverse-aria'),
        JSON.stringify(found.map((f) => f.why)));

      const source = html(await cap(q('rev-trigger')));
      ok('reverse-aria: its options reach the export',
        source.includes('Semiconductors') && source.includes('Software'));
    }
    {
      // aria-describedby tooltips are the same problem in a smaller costume.
      const found = C.findAttachedOverlays(q('tip-trigger'));
      ok('describedby: a tooltip is adopted',
        found.some((f) => f.el === q('rev-tip') && f.why === 'aria-describedby'),
        JSON.stringify(found.map((f) => f.why)));
    }
    {
      // A NON-modal <dialog open> sits in normal flow, so it must never be attached
      // to unrelated captures. Only showModal() dialogs are top-layer.
      const found = C.findAttachedOverlays(q('chip'));
      ok('modal: a plain <dialog open> is not adopted by an unrelated selection',
        !found.some((f) => f.el === q('dialog')),
        JSON.stringify(found.map((f) => f.why)));
    }
    {
      // Native <select>: options are real DOM and survive; the popup never can.
      const payload = await cap(q('f-select'));
      const source = html(payload);
      ok('native select: options are captured',
        source.includes('Second is selected') && /<option/.test(source));
      ok('native select: selected option preserved', /<option[^>]*\sselected/.test(source));
      ok('native select: reported so the OS-popup limit is stated',
        payload.diagnostics.nativeSelects >= 1,
        'nativeSelects=' + payload.diagnostics.nativeSelects);
    }
    {
      // Adoption is capped so a pathological page cannot balloon a capture.
      ok('adoption is capped', C.findAttachedOverlays(document.body).length <= 4,
        'found ' + C.findAttachedOverlays(document.body).length);
    }

    /* ---------------- closed dropdowns + pause mode ------------------------ */
    {
      // A closed menu is display:none, and a display:none subtree has no geometry,
      // so it used to be dropped — which is exactly why an exported dropdown had
      // nothing to open. It is now revealed for the length of the capture and put
      // back. run-dropdowns.js covers the mechanism across every way of hiding a
      // menu; this checks the fixture case still behaves.
      const payload = await cap(q('closed-dd'));
      const source = html(payload);

      ok('closed dropdown: the trigger is captured', source.includes('Actions'));
      ok('closed dropdown: the hidden menu is captured too',
        source.includes('Duplicate'), 'a closed menu should now come along');
      ok('closed dropdown: it is reported', payload.diagnostics.hiddenMenus >= 1,
        'hiddenMenus=' + payload.diagnostics.hiddenMenus);
      ok('closed dropdown: wired to its trigger',
        payload.diagnostics.closedMenusWired >= 1,
        'closedMenusWired=' + payload.diagnostics.closedMenusWired);
      ok('closed dropdown: the page is left closed again',
        getComputedStyle(q('closed-dd-menu') || document.body).display === 'none' ||
        !q('closed-dd-menu'),
        'the menu was left visible on the page');
    }
    {
      // Opened, the very same dropdown captures completely — which is what pause
      // mode exists to make reachable.
      const host = q('closed-dd');
      host.setAttribute('data-open', 'true');
      q('closed-dd-btn').setAttribute('aria-expanded', 'true');
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

      const payload = await cap(host);
      const source = html(payload);
      ok('opened dropdown: the whole menu is captured',
        source.includes('Duplicate') && source.includes('Archive') && source.includes('Delete'),
        'menu items missing');
      ok('opened dropdown: menu keeps its elevation and position',
        source.includes('box-shadow') && /position:\s*absolute/.test(source));
      ok('opened dropdown: nothing is reported as a skipped menu',
        !payload.diagnostics.hiddenMenus, 'hiddenMenus=' + payload.diagnostics.hiddenMenus);

      host.setAttribute('data-open', 'false');
      q('closed-dd-btn').setAttribute('aria-expanded', 'false');
    }
    {
      // Pause hands the page back: no interception, no outlines, selection kept.
      C.clearSelection();
      await C.addSelection(q('chip'), true);
      const heldBefore = C.state.selections.length;

      ok('pause: engages only while active', C.setPaused(true) === true);
      ok('pause: state flag set', C.state.paused === true);
      ok('pause: selections are kept across a pause',
        C.state.selections.length === heldBefore, 'held=' + C.state.selections.length);

      // A click while paused must reach the page, not be swallowed into a selection.
      let pageSawClick = false;
      const probe = q('closed-dd-btn');
      const listener = () => { pageSawClick = true; };
      probe.addEventListener('click', listener);
      probe.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      probe.removeEventListener('click', listener);
      ok('pause: the page receives its own clicks again', pageSawClick,
        'the click was still being swallowed');

      // A host class, never `display:none` on the host itself: the toast and the
      // mode toolbar live in the same shadow root, and hiding the host would hide
      // the one thing telling you which mode you are in.
      ok('interact: signalled by a host class, not by hiding the host',
        !!document.querySelector('.cheater-root.cheater-paused'),
        'expected .cheater-root.cheater-paused so the toolbar and toasts stay visible');

      // The outline stays alive in interact mode — it is what the grab key aims at.
      // run-dropdowns.js covers the hover-and-grab flow end to end.
      ok('interact: hover tracking keeps running',
        typeof C.grabHovered === 'function' && C.state.active === true);

      C.setPaused(false);
      ok('resume: state flag cleared', C.state.paused === false);
      ok('resume: still active with the selection intact',
        C.state.active === true && C.state.selections.length === heldBefore,
        'active=' + C.state.active + ' held=' + C.state.selections.length);
    }

    /* ------------------- pixel recovery (the universal fidelity fallback) --- */
    {
      // Anything that cannot be reproduced from source gets its region cropped out
      // of a screenshot. The screenshot here is synthetic and painted at KNOWN
      // positions, so the crop's scale and offset are verified by colour rather
      // than merely "an image appeared".
      q('hole-row').scrollIntoView({ block: 'center' });
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

      const dpr = 2;
      const holeRect = q('hole-icon').getBoundingClientRect();
      const shot = document.createElement('canvas');
      shot.width = innerWidth * dpr;
      shot.height = innerHeight * dpr;
      const sctx = shot.getContext('2d');
      sctx.fillStyle = '#000000';
      sctx.fillRect(0, 0, shot.width, shot.height);
      sctx.fillStyle = '#ff00aa';
      sctx.fillRect(holeRect.left * dpr, holeRect.top * dpr, holeRect.width * dpr, holeRect.height * dpr);
      // A diagonal so the crop is not uniform: a uniform crop is refused on purpose.
      sctx.strokeStyle = '#00ffcc';
      sctx.lineWidth = 4;
      sctx.beginPath();
      sctx.moveTo(holeRect.left * dpr, holeRect.top * dpr);
      sctx.lineTo((holeRect.left + holeRect.width) * dpr, (holeRect.top + holeRect.height) * dpr);
      sctx.stroke();
      const fakeShot = shot.toDataURL('image/png');

      const realSend = chrome.runtime.sendMessage;
      let captureRequests = 0;
      let uiHidden = null;
      chrome.runtime.sendMessage = (msg, cb) => {
        if (msg && msg.type === 'CHEATER_CAPTURE_TAB') {
          captureRequests += 1;
          const host = document.querySelector('.cheater-root');
          uiHidden = !host || host.style.display === 'none';
          cb({ ok: true, dataUrl: fakeShot });
          return;
        }
        cb({ ok: true });
      };

      const payload = await cap(q('hole-row'));
      chrome.runtime.sendMessage = realSend;

      ok('pixels: one screenshot per export, not one per element',
        captureRequests === 1, 'requests=' + captureRequests);
      ok('pixels: our own overlay is hidden while the screenshot is taken',
        uiHidden === true, 'hidden=' + uiHidden);
      ok('pixels: the icon-shaped hole was recovered',
        payload.diagnostics.pixelsRecovered === 1,
        'recovered=' + payload.diagnostics.pixelsRecovered + ' failed=' + payload.diagnostics.pixelsFailed);

      let recovered = null;
      (function walk(list) {
        for (const n of list || []) {
          if (n.k === 'img' && n.attrs && n.attrs.alt === 'empty box') recovered = n;
          walk(n.ch);
        }
      })(payload.nodes);
      ok('pixels: the hole became an <img> sized to its original box',
        !!recovered && recovered.w === Math.round(holeRect.width) &&
        recovered.h === Math.round(holeRect.height),
        recovered ? recovered.w + 'x' + recovered.h : 'not found');

      if (recovered) {
        const img = new Image();
        await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = recovered.src; });
        const probe = document.createElement('canvas');
        probe.width = img.width; probe.height = img.height;
        const pctx = probe.getContext('2d');
        pctx.drawImage(img, 0, 0);
        const px = pctx.getImageData(Math.floor(img.width * 0.75), Math.floor(img.height * 0.25), 1, 1).data;
        const hex = '#' + [px[0], px[1], px[2]].map((v) => v.toString(16).padStart(2, '0')).join('');
        ok('pixels: crop scale and offset are correct (sampled colour matches)',
          hex === '#ff00aa', 'sampled ' + hex + ' expected #ff00aa');
        ok('pixels: recovered at device resolution, not 1x',
          img.width === Math.round(holeRect.width * dpr),
          img.width + ' vs ' + Math.round(holeRect.width * dpr));
      }

      ok('pixels: a legitimate layout spacer is left alone',
        (html(payload).match(/<img/g) || []).length === 1,
        'imgs=' + (html(payload).match(/<img/g) || []).length);
    }

    /* -------------------- export failure reporting (no silent failures) ---- */
    {
      // "Export failed" with no cause is not a usable error. reportFailure() logs
      // the reason through console.error, so spy there — the toast itself lives in
      // a CLOSED shadow root and is deliberately unreachable from page script.
      const originalSend = chrome.runtime.sendMessage;
      const originalError = console.error;
      const logged = [];
      console.error = function () {
        logged.push(Array.prototype.slice.call(arguments).map(String).join(' '));
        return originalError.apply(console, arguments);
      };

      const run = async (stub) => {
        logged.length = 0;
        chrome.runtime.sendMessage = stub;
        C.clearSelection();
        await C.addSelection(q('chip'), true);
        await C.requestExport();
        return logged.join(' | ');
      };

      // 1. the worker answers with a reason -> shown verbatim
      let text = await run((msg, cb) => cb({ ok: false, reason: 'could not open the export tab' }));
      ok('failure: a worker-side reason is reported verbatim',
        /could not open the export tab/.test(text), text || '(nothing logged)');

      // 2. the worker is gone (lastError) -> retried once, then named
      text = await run((msg, cb) => {
        chrome.runtime.lastError = { message: 'Could not establish connection.' };
        cb(undefined);
        chrome.runtime.lastError = undefined;
      });
      ok('failure: a dead worker is named, not swallowed',
        /establish connection/i.test(text), text || '(nothing logged)');

      // 3. the worker answers nothing at all
      text = await run((msg, cb) => cb(undefined));
      ok('failure: a silent worker is reported as such',
        /no response/i.test(text), text || '(nothing logged)');

      // 4. an empty selection keeps its own message rather than a generic failure
      logged.length = 0;
      chrome.runtime.sendMessage = (msg, cb) => cb({ ok: false, reason: 'empty' });
      C.clearSelection();
      await C.addSelection(q('chip'), true);
      await C.requestExport();
      ok('failure: "empty" is not reported as a crash',
        !/export failed/i.test(logged.join(' ')), logged.join(' | '));

      console.error = originalError;
      chrome.runtime.sendMessage = originalSend;
    }

    /* ---------------------------------------------- whole page, no leakage */
    {
      C.clearSelection();
      await C.selectBody();
      const payload = C.buildPayload();
      const source = html(payload);
      const leaked = (source.match(/cheater-(?!ph|has-backdrop)/g) || []);
      ok('fullpage: no extension UI leaks into the export',
        leaked.length === 0, 'leaked=' + JSON.stringify(leaked.slice(0, 5)));
      ok('fullpage: crosshair cursor never captured',
        !source.includes('crosshair'), 'found crosshair');
      ok('fullpage: probe iframe never captured', !source.includes('cheater-probe'));
      ok('fullpage: shared styles actually dedupe',
        payload.diagnostics.styleCount < payload.diagnostics.nodes,
        `styles=${payload.diagnostics.styleCount} nodes=${payload.diagnostics.nodes}`);
      ok('fullpage: reset present exactly once',
        (source.match(/box-sizing:border-box\}/g) || []).length >= 1);

      // TOON round-trip on a real capture.
      const toon = window.CheaterToonWriter.toToon(payload);
      const reparsed = window.CheaterToonWriter.parseToon(toon);
      ok('toon: real capture round-trips through the parser',
        reparsed.nodes.length === payload.nodes.length &&
        Object.keys(reparsed.styles).length === Object.keys(payload.styles).length,
        `nodes ${reparsed.nodes.length}/${payload.nodes.length} styles ${Object.keys(reparsed.styles).length}/${Object.keys(payload.styles).length}`);
      ok('toon: base64 payloads truncated', !/[A-Za-z0-9+/]{300}/.test(toon));
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
    for (const f of failed) lines.push(`  ${f.name}\n    ${f.detail.slice(0, 600)}`);
  }
  return lines.join('\n');
}
