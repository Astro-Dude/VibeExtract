/**
 * DOM Heist — normalizing reset for exported documents.
 *
 * This file is loaded three ways, so it stays a classic script with a UMD-ish tail:
 *   - content script (manifest `js` array)   → global `DomHeistReset`
 *   - export.html (<script src>)             → global `DomHeistReset`
 *   - scripts/toon-to-html.js (require)      → module.exports
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE IS LOAD-BEARING FOR THE CAPTURE, NOT JUST THE OUTPUT
 * ---------------------------------------------------------------------------
 * The capture prunes any computed value that equals the element's default, so
 * the export doesn't repeat 340 properties per node. That is only sound if the
 * pruning baseline is the value the element will actually have *in the exported
 * document* — i.e. user-agent styles AS MODIFIED BY THIS RESET. So the content
 * script injects RESET_CSS into its hidden probe iframe before reading defaults
 * (see buildDefaults() in contentScript.js). Change a rule here and the pruning
 * baseline changes with it, automatically and in lockstep.
 *
 * Consequence worth knowing before editing: only ever reset NON-INHERITED
 * properties freely. Non-inherited props are safe because the probe measures
 * them per tag, so any page value that differs survives capture. Inherited
 * props are pruned against the *parent's* computed value instead of the probe,
 * so resetting an inherited prop here can silently change how a captured
 * subtree renders. The one deliberate exception is `font`/`letter-spacing`/
 * `line-height` inheritance on form controls, which is safe in both directions
 * (see the FORM CONTROLS note below) and is the single biggest fidelity win in
 * the whole reset.
 *
 * Everything is wrapped in :where() so the reset has ZERO specificity and the
 * captured .sN class rules always win without a single !important.
 */
