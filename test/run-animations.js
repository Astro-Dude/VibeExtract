/**
 * Cheater — animation harness.
 *
 * `animation` was dropped outright, so an animated component exported as a dead one.
 * Capturing the longhands is only half of it: an `animation-name` referring to
 * @keyframes that did not travel animates nothing at all, so the referenced rules
 * have to come too — and ONLY the referenced ones, or a framework's whole animation
 * library rides along in every capture.
 *
 * Assertions are behavioural where they can be: the export is rendered and the
 * element's computed animation is read back, plus a sampled property is checked to
 * be genuinely changing over time.
 *
 * Run: node test/cdp-runner.js run-animations
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
  await page.goto(BASE + '/test/animations.html');
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
    const html = (p) => W.build(p, { fontMode: 'relative' });

    const render = async (source) => {
      const frame = document.createElement('iframe');
      frame.setAttribute('sandbox', 'allow-same-origin');
      frame.style.cssText = 'position:fixed;left:-9999px;top:0;width:700px;height:500px;border:0';
      frame.srcdoc = source;
      document.body.appendChild(frame);
      await new Promise((r) => { frame.onload = r; });
      return { doc: frame.contentDocument, win: frame.contentDocument.defaultView, done: () => frame.remove() };
    };

    C.activate();

    /* ------------------------------------------------------- the spinner ---- */
    {
      const payload = await cap(q('anim-spinner-host'));
      const source = html(payload);

      ok('spinner: the animation properties are captured',
        /animation-name:\s*cheater-spin/.test(source), 'animation-name is missing entirely');
      ok('spinner: duration captured', /animation-duration:\s*0?\.9s|900ms/.test(source),
        (source.match(/animation-duration:[^;"]*/) || ['none'])[0]);
      ok('spinner: iteration count captured', /animation-iteration-count:\s*infinite/.test(source));
      ok('spinner: the @keyframes definition travelled',
        /@keyframes\s+cheater-spin/.test(source),
        'animation-name points at nothing, so it animates nothing');
      ok('spinner: the keyframe body came with it',
        /rotate\(360deg\)/.test(source), 'the keyframes body is empty');

      // Only what is referenced: an unused animation must not ride along.
      ok('spinner: unreferenced @keyframes are NOT emitted',
        !/cheater-unused/.test(source),
        'a framework animation library would bloat every capture');
      ok('spinner: only the one animation is emitted',
        (source.match(/@keyframes/g) || []).length === 1,
        (source.match(/@keyframes\s+[\w-]+/g) || []).join(', '));

      // Behavioural: render it and confirm the element really is animating.
      const view = await render(source);
      const el = view.doc.querySelector('div[style*="border-top-color"], div');
      const spinner = Array.from(view.doc.querySelectorAll('*')).find((n) => {
        const cs = view.win.getComputedStyle(n);
        return cs.animationName === 'cheater-spin';
      });
      ok('spinner: the rendered export has a live animation', !!spinner,
        'nothing in the export computes to animation-name: cheater-spin');
      if (spinner) {
        const cs = view.win.getComputedStyle(spinner);
        ok('spinner: computed duration matches the original', cs.animationDuration === '0.9s',
          'duration=' + cs.animationDuration);
        ok('spinner: it is running, not paused', cs.animationPlayState === 'running',
          'play-state=' + cs.animationPlayState);
        // Sample the transform twice: a running animation changes it.
        const first = view.win.getComputedStyle(spinner).transform;
        await new Promise((r) => setTimeout(r, 180));
        const second = view.win.getComputedStyle(spinner).transform;
        ok('spinner: the transform actually CHANGES over time', first !== second,
          'transform stayed ' + first + ' — the animation is not running');
      }
      view.done();
      void el;
    }

    /* --------------------------------------------------------- the badge ---- */
    {
      const payload = await cap(q('anim-badge-host'));
      const source = html(payload);
      ok('badge: pulse animation captured', /animation-name:\s*cheater-pulse/.test(source));
      ok('badge: its keyframes travelled', /@keyframes\s+cheater-pulse/.test(source));
      ok('badge: percentage keyframe stops preserved',
        /opacity:\s*0?\.35/.test(source), 'the 50% stop is missing');
      ok('badge: timing function captured',
        /animation-timing-function:\s*ease-in-out/.test(source));
    }

    /* ------------------------------------------------------ the skeleton ---- */
    {
      // The one where the animation is the entire point of the component: without it
      // this is a flat grey bar.
      const payload = await cap(q('anim-skeleton-host'));
      const source = html(payload);
      ok('skeleton: shimmer animation captured', /animation-name:\s*cheater-shimmer/.test(source));
      ok('skeleton: its keyframes travelled', /@keyframes\s+cheater-shimmer/.test(source));
      ok('skeleton: the animated background survived', /linear-gradient/.test(source));
      ok('skeleton: background-size came too, or the shimmer has nothing to move',
        /background-size:\s*200%/.test(source),
        (source.match(/background-size:[^;"]*/) || ['none'])[0]);
    }

    /* --------------------------------- delay, direction, fill-mode ---------- */
    {
      const payload = await cap(q('anim-delayed-host'));
      const source = html(payload);
      ok('delayed: delay captured', /animation-delay:\s*0?\.4s/.test(source),
        (source.match(/animation-delay:[^;"]*/) || ['none'])[0]);
      ok('delayed: direction captured', /animation-direction:\s*alternate/.test(source));
      ok('delayed: fill-mode captured', /animation-fill-mode:\s*both/.test(source));
    }

    /* --------------------------------------- an explicitly paused animation - */
    {
      // Paused is a deliberate state, and replaying it as running would misrepresent
      // the component.
      const payload = await cap(q('anim-paused-host'));
      const source = html(payload);
      ok('paused: play-state is preserved as paused',
        /animation-play-state:\s*paused/.test(source),
        (source.match(/animation-play-state:[^;"]*/) || ['none'])[0]);
      const view = await render(source);
      const el = Array.from(view.doc.querySelectorAll('*')).find((n) =>
        view.win.getComputedStyle(n).animationName === 'cheater-pulse');
      ok('paused: still paused in the render', !!el &&
        view.win.getComputedStyle(el).animationPlayState === 'paused',
        el ? view.win.getComputedStyle(el).animationPlayState : 'element missing');
      view.done();
    }

    /* ------------------------------------ two animations on one element ----- */
    {
      const payload = await cap(q('anim-two-host'));
      const source = html(payload);
      ok('two: both names captured',
        /animation-name:\s*cheater-spin,\s*cheater-pulse/.test(source),
        (source.match(/animation-name:[^;"]*/) || ['none'])[0]);
      ok('two: BOTH keyframe sets travelled',
        /@keyframes\s+cheater-spin/.test(source) && /@keyframes\s+cheater-pulse/.test(source),
        (source.match(/@keyframes\s+[\w-]+/g) || []).join(', '));
    }

    /* ------------------------------------- no animation, no keyframes ------- */
    {
      const payload = await cap(q('anim-none-host'));
      const source = html(payload);
      ok('none: an element with only a transition emits no @keyframes',
        !/@keyframes/.test(source), 'keyframes leaked into a capture that needs none');
      ok('none: animation-name is not emitted as "none" noise',
        !/animation-name/.test(source), 'the default value was not pruned');
      ok('none: the transition itself is still captured',
        /transition/.test(source), 'transitions were captured before and must remain');
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