(function (name, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (typeof globalThis !== 'undefined' ? globalThis : self)[name] = api;
})('DomHeistReset', function () {
  var RESET_CSS = [
    /* Universal box model. Not :where() — this one is meant to be unconditional,
       and box-sizing is not something a capture should ever have to restate. */
    '*,*::before,*::after{box-sizing:border-box}',

    /* Document. The export surface sets its own background/color. */
    ':where(html){-webkit-text-size-adjust:100%}',
    ':where(body){margin:0;padding:0;min-height:0}',

    /* Block-level UA margins. All non-inherited, so a page value that differs
       is captured and re-emitted; zeroing them here just stops the UA's own
       margins from resurfacing once the page's reset is gone. */
    ':where(h1,h2,h3,h4,h5,h6,p,blockquote,figure,figcaption,pre,dl,dd,dt,' +
      'address,hr,fieldset,legend,form,menu,ul,ol,li,table,caption)' +
      '{margin:0;padding:0}',

    /* Headings: kill the UA's bold + 2em scale. font-size/font-weight are
       inherited, but heading defaults are a UA *rule*, not inheritance, so
       `inherit` here is what makes the probe report the parent value and the
       capture emit the page's real heading size. */
    ':where(h1,h2,h3,h4,h5,h6){font-size:inherit;font-weight:inherit}',

    /* Inline semantics the UA styles by rule. Restated because the capture
       prunes font-style/font-weight against the parent, which would otherwise
       drop the italic on a nested <em> whose parent is upright. */
    ':where(em,i,cite,var,address,dfn){font-style:italic}',
    ':where(strong,b){font-weight:bolder}',
    ':where(small){font-size:smaller}',
    ':where(s,del){text-decoration:line-through}',
    ':where(u,ins){text-decoration:underline}',
    ':where(sub,sup){font-size:smaller;line-height:0;position:relative;vertical-align:baseline}',
    ':where(sub){bottom:-.25em}',
    ':where(sup){top:-.5em}',
    ':where(abbr[title]){text-decoration:underline dotted}',

    /* Links: the UA's blue + underline is never what a captured component wants. */
    ':where(a){color:inherit;text-decoration:none;background-color:transparent}',

    /* Monospace elements: the UA uses a 13px monospace default that throws off
       metrics. Keep the family, drop the size quirk. */
    ':where(pre,code,kbd,samp,tt){font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:1em}',
    ':where(pre){overflow:auto}',

    /* -----------------------------------------------------------------------
       FORM CONTROLS
       Browsers do NOT inherit font, letter-spacing or line-height into form
       controls — they substitute a UA font (13.333px Arial on Chrome). Left
       alone, every captured field's text metrics shift, which is the #1 cause
       of "the export looks like it overflows but the original didn't".
       Safe in both directions: if the page set a font on the control, the
       computed value differs from the probe's `inherit`-resolved value and is
       captured explicitly; if the page relied on its own `font:inherit`, the
       computed value matches the parent, is pruned, and this rule reinstates it.
       ----------------------------------------------------------------------- */
    ':where(button,input,optgroup,select,textarea)' +
      '{font-family:inherit;font-size:inherit;font-weight:inherit;font-style:inherit;' +
      'line-height:inherit;letter-spacing:inherit;color:inherit;margin:0}',

    /* Strip UA chrome so a page's custom styling isn't drawn on top of it.
       The `select` case is specifically about the OS triangle: without
       appearance:none, a page's own chevron pseudo-element sits on top of the
       native one and every select in the export shows two arrows. */
    ':where(button,select,textarea,input){-webkit-appearance:none;appearance:none;' +
      'background-image:none;background-color:transparent;border:0;padding:0;border-radius:0}',
    ':where(button,[type="button"],[type="submit"],[type="reset"])' +
      '{text-align:inherit;cursor:pointer}',
    ':where(select){background-image:none}',
    ':where(textarea){resize:vertical;overflow:auto;white-space:pre-wrap}',
    ':where(:disabled){cursor:default}',
    ':where(::placeholder){color:inherit;opacity:.5}',
    ':where(:focus,:focus-visible){outline:none}',

    /* ...but these inputs ARE their native chrome. appearance:none renders a
       checkbox as an invisible zero-size box, so hand them back. */
    ':where(input[type="checkbox"],input[type="radio"],input[type="range"],' +
      'input[type="color"],input[type="file"],input[type="image"],' +
      'input[type="submit"],input[type="reset"],progress,meter)' +
      '{-webkit-appearance:auto;appearance:auto}',
    ':where(input[type="checkbox"],input[type="radio"]){width:auto;height:auto;margin:0}',

    /* Grouping boxes: the UA's groove border and legend padding are pure noise. */
    ':where(fieldset){border:0;min-width:0}',
    ':where(legend){padding:0;display:block}',

    /* The UA draws <hr> as an inset 2D border, which reads as a doubled line
       against any captured border. One hairline in currentColor instead. */
    ':where(hr){border:0;border-top:1px solid currentColor;height:0;opacity:.25;overflow:visible}',

    /* Tables: UA border-collapse:separate + 2px spacing adds phantom gutters. */
    ':where(table){border-collapse:collapse;border-spacing:0}',
    ':where(th){font-weight:inherit;text-align:inherit}',
    ':where(td,th){padding:0}',

    /* Media. Deliberately NOT display:block — `display` is non-inherited and
       probed per tag, so forcing block here would make every inline <img> in a
       capture carry an explicit display:inline. max-width only. */
    ':where(img,svg,video,canvas,audio,iframe,embed,object){max-width:100%}',
    ':where(img,video,canvas){height:auto}',
    ':where(img){border-style:none;vertical-align:middle}',
    ':where(svg:not([fill])){fill:currentColor}',

    /* Interactive disclosure. Left at UA display:list-item so a page relying on
       the native marker keeps it; the capture re-emits list-style:none when the
       page hid it. */
    ':where(summary){cursor:pointer}',

    /* Lists: list-style-type is INHERITED, so it is pruned against the parent
       and must not be reset here — doing so would drop bullets from any list
       whose parent chain resolves to `disc`. Padding is non-inherited and
       already zeroed above. */

    ':where([hidden]){display:none}'
  ].join('\n');

  /**
   * Surface for a capture that uses backdrop-filter. A blur over a flat body
   * background is invisible, which reads as "the effect didn't survive" when it
   * actually did. Only emitted when the capture contains backdrop-filter.
   */
  var BACKDROP_SURFACE_CSS = [
    'body.domheist-has-backdrop{',
    '  background-color:#1b1f2a;',
    '  background-image:',
    '    radial-gradient(at 18% 22%, rgba(255,178,36,.28) 0px, transparent 55%),',
    '    radial-gradient(at 82% 18%, rgba(86,156,214,.30) 0px, transparent 50%),',
    '    radial-gradient(at 72% 78%, rgba(197,134,192,.22) 0px, transparent 50%),',
    '    repeating-linear-gradient(45deg, rgba(255,255,255,.045) 0 12px, transparent 12px 24px);',
    '}'
  ].join('\n');

  return { RESET_CSS: RESET_CSS, BACKDROP_SURFACE_CSS: BACKDROP_SURFACE_CSS };
});
