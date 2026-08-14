/**
 * Cheater — content script. Runs in every frame of every page.
 *
 * Responsibilities, in the order the sections appear below:
 *   selection UI (hover highlight, indicator, selection box, toast)
 *   hit testing that pierces open shadow roots
 *   smart expansion: clicking a leaf yields the component it belongs to
 *   DOM navigation with a back-stack, shared by Alt+Arrow and the scroll wheel
 *   capture: DOM + computed style -> a frozen, serializable IR
 *   finalize: IR -> payload with shared style tables (pure, no DOM reads)
 *
 * TWO-PHASE CAPTURE, AND WHY
 * captureRaw() runs at *selection* time and reads everything it will ever need
 * from the DOM. finalize() runs at *export* time and touches no DOM at all. The
 * split is what freezes rotating carousels, ticking counters and "ProTip"
 * rotators to exactly what was on screen when you clicked — by export time the
 * live DOM may have moved on, and nothing in finalize() cares.
 */

(function () {
  'use strict';

  if (window.__cheaterInstalled) return;
  window.__cheaterInstalled = true;

  const PREFIX = 'cheater-';
  const RESET_CSS = (globalThis.CheaterReset && globalThis.CheaterReset.RESET_CSS) || '';

  /* ======================================================================== *
   * SECTION: tag / property tables
   * ======================================================================== */

  // Non-rendered machinery. A GTM <noscript> exporting as visible body text is
  // the specific bug this set prevents.
  const SKIP_TAGS = new Set([
    'script', 'style', 'noscript', 'template', 'link', 'meta', 'title', 'head',
    'base', 'param', 'source', 'track'
  ]);

  const REPLACED_TAGS = new Set(['img', 'svg', 'canvas', 'video', 'audio', 'iframe', 'embed', 'object', 'picture']);

  const VOID_TAGS = new Set([
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
    'param', 'source', 'track', 'wbr'
  ]);

  // Elements that are already components: never climb past them, never expand them.
  const STRUCTURAL_TAGS = new Set([
    'body', 'main', 'section', 'article', 'header', 'footer', 'nav', 'aside',
    'form', 'table', 'ul', 'ol', 'dl', 'figure', 'dialog', 'li', 'fieldset', 'tbody', 'thead'
  ]);

  /**
   * Never a meaningful expansion target — reaching one of these means the climb
   * has left the component and entered the page.
   *
   * `section`, `form`, `table` and the list containers are in here deliberately:
   * a section with a white background, a border, a radius and padding scores as a
   * near-perfect "container" on every heuristic, so without an explicit stop the
   * ascent sails straight past the card you clicked and hands back the whole
   * region. `li`, `fieldset` and `figure` are NOT here — those genuinely are the
   * component you meant when you click inside one.
   */
  const CLIMB_STOP_TAGS = new Set([
    'body', 'html', 'main', 'header', 'footer', 'nav', 'aside', 'article',
    'section', 'form', 'table', 'tbody', 'thead', 'tfoot', 'ul', 'ol', 'dl'
  ]);

  const LEAFISH_TAGS = new Set([
    'input', 'textarea', 'select', 'button', 'img', 'svg', 'i', 'span', 'em',
    'strong', 'b', 'a', 'label', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'td', 'th', 'small', 'code', 'time', 'abbr', 'use', 'path', 'g', 'circle', 'rect'
  ]);

  const SEMANTIC_ROLES = new Set([
    'button', 'group', 'listitem', 'option', 'menuitem', 'menuitemcheckbox',
    'menuitemradio', 'tab', 'checkbox', 'radio', 'switch', 'searchbox', 'combobox'
  ]);

  /**
   * A hidden subtree that looks like it is the component the user was after.
   *
   * A closed dropdown is display:none, so it is filtered out and the export simply
   * lacks the menu — with no hint as to why. Recognising these lets the
   * diagnostics say "open it first, then capture" instead of leaving you to guess.
   */
  const MENU_HINT_RE = /(dropdown|menu|listbox|popover|popup|combobox|autocomplete|flyout|submenu|tooltip|overlay-panel)/i;
  const MENU_ROLES = new Set(['menu', 'listbox', 'dialog', 'tooltip', 'combobox', 'tree', 'grid', 'menubar']);

  function looksLikeHiddenMenu(el) {
    const role = (el.getAttribute && el.getAttribute('role')) || '';
    if (MENU_ROLES.has(role)) return true;
    const hints = classListOf(el).join(' ') + ' ' +
      ((el.getAttribute && (el.getAttribute('data-testid') || el.getAttribute('id'))) || '');
    return MENU_HINT_RE.test(hints);
  }

  const CONTAINER_CLASS_RE = /(card|chip|tile|field|item|cell|box|badge|panel|control|input-group|form-group|btn|button|pill|widget|module|row|entry|option|node|block)/i;

  // Class names that read as "this is hidden right now" rather than "this is what
  // the thing looks like". Tried first when hunting for the class that hides a
  // closed menu, so we strip the state class and not the styling one.
  const STATE_CLASS_RE = /(hidden|hide|collapsed|closed|invisible|inactive|dismissed|d-none|sr-only|is-|js-|--closed|--hidden)/i;

  // What counts as the thing you click to open a menu.
  const TRIGGER_SELECTOR = [
    'button', 'summary', 'a[href]', '[role="button"]', '[role="combobox"]',
    '[aria-haspopup]', '[aria-expanded]', 'input', 'select', '[tabindex]'
  ].join(',');

  // A closed menu is revealed on the live page for the few milliseconds it takes to
  // capture it. Capped so a pathological page cannot turn one capture into fifty
  // reveals.
  const MAX_HIDDEN_MENUS = 6;

  const PROPS = [
    // layout
    'display', 'position', 'top', 'right', 'bottom', 'left', 'float', 'clear',
    'z-index', 'visibility', 'isolation', 'box-sizing',
    // flex
    'flex-direction', 'flex-wrap', 'flex-grow', 'flex-shrink', 'flex-basis',
    'justify-content', 'align-items', 'align-self', 'align-content', 'order',
    // `gap` and the place-* family are omitted deliberately: their computed
    // values duplicate row-gap/column-gap and align-*/justify-* below, and
    // emitting both makes every flex container list the same value three times.
    'row-gap', 'column-gap',
    // grid
    'grid-template-columns', 'grid-template-rows', 'grid-template-areas',
    'grid-auto-columns', 'grid-auto-rows', 'grid-auto-flow', 'grid-column',
    'grid-row', 'grid-area', 'justify-items', 'justify-self',
    // box model
    'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
    'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
    'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
    'aspect-ratio', 'overflow-x', 'overflow-y', 'resize',
    // border + outline
    'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
    'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style',
    'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
    'border-top-left-radius', 'border-top-right-radius',
    'border-bottom-right-radius', 'border-bottom-left-radius',
    'outline-width', 'outline-style', 'outline-color', 'outline-offset',
    // typography
    'color', 'font-family', 'font-size', 'font-weight', 'font-style',
    'font-variant', 'font-stretch', 'font-feature-settings', 'font-variation-settings',
    'line-height', 'letter-spacing', 'word-spacing', 'text-align', 'text-transform',
    'text-decoration-line', 'text-decoration-color', 'text-decoration-style',
    'text-decoration-thickness', 'text-underline-offset', 'text-indent',
    'text-overflow', 'text-shadow', 'white-space', 'word-break', 'overflow-wrap',
    'hyphens', 'vertical-align', 'writing-mode', 'direction', 'tab-size',
    '-webkit-font-smoothing', '-webkit-text-fill-color',
    '-webkit-line-clamp', '-webkit-box-orient',
    // paint
    'background-color', 'background-image', 'background-size', 'background-position',
    'background-repeat', 'background-attachment', 'background-clip',
    'background-origin', 'background-blend-mode', 'opacity', 'box-shadow',
    'filter', 'backdrop-filter', 'mix-blend-mode', 'clip-path',
    // mask (icon-as-shaped-box)
    'mask-image', 'mask-size', 'mask-position', 'mask-repeat', 'mask-mode',
    'mask-composite', 'mask-clip', 'mask-origin',
    '-webkit-mask-image', '-webkit-mask-size', '-webkit-mask-position',
    '-webkit-mask-repeat', '-webkit-mask-composite', '-webkit-mask-clip', '-webkit-mask-origin',
    // transform / motion
    'transform', 'transform-origin', 'rotate', 'scale', 'translate', 'transition',
    // tables
    'border-collapse', 'border-spacing', 'table-layout', 'caption-side', 'empty-cells',
    // lists
    'list-style-type', 'list-style-position', 'list-style-image',
    // media
    'object-fit', 'object-position',
    // svg presentation
    'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
    'stroke-dasharray', 'fill-opacity', 'stroke-opacity', 'fill-rule',
    // misc + scrollbars
    'cursor', 'pointer-events', 'user-select', 'appearance', '-webkit-appearance',
    'accent-color', 'caret-color', 'scrollbar-width', 'scrollbar-color', 'scrollbar-gutter'
  ];
  const PROP_SET = new Set(PROPS);

  // Inherited properties are pruned against the PARENT's computed value.
  // Non-inherited ones are pruned against the reset-adjusted per-tag default.
  const INHERITED = new Set([
    'color', 'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant',
    'font-stretch', 'font-feature-settings', 'font-variation-settings', 'line-height',
    'letter-spacing', 'word-spacing', 'text-align', 'text-transform', 'text-indent',
    'white-space', 'word-break', 'overflow-wrap', 'hyphens', 'writing-mode',
    'direction', 'tab-size', 'visibility', 'cursor', 'pointer-events', 'user-select',
    'list-style-type', 'list-style-position', 'list-style-image', 'border-collapse',
    'border-spacing', 'caption-side', 'empty-cells', 'accent-color', 'caret-color',
    'scrollbar-color', '-webkit-font-smoothing', '-webkit-text-fill-color',
    'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
    'stroke-dasharray', 'fill-opacity', 'stroke-opacity', 'fill-rule'
  ]);

  /**
   * Exempt from the INHERITED-value prune and from the transparent-value drop,
   * because for these a value identical to the parent's (or a fully transparent
   * one) is usually deliberate rather than noise.
   *
   * NOT exempt from the default-value prune: a property equal to its own default
   * is always safe to drop, since the exported document re-supplies exactly that.
   * Exempting them there was a bug — every single element ended up carrying
   * `backdrop-filter: none`, which then tripped the "this capture uses
   * backdrop-filter" check and painted the export's decorative backdrop behind
   * components that had no blur at all.
   */
  const PROTECTED_PROPS = new Set([
    'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
    'grid-template-areas', 'grid-area', 'backdrop-filter', 'mask-image',
    '-webkit-mask-image', 'aspect-ratio', '-webkit-line-clamp',
    // Transparent here is the whole point of the gradient-text technique
    // (background-clip:text + transparent fill). The generic
    // "drop fully transparent values" rule would delete it and render the text
    // in flat colour with the gradient hidden behind it.
    '-webkit-text-fill-color'
  ]);

  /**
   * Properties whose computed value is DERIVED FROM LAYOUT CONTEXT rather than
   * from anything the author wrote, so they are emitted only when the cascade
   * actually declares them.
   *
   * `min-width` is the motivating case: it computes to `auto` for a flex item and
   * `0px` for a block, so the per-tag probe can never match it and every flex
   * child ends up carrying `min-width: auto; min-height: auto` forever. Same
   * story for transform-origin (always a resolved px pair) and the max-* pair.
   */
  const AUTHORED_ONLY = new Set([
    'min-width', 'min-height', 'max-width', 'max-height',
    'transform-origin', 'flex-basis', 'vertical-align'
  ]);

  // Properties whose authored-ness we look up in the cascade: AUTHORED_ONLY plus
  // the explicit box dimensions the sizing policy consults.
  const AUTHORED_SENSITIVE = new Set([
    'min-width', 'min-height', 'max-width', 'max-height',
    'transform-origin', 'flex-basis', 'vertical-align', 'width', 'height'
  ]);

  // SVG presentation properties. Computed on every HTML element too, where they
  // are pure noise — an ordinary <span> reporting stroke-dasharray tells nobody
  // anything.
  const SVG_PRESENTATION_PROPS = new Set([
    'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
    'stroke-dasharray', 'fill-opacity', 'stroke-opacity', 'fill-rule'
  ]);

  /**
   * Inherited properties worth pinning at the ROOT of a capture, because the root
   * has no parent in the export to inherit from and these establish the text
   * rendering context the whole subtree depends on.
   *
   * Every other inherited property prunes against the probe default even at the
   * root. Without this split a root node carries its entire inherited state —
   * tab-size, empty-cells, hyphens, caption-side, the SVG paint family — none of
   * which affects how the component looks.
   */
  const ROOT_INHERITED = new Set([
    'color', 'font-family', 'font-size', 'font-weight', 'font-style',
    'font-feature-settings', 'font-variation-settings', 'line-height',
    'letter-spacing', 'text-align', 'text-transform', 'white-space',
    'direction', '-webkit-font-smoothing', 'list-style-type'
  ]);

  const PSEUDO_PROPS = PROPS.concat(['content']);

  /* ======================================================================== *
   * SECTION: font tables
   * ======================================================================== */

  const ICON_FAMILIES = new Map([
    ['material icons', 'material-icons'],
    ['material icons outlined', 'material-icons'],
    ['material icons round', 'material-icons'],
    ['material icons rounded', 'material-icons'],
    ['material icons sharp', 'material-icons'],
    ['material icons two tone', 'material-icons'],
    ['google material icons', 'material-icons'],
    ['material symbols outlined', 'material-symbols'],
    ['material symbols rounded', 'material-symbols'],
    ['material symbols sharp', 'material-symbols'],
    ['fontawesome', 'fa4'],
    ['font awesome 5 free', 'fa6'],
    ['font awesome 5 pro', 'fa6'],
    ['font awesome 5 brands', 'fa6'],
    ['font awesome 6 free', 'fa6'],
    ['font awesome 6 pro', 'fa6'],
    ['font awesome 6 brands', 'fa6'],
    ['icomoon', 'generic'],
    ['icomoon-free', 'generic'],
    ['glyphicons halflings', 'glyphicons'],
    ['glyphicons', 'glyphicons'],
    ['bootstrap icons', 'bootstrap-icons'],
    ['bootstrap-icons', 'bootstrap-icons'],
    ['segoe fluent icons', 'generic'],
    ['segoe mdl2 assets', 'generic'],
    ['octicons', 'generic']
  ]);

  // Generic keywords and system stacks are never fetched as web fonts. Roboto is
  // here deliberately: it is Android's system UI font and appears in countless
  // stacks where fetching it is pure waste.
  const SYSTEM_FAMILIES = new Set([
    'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui',
    'ui-sans-serif', 'ui-serif', 'ui-monospace', 'ui-rounded', 'math', 'emoji', 'fangsong',
    '-apple-system', 'blinkmacsystemfont', 'segoe ui', 'segoe ui symbol',
    'segoe ui emoji', 'segoe ui historic', 'apple color emoji', 'noto color emoji',
    'noto sans symbols', 'android emoji', 'emojisymbols', 'twemoji mozilla',
    'arial', 'arial black', 'helvetica', 'helvetica neue', 'times', 'times new roman',
    'courier', 'courier new', 'georgia', 'verdana', 'tahoma', 'trebuchet ms',
    'palatino', 'garamond', 'bookman', 'impact', 'consolas', 'menlo', 'monaco',
    'sf mono', 'sfmono-regular', 'liberation sans', 'liberation serif', 'liberation mono',
    'dejavu sans', 'dejavu serif', 'dejavu sans mono', 'cantarell', 'ubuntu',
    'oxygen', 'oxygen-sans', 'droid sans', 'lucida grande', 'lucida sans unicode',
    'zapfino', 'apple sd gothic neo', 'hiragino sans', 'hiragino kaku gothic pro',
    'yu gothic', 'meiryo', 'ms pgothic', 'microsoft yahei', 'pingfang sc',
    'hiragino sans gb', 'heiti sc', 'wenquanyi micro hei', 'malgun gothic', 'roboto'
  ]);

  const ICON_CLASS_RE = /(^|[\s-])(icon|icons|fa|fas|far|fal|fab|fad|material-icons|material-symbols|octicon|glyphicon|bi|mdi|ion|feather)([\s-]|$)/i;

  /* ======================================================================== *
   * SECTION: state
   * ======================================================================== */

  const state = {
    active: false,
    /**
     * Interact mode: the page gets its own clicks back.
     *
     * Selection mode swallows every click, which makes any component you have to
     * OPEN impossible to reach — clicking a dropdown trigger selects the trigger
     * instead of opening the menu. In interact mode the page behaves completely
     * normally: menus open, links follow, inputs type.
     *
     * Two things stay live throughout, and they are what make the mode useful
     * rather than just an off switch:
     *   - hover tracking, so the outline still shows what would be captured;
     *   - the grab key, so you can capture without touching the mouse. A
     *     hover-revealed menu closes the moment the pointer leaves it, so any
     *     mouse-based capture gesture destroys its own target.
     */
    paused: false,
    hovered: null,
    selections: [],           // [{ el, raw, rect, diag }]
    nav: { path: [], idx: 0 },
    shortcuts: null,
    capturing: false,
    shadowRoots: new Set(),
    styleSheetCache: null,
    // Where the pointer is, and which floating layers appeared recently. Together
    // these are what identify a hover tooltip: it has no ARIA wiring and no open
    // trigger, so the only honest evidence is "it showed up when I hovered here".
    pointer: { x: -1, y: -1 },
    // When the current hover began. A layer only counts as "this hover produced it"
    // if it appeared AFTER that moment — a wall-clock window instead lets anything
    // the page built at load time qualify, which over-adopts badly.
    hoverStamp: 0,
    appeared: new Map(),
    appearedObserver: null,
    // Same-origin iframe documents reached during a capture. Tracked like shadow
    // roots: each is its own stylesheet source and its own querySelectorAll scope.
    frameDocs: new Set()
  };

  const isMac = /mac/i.test((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '');

  const PRIMARY_LABEL = isMac ? '\u2318' : 'Ctrl';
  const ALT_LABEL = isMac ? 'Opt' : 'Alt';

  function shortcutLabel(config) {
    if (!config || !config.key) return '—';
    const parts = [];
    if (config.primary) parts.push(PRIMARY_LABEL);
    if (config.shift) parts.push('Shift');
    if (config.alt) parts.push(ALT_LABEL);
    parts.push(String(config.key).toUpperCase());
    return parts.join('+');
  }

  const DEFAULT_SHORTCUTS = {
    start: { primary: true, shift: true, alt: false, key: 'S' },
    export: { primary: true, shift: true, alt: false, key: 'E' },
    fullpage: { primary: true, shift: true, alt: false, key: 'X' },
    history: { primary: true, shift: true, alt: false, key: 'H' },
    pause: { primary: true, shift: true, alt: false, key: 'P' },
    // Capture whatever the cursor is over, without clicking. The point of a key
    // rather than a click: a hover-opened menu closes the moment you move the
    // mouse off it, so the gesture that captures it cannot involve the mouse.
    grab: { primary: true, shift: true, alt: false, key: 'G' },
    // Reports what is actually under the cursor and why each floating layer was or
    // was not adopted, and copies it to the clipboard. Exists because "the hover
    // thing didn't get captured" has too many possible causes to guess at.
    diagnose: { primary: true, shift: true, alt: false, key: 'D' }
  };

  /* ======================================================================== *
   * SECTION: geometry + misc helpers
   * ======================================================================== */

  const vw = () => window.innerWidth || 1;
  const vh = () => window.innerHeight || 1;
  const rectOf = (el) => {
    try { return el.getBoundingClientRect(); } catch (_) { return { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0 }; }
  };
  const areaOf = (r) => Math.max(0, r.width) * Math.max(0, r.height);
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const tagOf = (el) => (el && el.tagName ? el.tagName.toLowerCase() : '');

  function isOurs(node) {
    if (!node || node.nodeType !== 1) return false;
    if (node.id && String(node.id).indexOf(PREFIX) === 0) return true;
    const cls = node.getAttribute && node.getAttribute('class');
    if (cls && String(cls).indexOf(PREFIX) !== -1) return true;
    return !!(node.hasAttribute && node.hasAttribute('data-cheater'));
  }

  function classListOf(el) {
    const raw = (el.getAttribute && el.getAttribute('class')) || '';
    return String(raw).split(/\s+/).filter(Boolean);
  }

  /** Meaningful classes for the hover indicator — utility soup is noise there. */
  function labelClasses(el) {
    return classListOf(el)
      .filter((c) => c.length > 1 && c.length < 24 && !/^(is|has|js)-/.test(c))
      .slice(0, 3);
  }

  /** Parent, crossing an open shadow boundary to the host element. */
  function parentOrHost(el) {
    if (!el) return null;
    if (el.parentElement) return el.parentElement;
    const root = el.parentNode;
    if (root && root.nodeType === 11 && root.host) return root.host; // DocumentFragment/ShadowRoot
    return null;
  }

  function ancestorChain(el, stopAt) {
    const out = [];
    let cur = parentOrHost(el);
    while (cur && cur !== stopAt) { out.push(cur); cur = parentOrHost(cur); }
    return out;
  }

  function isVisible(el, cs) {
    const s = cs || getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden';
  }

  /* ======================================================================== *
   * SECTION: overlay UI
   *
   * All chrome lives in a CLOSED shadow root on a single cheater- prefixed host.
   * Closed so page CSS and page scripts cannot reach in; prefixed so the capture
   * walk can drop it by name. Every layer is pointer-events:none, which is what
   * keeps the extension from ever stealing its own hit tests.
   * ======================================================================== */

  const ui = {
    host: null, root: null, hover: null, label: null, boxes: [], toast: null,
    toastTimer: 0, progress: null,
    bar: null, hint: null, selectBtn: null, interactBtn: null
  };

  function buildUI() {
    if (ui.host) return;
    const host = document.createElement('div');
    host.className = PREFIX + 'root';
    host.setAttribute('data-cheater', 'ui');
    host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647';

    let root;
    try { root = host.attachShadow({ mode: 'closed' }); } catch (_) { root = host; }

    const style = document.createElement('style');
    style.textContent = [
      ':host{all:initial}',
      '*{box-sizing:border-box;margin:0;padding:0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}',
      '.layer{position:fixed;pointer-events:none;z-index:1}',
      // Interact mode keeps the outline, because it is the only thing telling you
      // what the grab key would capture — but restyles it to amber and dashed, so
      // "your clicks go to the page" is visible at a glance rather than something
      // you have to remember.
      ':host(.cheater-paused) .hover{border:1px dashed #FFB224;background:rgba(255,178,36,.05)}',
      ':host(.cheater-paused) .label{border-left-color:#FFB224}',
      '.hover{border:1px solid #FF4A3D;background:rgba(255,74,61,.07);transition:none}',
      '.sel{border:1px solid #4A9BFF;background:rgba(74,155,255,.10)}',
      '.selbox{border:1px dashed #4A9BFF;background:rgba(74,155,255,.06)}',
      '.label{position:fixed;pointer-events:none;z-index:3;background:#0C0D0F;color:#E8E6E1;',
      'border:1px solid #2A2D33;border-left:2px solid #FFB224;padding:3px 7px;font-size:11px;',
      'line-height:1.45;white-space:nowrap;max-width:70vw;overflow:hidden;text-overflow:ellipsis}',
      '.label b{color:#FFB224;font-weight:400}',
      '.label i{color:#6B7077;font-style:normal}',
      '.toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:4;',
      'background:#121316;color:#E8E6E1;border:1px solid #2A2D33;border-left:2px solid #FFB224;',
      'padding:8px 12px;font-size:11px;letter-spacing:.02em;pointer-events:none;',
      // Failure messages carry a reason and a size, so the toast has to wrap
      // rather than run off the side of the viewport.
      'max-width:min(560px,86vw);line-height:1.5;white-space:normal;text-align:left}',
      '.toast.bad{border-left-color:#FF4A3D}',
      '.progress{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:5;',
      'background:#121316;border:1px solid #2A2D33;border-left:2px solid #FFB224;',
      'padding:8px 12px 9px;min-width:236px;pointer-events:none;display:none}',
      '.progress-row{display:flex;align-items:baseline;gap:10px;justify-content:space-between}',
      '.progress-label{color:#E8E6E1;font-size:11px;letter-spacing:.02em}',
      '.progress-pct{color:#FFB224;font-size:11px;font-variant-numeric:tabular-nums}',
      '.progress-track{margin-top:7px;height:2px;background:#2A2D33;overflow:hidden}',
      '.progress-fill{height:100%;background:#FFB224;width:0%;transition:width .1s linear}',
      '.progress-fill.indeterminate{animation:cheater-sweep 1s linear infinite;',
      'background:linear-gradient(90deg,#2A2D33 0%,#FFB224 50%,#2A2D33 100%);background-size:200% 100%}',
      '@keyframes cheater-sweep{0%{background-position:100% 0}100%{background-position:-100% 0}}',
      // The one layer that accepts pointer events. Its classes carry the cheater-
      // prefix so isOurs() recognises them and hit testing skips the toolbar
      // instead of selecting it.
      '.cheater-bar{position:fixed;right:12px;bottom:12px;z-index:6;pointer-events:auto;',
      'display:flex;align-items:stretch;background:#121316;border:1px solid #2A2D33;',
      'border-left:2px solid #FFB224;font-size:11px;letter-spacing:.02em;',
      'box-shadow:0 6px 20px rgba(0,0,0,.45)}',
      // The toolbar is the one layer that accepts pointer events, so whatever sits
      // under it cannot be hovered. It gets out of the cursor's way rather than
      // expecting you to work around it.
      '.cheater-bar.cheater-flip{right:auto;left:12px}',
      '.cheater-mode{display:flex}',
      '.cheater-btn{all:unset;display:flex;align-items:center;padding:7px 10px;color:#8A8F98;',
      'cursor:pointer;font:inherit;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;',
      'border-right:1px solid #2A2D33;white-space:nowrap}',
      '.cheater-btn:hover{color:#E8E6E1;background:#16181B}',
      '.cheater-btn.cheater-on{color:#0C0D0F;background:#FFB224}',
      '.cheater-hint{display:flex;align-items:center;padding:7px 10px;color:#6B7077;',
      'white-space:nowrap;pointer-events:none}',
      '.cheater-hint b{color:#8A8F98;font-weight:400}'
    ].join('');
    root.appendChild(style);

    const hover = document.createElement('div');
    hover.className = 'layer hover';
    hover.style.display = 'none';

    const label = document.createElement('div');
    label.className = 'label';
    label.style.display = 'none';

    root.appendChild(hover);
    root.appendChild(label);

    // Mode toolbar. Without it, click-through is a shortcut nobody discovers, and
    // "I can't interact with the page in selection mode" is the whole complaint.
    const bar = document.createElement('div');
    bar.className = PREFIX + 'bar';
    bar.setAttribute('data-cheater', 'bar');

    const modeWrap = document.createElement('div');
    modeWrap.className = PREFIX + 'mode';
    const selectBtn = document.createElement('button');
    selectBtn.className = PREFIX + 'btn ' + PREFIX + 'on';
    selectBtn.textContent = 'Select';
    selectBtn.title = 'Clicks select elements';
    const interactBtn = document.createElement('button');
    interactBtn.className = PREFIX + 'btn';
    interactBtn.textContent = 'Interact';
    interactBtn.title = 'Clicks go to the page — open menus, follow links, type';
    modeWrap.appendChild(selectBtn);
    modeWrap.appendChild(interactBtn);

    const hint = document.createElement('div');
    hint.className = PREFIX + 'hint';

    bar.appendChild(modeWrap);
    bar.appendChild(hint);

    // pointerdown, not click: our own capture-phase pointerdown handler runs first
    // and would otherwise have swallowed the gesture before the button saw it.
    const stop = (event) => { event.preventDefault(); event.stopPropagation(); };
    selectBtn.addEventListener('pointerdown', (event) => { stop(event); setPaused(false); });
    interactBtn.addEventListener('pointerdown', (event) => { stop(event); setPaused(true); });
    for (const button of [selectBtn, interactBtn]) {
      button.addEventListener('click', stop);
      button.addEventListener('mousedown', stop);
    }

    root.appendChild(bar);

    (document.body || document.documentElement).appendChild(host);
    Object.assign(ui, { host, root, hover, label, bar, hint, selectBtn, interactBtn });
    renderMode();
  }

  /**
   * Reflect the current mode in the toolbar, and say what the grab key does.
   *
   * The hint is the discoverable half: in interact mode the mouse belongs to the
   * page, so the only way to capture is the key, and it has to be on screen.
   */
  /**
   * Keep the toolbar away from the cursor.
   *
   * It is the only layer with pointer-events, so anything beneath it is
   * unhoverable — and "I can't select that" is precisely the complaint this whole
   * mode exists to answer. Flipping sides is enough: the pointer can only be on
   * one of them.
   */
  function avoidPointer(x, y) {
    if (!ui.bar) return;
    const r = rectOf(ui.bar);
    if (!r.width) return;
    const near = x >= r.left - 32 && x <= r.right + 32 && y >= r.top - 32 && y <= r.bottom + 32;
    if (!near) return;
    // Sit on the side the pointer is not on.
    ui.bar.classList.toggle(PREFIX + 'flip', x > vw() / 2);
  }

  function renderMode() {
    if (!ui.bar) return;
    const on = PREFIX + 'on';
    ui.selectBtn.classList.toggle(on, !state.paused);
    ui.interactBtn.classList.toggle(on, !!state.paused);
    const grab = shortcutLabel((state.shortcuts || DEFAULT_SHORTCUTS).grab);
    ui.hint.innerHTML = state.paused
      ? 'page has your clicks · hover, then <b>' + escapeHtml(grab) + '</b> to capture'
      : 'click to select · <b>' + escapeHtml(grab) + '</b> captures what you hover';
  }

  function teardownUI() {
    if (ui.host && ui.host.parentNode) ui.host.parentNode.removeChild(ui.host);
    ui.host = null; ui.root = null; ui.hover = null; ui.label = null; ui.boxes = []; ui.progress = null;
    ui.bar = null; ui.hint = null; ui.selectBtn = null; ui.interactBtn = null;
  }

  function placeLayer(layer, r) {
    layer.style.display = 'block';
    layer.style.left = r.left + 'px';
    layer.style.top = r.top + 'px';
    layer.style.width = Math.max(0, r.width) + 'px';
    layer.style.height = Math.max(0, r.height) + 'px';
  }

  function showHover(el) {
    if (!ui.hover) return;
    if (!el) { ui.hover.style.display = 'none'; ui.label.style.display = 'none'; return; }
    const r = rectOf(el);
    placeLayer(ui.hover, r);

    const classes = labelClasses(el);
    ui.label.innerHTML =
      '<b>' + escapeHtml(tagOf(el)) + '</b>' +
      (classes.length ? escapeHtml('.' + classes.join('.')) : '') +
      ' <i>' + Math.round(r.width) + '×' + Math.round(r.height) + '</i>';

    ui.label.style.display = 'block';
    const lw = ui.label.offsetWidth || 120;
    const lh = ui.label.offsetHeight || 20;
    let lx = r.left;
    let ly = r.top - lh - 3;
    if (ly < 2) ly = Math.min(r.top + r.height + 3, vh() - lh - 2);
    if (lx + lw > vw() - 4) lx = Math.max(2, vw() - lw - 4);
    ui.label.style.left = Math.max(2, lx) + 'px';
    ui.label.style.top = Math.max(2, ly) + 'px';
  }

  function renderSelection() {
    if (!ui.root) return;
    for (const box of ui.boxes) if (box.parentNode) box.parentNode.removeChild(box);
    ui.boxes = [];
    if (!state.selections.length) return;

    // Per-selection outline, plus one dashed bounding box over all of them.
    let minL = Infinity, minT = Infinity, maxR = -Infinity, maxB = -Infinity;
    for (const sel of state.selections) {
      const r = rectOf(sel.el);
      const layer = document.createElement('div');
      layer.className = 'layer sel';
      placeLayer(layer, r);
      ui.root.appendChild(layer);
      ui.boxes.push(layer);
      minL = Math.min(minL, r.left); minT = Math.min(minT, r.top);
      maxR = Math.max(maxR, r.left + r.width); maxB = Math.max(maxB, r.top + r.height);
    }
    if (state.selections.length > 1) {
      const box = document.createElement('div');
      box.className = 'layer selbox';
      placeLayer(box, { left: minL - 3, top: minT - 3, width: (maxR - minL) + 6, height: (maxB - minT) + 6 });
      ui.root.appendChild(box);
      ui.boxes.push(box);
    }
  }

  /**
   * Progress panel for long captures.
   *
   * A full-page extract walks tens of thousands of nodes reading computed styles,
   * which is seconds of work. Without this the page simply locks up with no
   * indication anything is happening, so the honest read is "it's broken".
   */
  function showProgress(label, fraction) {
    buildUI();
    if (!ui.root) return;
    if (!ui.progress) {
      const panel = document.createElement('div');
      panel.className = 'progress';
      panel.innerHTML =
        '<div class="progress-row"><span class="progress-label"></span>' +
        '<span class="progress-pct"></span></div>' +
        '<div class="progress-track"><div class="progress-fill"></div></div>';
      ui.root.appendChild(panel);
      ui.progress = panel;
    }
    ui.progress.style.display = 'block';
    ui.progress.querySelector('.progress-label').textContent = label;

    const pct = fraction == null ? null : Math.max(0, Math.min(100, Math.round(fraction * 100)));
    const fill = ui.progress.querySelector('.progress-fill');
    const readout = ui.progress.querySelector('.progress-pct');
    if (pct == null) {
      // Indeterminate: a phase whose size genuinely isn't known ahead of time.
      readout.textContent = '';
      fill.classList.add('indeterminate');
      fill.style.width = '100%';
    } else {
      readout.textContent = pct + '%';
      fill.classList.remove('indeterminate');
      fill.style.width = pct + '%';
    }
  }

  function hideProgress() {
    if (ui.progress) ui.progress.style.display = 'none';
  }

  function toast(text, bad) {
    buildUI();
    if (!ui.root) return;
    if (ui.toast && ui.toast.parentNode) ui.toast.parentNode.removeChild(ui.toast);
    const node = document.createElement('div');
    node.className = 'toast' + (bad ? ' bad' : '');
    node.textContent = text;
    ui.root.appendChild(node);
    ui.toast = node;
    clearTimeout(ui.toastTimer);
    // Errors carry text worth reading; successes do not.
    ui.toastTimer = setTimeout(() => {
      if (node.parentNode) node.parentNode.removeChild(node);
    }, bad ? 9000 : 2200);
  }

  let rafPending = false;
  function scheduleRefresh() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      if (!state.active) return;
      if (state.hovered && state.hovered.isConnected) showHover(state.hovered);
      renderSelection();
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  /* ======================================================================== *
   * SECTION: shadow roots
   *
   * The helper stylesheet has to exist inside every shadow root that
   * participates. Rather than sweeping the tree, roots are registered lazily the
   * first time a composed event path enters one — which is exactly when they
   * start mattering, and costs nothing on pages that use none.
   * ======================================================================== */

  function registerRoot(root) {
    if (!root || state.shadowRoots.has(root)) return;
    state.shadowRoots.add(root);
    state.styleSheetCache = null; // sheets inside this root may define hover rules
    try {
      const css = ':host{}'; // placeholder rule keeps the sheet valid and cheap
      if (root.adoptedStyleSheets && typeof CSSStyleSheet === 'function') {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(css);
        root.adoptedStyleSheets = root.adoptedStyleSheets.concat(sheet);
      } else {
        const style = document.createElement('style');
        style.className = PREFIX + 'style';
        style.textContent = css;
        root.appendChild(style);
      }
    } catch (_) { /* a locked-down root is still usable for selection */ }
  }

  // Frames nest, and a page can nest them deliberately. Three levels is past
  // anything real and stops a malicious page turning one capture into a fork bomb.
  const MAX_FRAME_DEPTH = 3;

  /**
   * The document inside an iframe, if this frame is actually readable from here.
   *
   * Same-origin frames can be walked like any other subtree, which is the whole
   * point: a cross-origin frame can only ever become a flat screenshot crop, but a
   * same-origin one has real DOM that belongs in the export.
   */
  function readableFrameDoc(el) {
    try {
      const doc = el.contentDocument;
      if (!doc || !doc.body) return null;
      // Touching a property is the actual permission check — contentDocument is
      // null cross-origin, but a sandboxed same-origin frame can be stranger.
      void doc.body.tagName;
      return doc;
    } catch (_) {
      return null;
    }
  }

  /**
   * Can this frame actually scroll?
   *
   * `scrolling="no"` and an `overflow:hidden` document are both deliberate — an ad
   * slot or a fixed banner is meant to be clipped, and giving it a scrollbar in the
   * export would be inventing a behaviour the original never had.
   */
  function frameScrolls(el, doc) {
    const legacy = (el.getAttribute && el.getAttribute('scrolling') || '').toLowerCase();
    if (legacy === 'no') return false;
    try {
      for (const node of [doc.documentElement, doc.body]) {
        if (!node) continue;
        const cs = getComputedStyle(node);
        if (cs.overflow === 'hidden' || cs.overflowY === 'hidden') return false;
      }
      // Nothing to scroll is not the same as being unable to: no scrollbar appears
      // either way with `auto`, so this only avoids claiming scroll where there is
      // genuinely none to have.
      const root = doc.scrollingElement || doc.documentElement;
      return !!root && root.scrollHeight > root.clientHeight + 1;
    } catch (_) {
      return false;
    }
  }

  /**
   * The frame's own page background, when it comes from <html> rather than <body>.
   * Returns '' when the body already paints one, so nothing is stated twice.
   */
  function frameRootBackground(doc, bodyNode) {
    try {
      const bodyPaint = bodyNode && bodyNode.style && bodyNode.style['background-color'];
      if (bodyPaint && !isTransparent(bodyPaint)) return '';
      const cs = getComputedStyle(doc.documentElement);
      const value = cleanValue('background-color', cs.backgroundColor);
      if (!value || isTransparent(value)) return '';
      return value;
    } catch (_) {
      return '';
    }
  }

  function registerFrameDoc(doc) {
    if (!doc || state.frameDocs.has(doc)) return;
    state.frameDocs.add(doc);
    state.styleSheetCache = null;   // its sheets may define hover and @font-face rules
  }

  function registerRootsFromPath(path) {
    for (const node of path) {
      if (node && node.nodeType === 11 && node.host) registerRoot(node);
    }
  }

  /* ======================================================================== *
   * SECTION: hit testing
   *
   * composedPath()[0] rather than elementFromPoint: it pierces open shadow roots
   * for free and reports the true innermost node.
   * ======================================================================== */

  function hitTarget(event) {
    const path = (event.composedPath && event.composedPath()) || [];
    registerRootsFromPath(path);
    for (const node of path) {
      if (node && node.nodeType === 1 && !isOurs(node)) {
        // Landing on <body>/<html> means the pointer is over bare page
        // background; there is nothing to select there, and the full-page
        // shortcut exists for capturing <body> deliberately.
        if (node === document.documentElement || node === document.body) return null;
        return resolveOverlay(node, event.clientX, event.clientY);
      }
    }
    return null;
  }

  /**
   * Transparent full-bleed click-catchers (`absolute inset-0`, no paint, no text)
   * are extremely common and would otherwise make everything beneath them
   * unselectable. When we land on one, look through it.
   */
  function resolveOverlay(el, x, y) {
    if (!isTransparentCatcher(el)) return el;

    // Prefer a painted sibling: the overwhelmingly common shape is
    // `<div class="card">…</div><div class="overlay"></div>`, where the thing you
    // actually meant is a sibling, not an ancestor. Walking up would hand back
    // the positioned wrapper instead of the card.
    const parent = parentOrHost(el);
    if (parent) {
      let best = null;
      for (const sibling of parent.children) {
        if (sibling === el || isOurs(sibling)) continue;
        let cs;
        try { cs = getComputedStyle(sibling); } catch (_) { continue; }
        if (!isVisible(sibling, cs)) continue;
        if (!hasPaint(cs) && !(sibling.textContent || '').trim()) continue;
        const area = areaOf(rectOf(sibling));
        if (!best || area > best.area) best = { el: sibling, area };
      }
      if (best) return best.el;
    }

    // Otherwise look through the stack at the pointer. Only meaningful while the
    // element is on screen, which it always is during hover-driven selection.
    let list = [];
    try { list = document.elementsFromPoint(x, y) || []; } catch (_) { return el; }
    for (const cand of list) {
      if (cand === el || isOurs(cand) || cand === document.body || cand === document.documentElement) continue;
      if (el.contains(cand) || !isTransparentCatcher(cand)) return cand;
    }
    return el;
  }

  function isTransparentCatcher(el) {
    if (!el || el.nodeType !== 1) return false;
    const tag = tagOf(el);
    if (tag === 'svg' || REPLACED_TAGS.has(tag)) return false;
    if ((el.textContent || '').trim()) return false;
    if (el.childElementCount > 1) return false;
    const cs = getComputedStyle(el);
    if (cs.position !== 'absolute' && cs.position !== 'fixed') return false;
    if (hasPaint(cs)) return false;
    const r = rectOf(el);
    const p = parentOrHost(el);
    if (!p) return r.width > vw() * 0.6;
    const pr = rectOf(p);
    return Math.abs(r.width - pr.width) < 4 && Math.abs(r.height - pr.height) < 4;
  }

  function hasPaint(cs) {
    return !isTransparent(cs.backgroundColor) ||
      cs.backgroundImage !== 'none' ||
      cs.boxShadow !== 'none' ||
      maxBorderWidth(cs) > 0;
  }

  function isTransparent(color) {
    if (!color) return true;
    if (color === 'transparent') return true;
    const m = /^rgba?\(([^)]+)\)$/.exec(color);
    if (!m) return false;
    const parts = m[1].split(/[,\/\s]+/).filter(Boolean);
    return parts.length > 3 && parseFloat(parts[3]) === 0;
  }

  function maxBorderWidth(cs) {
    return Math.max(
      parseFloat(cs.borderTopWidth) || 0, parseFloat(cs.borderRightWidth) || 0,
      parseFloat(cs.borderBottomWidth) || 0, parseFloat(cs.borderLeftWidth) || 0
    );
  }

  /* ======================================================================== *
   * SECTION: smart expansion
   *
   * Clicking a leaf should give you the component it belongs to; clicking
   * something that already IS a component should give you that. A scored ascent
   * with a hard growth cap does both, and never reaches <body>.
   * ======================================================================== */

  const MAX_CLIMB = 6;
  const GROWTH_HARD_CAP = 12;
  const GROWTH_PENALTY_AT = 6;
  const ACCEPT_SCORE = 5;

  function isStructural(el) {
    const tag = tagOf(el);
    if (STRUCTURAL_TAGS.has(tag)) return true;
    const r = rectOf(el);
    const viewport = vw() * vh();
    if (areaOf(r) >= viewport * 0.25) return true;
    if (r.width >= vw() * 0.6 && r.height >= 120) return true;
    return el.childElementCount >= 8;
  }

  /**
   * Worth trying to expand from. The bare-area threshold is deliberately small
   * (~110x110): at 40 000 px² a 320x62 field card counts as "leafish" and gets
   * expanded past, even though it is exactly the component the click was aiming
   * for. Anything larger has to earn expansion through its tag instead.
   */
  function isLeafish(el) {
    if (el.childElementCount === 0) return true;
    if (LEAFISH_TAGS.has(tagOf(el))) return true;
    return areaOf(rectOf(el)) < 12000;
  }

  function isBareField(el) {
    const tag = tagOf(el);
    return tag === 'input' || tag === 'textarea' || tag === 'select';
  }

  function effectiveBackground(el) {
    let cur = el;
    let hops = 0;
    while (cur && hops < 8) {
      const cs = getComputedStyle(cur);
      if (!isTransparent(cs.backgroundColor)) return cs.backgroundColor;
      if (cs.backgroundImage !== 'none') return 'image';
      cur = parentOrHost(cur);
      hops += 1;
    }
    return 'none';
  }

  function scoreContainer(el, clicked, growth) {
    const cs = getComputedStyle(el);
    const tag = tagOf(el);
    const r = rectOf(el);
    let score = 0;

    // A container earns its keep by looking like one.
    const ownBg = cs.backgroundColor;
    if (!isTransparent(ownBg)) {
      const parent = parentOrHost(el);
      if (!parent || effectiveBackground(parent) !== ownBg) score += 3;
    }
    if (cs.backgroundImage !== 'none') score += 1;

    const role = (el.getAttribute && el.getAttribute('role')) || '';
    if (tag === 'button' || tag === 'label' || tag === 'fieldset' || tag === 'details' ||
        tag === 'summary' || tag === 'tr' || (tag === 'a' && el.hasAttribute('href')) ||
        SEMANTIC_ROLES.has(role)) score += 3;

    if (maxBorderWidth(cs) > 0 && !isTransparent(cs.borderTopColor)) score += 2;
    if (parseFloat(cs.borderTopLeftRadius) > 2) score += 2;
    if (cs.boxShadow !== 'none') score += 2;

    const cls = classListOf(el).join(' ');
    if (CONTAINER_CLASS_RE.test(cls)) score += 2;

    // Grouping the clicked element WITH a sibling is the label+input / icon+text
    // signal — the single most reliable sign of a real component boundary.
    if (el.childElementCount > 1) score += 2;

    if (/^(flex|grid|inline-flex|inline-grid)$/.test(cs.display)) score += 1;

    const pads = [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft]
      .map((v) => parseFloat(v) || 0).filter((v) => v > 4);
    if (pads.length >= 2) score += 1;

    if (/^(hidden|clip)$/.test(cs.overflowX) || /^(hidden|clip)$/.test(cs.overflowY)) score += 1;
    if ((el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('data-testid')))) score += 1;

    // Penalties.
    if (growth > GROWTH_PENALTY_AT) score -= 4;
    if (r.width >= vw() * 0.85) score -= 3;
    if (!hasPaint(cs) && el.childElementCount === 1) score -= 3;
    if ((cs.position === 'fixed' || cs.position === 'sticky') && r.width >= vw() * 0.7) score -= 2;

    return score;
  }

  function smartExpand(el) {
    if (!el) return el;

    // An svg internal is never the interesting unit — snap out to the <svg>.
    let start = el;
    const tag = tagOf(start);
    if (tag !== 'svg' && start.ownerSVGElement) {
      const owner = start.ownerSVGElement;
      if (owner) start = owner;
    }

    // td/th: the row is the meaningful unit far more often than the cell.
    if (tagOf(start) === 'td' || tagOf(start) === 'th') {
      const row = start.closest && start.closest('tr');
      if (row && areaOf(rectOf(row)) < vw() * vh() * 0.25) return row;
    }

    if (isStructural(start)) return start;
    if (!isLeafish(start)) return start;

    const startArea = Math.max(1, areaOf(rectOf(start)));
    let best = null;
    let firstStep = null;
    let cur = start;

    for (let steps = 0; steps < MAX_CLIMB; steps += 1) {
      const parent = parentOrHost(cur);
      if (!parent || CLIMB_STOP_TAGS.has(tagOf(parent)) || isOurs(parent)) break;

      const pr = rectOf(parent);
      const growth = areaOf(pr) / startArea;
      if (growth > GROWTH_HARD_CAP || pr.width > vw() * 0.9) break;
      // A parent big enough to be a page region is not a component boundary.
      if (areaOf(pr) >= vw() * vh() * 0.25) break;

      if (!firstStep) firstStep = parent;
      const score = scoreContainer(parent, start, growth);
      // Tie-break toward the tightest qualifying container.
      if (!best || score > best.score || (score === best.score && growth < best.growth)) {
        best = { el: parent, score, growth };
      }
      cur = parent;
    }

    if (best && best.score >= ACCEPT_SCORE) return best.el;

    // A naked <input> is essentially never what you wanted — the field card is.
    if (isBareField(start) && firstStep) return firstStep;

    return start;
  }

  /* ======================================================================== *
   * SECTION: navigation with a back-stack
   *
   * Alt+Arrow and the wheel share ONE path array, so overshooting upward can
   * always be walked back down the exact way you came instead of stranding you
   * at <body> with no route back.
   * ======================================================================== */

  function resetNav(el) {
    state.nav.path = el ? [el] : [];
    state.nav.idx = 0;
  }

  function navCurrent() {
    return state.nav.path[state.nav.idx] || null;
  }

  function navUp() {
    const cur = navCurrent();
    if (!cur) return null;
    if (state.nav.idx + 1 < state.nav.path.length) {
      state.nav.idx += 1;
      return navCurrent();
    }
    const parent = parentOrHost(cur);
    if (!parent || isOurs(parent) || parent === document.documentElement) return cur;
    state.nav.path.push(parent);
    state.nav.idx += 1;
    return parent;
  }

  function navDown() {
    if (state.nav.idx > 0) {
      state.nav.idx -= 1;                 // the exact way back
      return navCurrent();
    }
    const cur = navCurrent();
    if (!cur) return null;
    const child = firstMeaningfulChild(cur);
    if (!child) return cur;
    state.nav.path.unshift(child);        // new deepest anchor; idx stays 0
    return child;
  }

  /**
   * Descending must cross INTO a shadow root, not stop at its host — otherwise
   * a component-library page dead-ends the moment you reach a custom element.
   */
  function firstMeaningfulChild(el) {
    const pools = [];
    if (el.shadowRoot) pools.push(el.shadowRoot.children);
    pools.push(el.children || []);

    for (const pool of pools) {
      for (const kid of pool) {
        if (isOurs(kid)) continue;
        let cs;
        try { cs = getComputedStyle(kid); } catch (_) { continue; }
        if (!isVisible(kid, cs)) continue;
        if (areaOf(rectOf(kid)) <= 0) continue;
        return kid;
      }
    }
    return null;
  }

  /**
   * Point the path at `el` without throwing away the back-stack.
   *
   * If `el` is already somewhere in the path we just move the cursor there, so a
   * drill-down remains reversible. Only a genuinely new anchor resets the path.
   * This is what lets Alt+Arrow keep traversing the selection across repeated
   * presses instead of restarting from scratch each time.
   */
  function ensureNavAnchor(el) {
    if (!el) return;
    if (navCurrent() === el) return;
    const index = state.nav.path.indexOf(el);
    if (index !== -1) { state.nav.idx = index; return; }
    resetNav(el);
  }

  /** The element Alt+Arrow traverses from: the newest selection, else the hover. */
  function navSubject() {
    if (state.selections.length) return state.selections[state.selections.length - 1].el;
    return state.hovered;
  }

  async function navTo(el) {
    if (!el) return;
    state.hovered = el;
    await replaceSelection(el);
    showHover(el);
  }

  /* ======================================================================== *
   * SECTION: reset-adjusted per-tag defaults (the pruning baseline)
   *
   * Pruning is only sound if the baseline is what the element will actually
   * compute to inside the EXPORTED document. So the probe iframe gets the same
   * reset the export ships with; anything pruned here is guaranteed to be
   * re-supplied there. See the long note at the top of lib/reset.js.
   * ======================================================================== */

  const PROBE_PARENTS = {
    td: 'table>tbody>tr', th: 'table>thead>tr', tr: 'table>tbody', tbody: 'table',
    thead: 'table', tfoot: 'table', caption: 'table', col: 'table>colgroup',
    colgroup: 'table', option: 'select', optgroup: 'select', li: 'ul',
    dt: 'dl', dd: 'dl', legend: 'fieldset', summary: 'details',
    figcaption: 'figure', source: 'picture', track: 'video'
  };

  let probeDoc;
  let probeFrame = null;
  const defaultsCache = new Map();

  function getProbeDoc() {
    if (probeDoc !== undefined) return probeDoc;
    probeDoc = null;
    try {
      const frame = document.createElement('iframe');
      frame.className = PREFIX + 'probe';
      frame.setAttribute('data-cheater', 'probe');
      frame.setAttribute('aria-hidden', 'true');
      frame.style.cssText =
        'position:fixed;left:-99999px;top:0;width:1024px;height:768px;border:0;' +
        'visibility:hidden;pointer-events:none;opacity:0';
      (document.body || document.documentElement).appendChild(frame);
      const doc = frame.contentDocument;
      if (doc) {
        doc.open();
        doc.write('<!DOCTYPE html><html><head><meta charset="utf-8"><style>' + RESET_CSS +
          '</style></head><body></body></html>');
        doc.close();
        probeDoc = doc;
        probeFrame = frame;
      } else if (frame.parentNode) {
        frame.parentNode.removeChild(frame);
      }
    } catch (_) {
      probeDoc = null;   // CSP frame-src 'none' — fall back to the static table
    }
    return probeDoc;
  }

  // Used only when the probe iframe is unavailable. Deliberately small: it
  // covers the properties whose UA default is not the CSS initial value.
  const STATIC_DEFAULTS = {
    display: {
      div: 'block', span: 'inline', p: 'block', a: 'inline', button: 'inline-block',
      input: 'inline-block', img: 'inline', svg: 'inline', li: 'list-item',
      table: 'table', tr: 'table-row', td: 'table-cell', th: 'table-cell',
      ul: 'block', ol: 'block', h1: 'block', h2: 'block', h3: 'block', h4: 'block',
      h5: 'block', h6: 'block', section: 'block', header: 'block', footer: 'block',
      nav: 'block', main: 'block', article: 'block', aside: 'block', form: 'block',
      label: 'inline', select: 'inline-block', textarea: 'inline-block',
      summary: 'list-item', details: 'block', figure: 'block', pre: 'block'
    }
  };

  function defaultsFor(tag) {
    if (defaultsCache.has(tag)) return defaultsCache.get(tag);
    const out = Object.create(null);
    const doc = getProbeDoc();

    if (doc && doc.body) {
      try {
        let host = doc.body;
        const chain = PROBE_PARENTS[tag];
        if (chain) {
          for (const part of chain.split('>')) {
            const wrapper = doc.createElement(part);
            host.appendChild(wrapper);
            host = wrapper;
          }
        }
        const probe = doc.createElement(tag);
        if (tag === 'input') probe.setAttribute('type', 'text');
        probe.appendChild(doc.createTextNode('Mg'));
        host.appendChild(probe);
        const cs = doc.defaultView.getComputedStyle(probe);
        for (const prop of PROPS) out[prop] = cs.getPropertyValue(prop);
        // Leave the probe tree in place: repeated capture is cheap this way and
        // the frame is removed wholesale on deactivate.
      } catch (_) { /* fall through to static */ }
    }

    if (!out.display) {
      const table = STATIC_DEFAULTS.display;
      out.display = table[tag] || 'inline';
    }

    defaultsCache.set(tag, out);
    return out;
  }

  function destroyProbe() {
    if (probeFrame && probeFrame.parentNode) probeFrame.parentNode.removeChild(probeFrame);
    probeFrame = null;
    probeDoc = undefined;
    defaultsCache.clear();
  }

  /* ======================================================================== *
   * SECTION: value cleanup
   * ======================================================================== */

  /**
   * `color(srgb r g b [/ a])` -> hex.
   *
   * Modern engines compute color-mix(), relative colors and oklch() into this
   * form. It is valid CSS, but only in recent browsers — and the whole point of
   * the export is that it opens anywhere. Channels here are 0..1 floats.
   */
  function colorFunctionToHex(value) {
    const m = /^color\(\s*srgb\s+([^)]+)\)$/i.exec(String(value).trim());
    if (!m) return null;
    const parts = m[1].split(/[\/\s]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const hex = (n) => Math.max(0, Math.min(255, Math.round(n * 255))).toString(16).padStart(2, '0');
    const channel = (p) => {
      const n = p.indexOf('%') !== -1 ? parseFloat(p) / 100 : parseFloat(p);
      return isNaN(n) ? 0 : n;
    };
    let out = '#' + hex(channel(parts[0])) + hex(channel(parts[1])) + hex(channel(parts[2]));
    if (parts.length > 3) {
      const alpha = channel(parts[3]);
      if (alpha < 1) out += hex(alpha);
    }
    return out;
  }

  function rgbToHex(value) {
    const m = /^rgba?\(([^)]+)\)$/.exec(value.trim());
    if (!m) return null;
    const parts = m[1].split(/[,\/\s]+/).filter(Boolean).map((p) => p.trim());
    if (parts.length < 3) return null;
    const channel = (p) => {
      const n = p.indexOf('%') !== -1 ? Math.round(parseFloat(p) * 2.55) : Math.round(parseFloat(p));
      return Math.max(0, Math.min(255, isNaN(n) ? 0 : n));
    };
    const hex = (n) => n.toString(16).padStart(2, '0');
    let out = '#' + hex(channel(parts[0])) + hex(channel(parts[1])) + hex(channel(parts[2]));
    if (parts.length > 3) {
      let alpha = parts[3].indexOf('%') !== -1 ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
      if (isNaN(alpha)) alpha = 1;
      if (alpha < 1) out += hex(Math.round(Math.max(0, Math.min(1, alpha)) * 255));
    }
    return out;
  }

  function absoluteUrl(url, base) {
    try { return new URL(url, base || document.baseURI).href; } catch (_) { return url; }
  }

  function cleanValue(prop, value) {
    if (value == null) return '';
    let out = String(value).trim();
    if (!out) return '';

    // Colors -> hex (alpha preserved as #rrggbbaa).
    if (/rgba?\(/.test(out)) {
      out = out.replace(/rgba?\([^()]*\)/g, (match) => rgbToHex(match) || match);
    }
    if (/color\(\s*srgb/i.test(out)) {
      out = out.replace(/color\(\s*srgb[^()]*\)/gi, (match) => colorFunctionToHex(match) || match);
    }

    // Relative urls die the moment the file moves; resolve them at capture time.
    if (out.indexOf('url(') !== -1) {
      out = out.replace(/url\((\s*['"]?)([^'")]+)\1\s*\)/g, (match, quote, url) => {
        if (/^(data:|blob:|about:|#)/.test(url)) return match;
        return 'url("' + absoluteUrl(url) + '")';
      });
      // blob: urls are dead outside the originating document.
      if (/url\(\s*["']?blob:/.test(out)) return '';
    }

    if (prop === 'overflow-x' || prop === 'overflow-y') {
      if (out === 'clip') out = 'hidden';   // wider support, same intent
    }

    return out;
  }

  /**
   * Substitute custom properties into a value that still contains var().
   *
   * The export carries no :root block, so an unresolved var() is a dead
   * declaration. Custom properties are inherited, so the element's own computed
   * style can supply them. Two passes cover a variable defined in terms of
   * another; anything deeper is left unresolved and the caller drops it.
   */
  function resolveCustomProperties(cs, value) {
    let out = value;
    for (let pass = 0; pass < 2 && out.indexOf('var(--') !== -1; pass += 1) {
      out = out.replace(/var\(\s*(--[\w-]+)\s*(?:,([^()]*))?\)/g, (match, name, fallback) => {
        let resolved = '';
        try { resolved = cs.getPropertyValue(name).trim(); } catch (_) { resolved = ''; }
        if (resolved) return resolved;
        return fallback != null ? fallback.trim() : match;
      });
    }
    return out;
  }

  function isDroppableValue(prop, value) {
    if (!value) return true;
    if (value === 'currentcolor' || value === 'currentColor') return false;
    // Fully transparent paint carries no information...
    if (/^#[0-9a-f]{6}00$/i.test(value)) {
      // ...unless it is a border colour paired with a real width, where the
      // author is deliberately reserving space (or using currentColor semantics).
      return prop.indexOf('border') !== 0 && prop.indexOf('outline') !== 0;
    }
    return false;
  }

  /* ======================================================================== *
   * SECTION: stylesheet scanning (hover rules + authored sizing + @font-face)
   * ======================================================================== */

  function allStyleSheets() {
    const sheets = [];
    const push = (list) => { for (const sheet of list || []) sheets.push(sheet); };
    push(document.styleSheets);
    for (const root of state.shadowRoots) {
      try { push(root.styleSheets); push(root.adoptedStyleSheets); } catch (_) { /* noop */ }
    }
    // A same-origin iframe's rules live in its own document and are invisible from
    // here otherwise, so its content would be captured with no styling at all.
    for (const doc of state.frameDocs) {
      try { push(doc.styleSheets); push(doc.adoptedStyleSheets); } catch (_) { /* noop */ }
    }
    try { push(document.adoptedStyleSheets); } catch (_) { /* noop */ }
    return sheets;
  }

  function specificity(selector) {
    let a = 0, b = 0, c = 0;
    a = (selector.match(/#[\w-]+/g) || []).length;
    b = (selector.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)(?!hover\b)[\w-]+/g) || []).length;
    c = (selector.match(/(^|[\s>+~])[a-z][\w-]*/gi) || []).length +
        (selector.match(/::[\w-]+/g) || []).length;
    return a * 10000 + b * 100 + c;
  }

  function declarationsOf(styleDecl) {
    const out = Object.create(null);
    for (let i = 0; i < styleDecl.length; i += 1) {
      const prop = styleDecl.item(i);
      if (!PROP_SET.has(prop)) continue;
      const value = styleDecl.getPropertyValue(prop);
      // CSSOM expands shorthands into longhands, filling the ones the author did
      // not mention with `initial`. So `background: #3f3f46` arrives as
      // background-color plus six `initial` siblings. Emitting those turns a
      // one-line hover rule into eight lines of noise that also stomp the
      // resting state's real background-image/size/repeat.
      if (value === 'initial') continue;
      out[prop] = value;
    }
    return out;
  }

  /** Split a selector on top-level combinators (ignoring brackets and parens). */
  function splitCompounds(selector) {
    const parts = [];
    let depth = 0;
    let current = '';
    for (let i = 0; i < selector.length; i += 1) {
      const ch = selector[i];
      if (ch === '(' || ch === '[') depth += 1;
      else if (ch === ')' || ch === ']') depth -= 1;
      if (depth === 0 && /[\s>+~]/.test(ch)) {
        if (current) { parts.push(current); current = ''; }
        continue;
      }
      current += ch;
    }
    if (current) parts.push(current);
    return parts;
  }

  const dehover = (s) => {
    const out = s.replace(/:hover\b/g, '');
    return out.trim() ? out : '*';
  };

  /**
   * Collected once per capture session:
   *   hoverRules    — every rule whose selector contains :hover, in cascade order
   *   authoredRules — rules declaring an authorship-sensitive property, used to
   *                   tell an authored width from one that fell out of layout
   *   fontFaces     — @font-face descriptors
   */
  function scanStyleSheets() {
    if (state.styleSheetCache) return state.styleSheetCache;

    const hoverRules = [];
    const authoredRules = [];
    const fontFaces = [];
    let order = 0;

    const walk = (rules) => {
      for (const rule of rules || []) {
        try {
          if (rule.type === 1 /* STYLE_RULE */ && rule.selectorText) {
            order += 1;
            const decls = declarationsOf(rule.style);
            const selectors = rule.selectorText.split(',').map((s) => s.trim()).filter(Boolean);

            for (const selector of selectors) {
              if (selector.indexOf(':hover') !== -1) {
                if (Object.keys(decls).length) {
                  const compounds = splitCompounds(selector);
                  const subject = compounds[compounds.length - 1] || '*';
                  const hoverIndex = compounds.findIndex((c) => c.indexOf(':hover') !== -1);
                  hoverRules.push({
                    selector,
                    full: dehover(selector),
                    subject: dehover(subject),
                    hoverCompound: dehover(compounds[hoverIndex] || subject),
                    onSubject: hoverIndex === compounds.length - 1,
                    props: decls,
                    spec: specificity(selector),
                    order
                  });
                }
              }
              // Only rules touching authorship-sensitive properties are kept, so
              // the per-element matches() scan stays over a small subset.
              const declared = Object.keys(decls).filter((p) => AUTHORED_SENSITIVE.has(p));
              if (declared.length) authoredRules.push({ selector, declared });
            }
          } else if (rule.type === 5 /* FONT_FACE_RULE */) {
            const parsed = parseFontFace(rule);
            if (parsed) fontFaces.push(parsed);
          } else if (rule.cssRules) {
            // @media only counts when it currently matches; @supports/@layer
            // are transparent for our purposes.
            if (rule.type === 4 /* MEDIA_RULE */) {
              let matches = true;
              try { matches = window.matchMedia(rule.conditionText || rule.media.mediaText).matches; } catch (_) { matches = true; }
              if (!matches) continue;
            }
            walk(rule.cssRules);
          }
        } catch (_) { /* one bad rule must not stop the scan */ }
      }
    };

    for (const sheet of allStyleSheets()) {
      let rules = null;
      try { rules = sheet.cssRules; } catch (_) { rules = null; } // CORS-restricted
      if (!rules) continue;
      walk(rules);
    }

    hoverRules.sort((a, b) => (a.spec - b.spec) || (a.order - b.order));
    state.styleSheetCache = { hoverRules, authoredRules, fontFaces };
    return state.styleSheetCache;
  }

  const FORMAT_RANK = { woff2: 4, woff: 3, opentype: 2, otf: 2, truetype: 1, ttf: 1 };
  const EXT_MIME = {
    woff2: 'font/woff2', woff: 'font/woff', otf: 'font/otf',
    ttf: 'font/ttf', eot: 'application/vnd.ms-fontobject', svg: 'image/svg+xml'
  };

  function parseFontFace(rule) {
    let family = '';
    let src = '';
    try {
      family = unquote(rule.style.getPropertyValue('font-family'));
      src = rule.style.getPropertyValue('src');
    } catch (_) { return null; }
    if (!family || !src) return null;

    const candidates = [];
    const re = /url\(\s*(['"]?)([^'")]+)\1\s*\)(?:\s*format\(\s*(['"]?)([^'")]+)\3\s*\))?/g;
    let match;
    while ((match = re.exec(src))) {
      const url = match[2];
      if (/^data:/.test(url)) {
        candidates.push({ url, format: match[4] || '', ext: 'woff2', inline: true, rank: 5 });
        continue;
      }
      const ext = ((/\.([a-z0-9]+)(?:[?#]|$)/i.exec(url) || [])[1] || '').toLowerCase();
      const format = (match[4] || ext).toLowerCase();
      candidates.push({
        url, format, ext: ext || format || 'woff2',
        rank: FORMAT_RANK[format] || FORMAT_RANK[ext] || 0
      });
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => b.rank - a.rank);
    const best = candidates[0];

    const sheetHref = (rule.parentStyleSheet && rule.parentStyleSheet.href) || '';
    const base = sheetHref || document.baseURI;
    const weight = (rule.style.getPropertyValue('font-weight') || '400').trim() || '400';
    const style = (rule.style.getPropertyValue('font-style') || 'normal').trim() || 'normal';
    const ext = best.ext === 'otf' ? 'otf' : best.ext;

    return {
      family,
      weight,
      style,
      unicodeRange: (rule.style.getPropertyValue('unicode-range') || '').trim(),
      display: (rule.style.getPropertyValue('font-display') || '').trim(),
      url: best.inline ? best.url : absoluteUrl(best.url, base),
      sheetHref: sheetHref,
      inline: !!best.inline,
      format: best.format || ext,
      ext,
      mime: EXT_MIME[ext] || 'font/woff2',
      path: 'fonts/' + sanitizeFileName(family) + '-' + String(weight).replace(/\s+/g, '') +
        (style === 'italic' ? '-italic' : '') + '.' + ext
    };
  }

  function sanitizeFileName(s) {
    return String(s).replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'font';
  }

  function unquote(s) {
    return String(s || '').trim().replace(/^['"]|['"]$/g, '');
  }

  /* ======================================================================== *
   * SECTION: fonts + icons
   * ======================================================================== */

  function parseFamilyStack(fontFamily) {
    const out = [];
    let current = '';
    let quote = '';
    for (const ch of String(fontFamily || '')) {
      if (quote) {
        if (ch === quote) quote = '';
        else current += ch;
        continue;
      }
      if (ch === '"' || ch === "'") { quote = ch; continue; }
      if (ch === ',') { out.push(current.trim()); current = ''; continue; }
      current += ch;
    }
    if (current.trim()) out.push(current.trim());
    return out.filter(Boolean);
  }

  function iconFamilyKey(family) {
    const key = String(family || '').toLowerCase().trim();
    if (ICON_FAMILIES.has(key)) return ICON_FAMILIES.get(key);
    if (/\bicons?$/.test(key)) return 'generic';
    return null;
  }

  // Private Use Area, written as escapes rather than literal glyphs so the
  // source survives any editor or transfer encoding: BMP U+E000-U+F8FF (Font
  // Awesome, Material Symbols, most icon sets) plus planes 15/16 (U+F0000+),
  // which arrive as surrogate pairs.
  const PUA_SINGLE_RE = /^(?:[\uE000-\uF8FF]|[\uDB80-\uDBBF][\uDC00-\uDFFF])$/;
  const PUA_ANY_RE = /[\uE000-\uF8FF]|[\uDB80-\uDBBF][\uDC00-\uDFFF]/;

  /**
   * Does this text look like a glyph rather than prose?
   *
   * The two rejections here are the whole defence against rendering a site's
   * body copy as icon ligatures: text containing a space, or longer than 32
   * characters, is prose — full stop. Combined with the first-family-only rule
   * at every iconFamilyKey() call site, a real sentence can never be mistaken
   * for an icon even when the page's font stack names an icon family further
   * down (Bootstrap and Tailwind both do).
   */
  function looksLikeGlyph(text) {
    const t = String(text || '').trim();
    if (!t) return false;
    if (PUA_SINGLE_RE.test(t)) return true;
    if (t.length > 32 || /\s/.test(t)) return false;
    // Ligature names: "search", "chevron_right", "arrow-drop-down".
    return /^[a-z0-9]+(?:[_-][a-z0-9]+)*$/i.test(t);
  }

  function containsPua(text) {
    return PUA_ANY_RE.test(String(text || ''));
  }

  function makeFontRegistry() {
    return { usage: new Map(), icons: new Set(), families: new Map() };
  }

  /** Is there a discoverable @font-face for this family, i.e. can we bundle it? */
  function fontFaceExistsFor(family) {
    const key = String(family || '').toLowerCase();
    if (!key) return false;
    const { fontFaces } = scanStyleSheets();
    return fontFaces.some((face) => face.family.toLowerCase() === key);
  }

  /** Does a public CDN stylesheet exist for this icon family? */
  function iconFamilyIsLinkable(family) {
    const key = iconFamilyKey(family);
    return !!key && key !== 'generic';
  }

  /**
   * Families whose EXACT NAME is served by the CDN we would link.
   *
   * The distinction matters and is easy to miss. ICON_FAMILIES maps many aliases
   * onto one key: "Google Material Icons" resolves to `material-icons`, so it looks
   * linkable. But the Material Icons CDN does not serve a font called "Google
   * Material Icons" — that is Google's own internal build, a different file with
   * its own private-use mapping. Link the public font and a codepoint like U+E5CD
   * lands on a different glyph, or on nothing at all. That is precisely how the
   * Google Sheets toolbar exported blank.
   */
  const CDN_EXACT_FAMILIES = new Set([
    'material icons', 'material icons outlined', 'material icons round',
    'material icons rounded', 'material icons sharp', 'material icons two tone',
    'material symbols outlined', 'material symbols rounded', 'material symbols sharp',
    'fontawesome', 'font awesome 5 free', 'font awesome 5 pro', 'font awesome 5 brands',
    'font awesome 6 free', 'font awesome 6 pro', 'font awesome 6 brands',
    'bootstrap icons', 'bootstrap-icons', 'glyphicons halflings', 'glyphicons'
  ]);

  /**
   * Can the export render this icon glyph as TEXT, or must the pixels be shipped?
   *
   * Text survives when the font can travel: either its @font-face is discoverable
   * so the binary is bundled, or it is a NAMED family we can link from a public CDN
   * (Material Icons, Font Awesome, Bootstrap Icons …), where the codepoints are
   * canonical and stable across builds.
   *
   * Everything else is an unknown icon font — `iconFamilyKey` reports 'generic' for
   * a family that merely looks icon-shaped — and there is nothing to bundle and
   * nothing safe to link. Applications with their own icon set land here: the font
   * arrives via the JS FontFace API or a CORS-restricted stylesheet, so no rule
   * exists to find. Google Sheets is the case that prompted this, and its entire
   * toolbar exported blank.
   *
   * Keeping text where possible matters: text stays scalable, recolourable and
   * greppable, so rasterizing is strictly the fallback.
   *
   * The question reduces to one thing: can the export supply THE FAMILY THIS
   * ELEMENT NAMES? CSS matches fonts by name, so a stylesheet serving "Material
   * Icons" does nothing for an element asking for "Google Material Icons" — the
   * element falls back and the glyph is lost either way, whether it was a
   * private-use codepoint (renders as nothing) or a ligature (renders as the
   * literal word "undo"). Recognising the family as Material-ish is not enough;
   * the name has to match exactly, or we have to be shipping the binary ourselves.
   */
  function iconGlyphSurvivesAsText(family) {
    if (fontFaceExistsFor(family)) return true;   // we ship this exact family
    return CDN_EXACT_FAMILIES.has(String(family || '').toLowerCase().trim());
  }

  /**
   * Record what happened to every icon family encountered.
   *
   * Diagnostics, not decoration. When icons come out blank the single most useful
   * fact is which family was involved and what was decided about it — guessing at
   * that from the outside has cost several rounds already.
   */
  function noteIconFamily(diag, family, text, decision) {
    const kind = containsPua(text) ? 'pua' : 'ligature';
    const key = (family || '(unnamed)') + ' | ' + kind + ' | ' + decision;
    diag.iconFamilies = diag.iconFamilies || {};
    diag.iconFamilies[key] = (diag.iconFamilies[key] || 0) + 1;
  }

  /**
   * Draw a glyph into a PNG at the size it occupies on screen.
   *
   * The escape hatch for an icon whose font cannot come along: if we can't ship
   * the font, ship the pixels. The glyph is already rendered in this page, so
   * canvas fillText reproduces it exactly, and the result is a plain <img> that
   * needs nothing at all to display.
   *
   * Rendered at device-pixel-ratio (floor 2) because icons are small and a 1x
   * raster of a 16px glyph looks obviously degraded next to the original.
   */
  function rasterizeGlyph(text, cs, rect) {
    try {
      const width = Math.max(1, Math.round(rect.width) || parseFloat(cs.fontSize) || 16);
      const height = Math.max(1, Math.round(rect.height) || parseFloat(cs.fontSize) || 16);
      if (width > 512 || height > 512) return null;      // not an icon; leave it alone

      const dpr = Math.min(4, Math.max(2, window.devicePixelRatio || 1));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;

      ctx.scale(dpr, dpr);
      const style = cs.fontStyle === 'normal' ? '' : cs.fontStyle + ' ';
      const weight = cs.fontWeight && cs.fontWeight !== '400' ? cs.fontWeight + ' ' : '';
      ctx.font = style + weight + parseFloat(cs.fontSize) + 'px ' + cs.fontFamily;
      ctx.fillStyle = cs.color || '#000';
      // Icon fonts centre their glyph in the em box, so centring on the element's
      // box reproduces the on-screen position closely without needing to model
      // line-height, baseline and padding individually.
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, width / 2, height / 2);

      // Refuse to emit a blank image: that would replace a missing icon with an
      // equally missing one while claiming success.
      const probe = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let painted = false;
      for (let i = 3; i < probe.length; i += 4) {
        if (probe[i] !== 0) { painted = true; break; }
      }
      if (!painted) return null;

      return { src: canvas.toDataURL('image/png'), w: width, h: height };
    } catch (_) {
      return null;
    }
  }

  const GENERIC_KEYWORDS = new Set([
    'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'math',
    'emoji', 'fangsong', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded'
  ]);

  /**
   * Is this font family actually available in this document?
   *
   * NOT document.fonts.check(): that answers "can the text be rendered?", which
   * is true for a completely unknown family because the browser will happily fall
   * back. Asking it about "Absolutely Proprietary Grotesk" returns true, and the
   * export then requests a family that does not exist.
   *
   * The reliable test is metric comparison: render a probe string with
   * `"family", <generic>` and with `<generic>` alone. If the family is missing,
   * both measure identically because the generic did all the work. Checking
   * against two very different generics makes a false positive essentially
   * impossible. Canvas measureText is synchronous and touches no layout.
   */
  const availabilityCache = new Map();
  let measureCtx = null;

  function isFamilyAvailable(family, weight, style) {
    const key = family.toLowerCase() + '|' + weight + '|' + style;
    if (availabilityCache.has(key)) return availabilityCache.get(key);

    let available = false;
    try {
      if (!measureCtx) {
        const canvas = document.createElement('canvas');
        canvas.width = 8;
        canvas.height = 8;
        measureCtx = canvas.getContext('2d');
      }
      if (measureCtx) {
        const probe = 'mmmwwwiiilll0123ABCgjpqy';
        const prefix = (style === 'italic' ? 'italic ' : '') + (weight || 400) + ' 72px ';
        const quoted = '"' + family.replace(/["\\]/g, '') + '"';
        let differs = 0;
        for (const generic of ['monospace', 'serif']) {
          measureCtx.font = prefix + generic;
          const baseline = measureCtx.measureText(probe).width;
          measureCtx.font = prefix + quoted + ', ' + generic;
          const candidate = measureCtx.measureText(probe).width;
          if (Math.abs(candidate - baseline) > 0.5) differs += 1;
        }
        available = differs === 2;
      }
    } catch (_) {
      available = false;
    }

    availabilityCache.set(key, available);
    return available;
  }

  /**
   * The family the browser ACTUALLY painted with: the first entry in the stack
   * that is genuinely available. Stops at a generic keyword, since everything
   * after it is a fallback the page never reached.
   */
  function resolveUsedFamily(stack, weight, style) {
    for (const family of stack) {
      if (GENERIC_KEYWORDS.has(family.toLowerCase())) return family;
      if (isFamilyAvailable(family, weight, style)) return family;
    }
    return stack[stack.length - 1] || '';
  }

  function recordFont(registry, cs, textLength, isIcon) {
    const stack = parseFamilyStack(cs.fontFamily);
    if (!stack.length) return null;
    const weight = normalizeWeight(cs.fontWeight);
    const italic = cs.fontStyle === 'italic' || cs.fontStyle.indexOf('oblique') === 0;
    const family = isIcon ? stack[0] : resolveUsedFamily(stack, weight, italic ? 'italic' : 'normal');
    if (!family) return null;

    const key = family.toLowerCase();
    let entry = registry.families.get(key);
    if (!entry) {
      entry = { family, weights: new Set(), italics: new Set(), chars: 0, icon: false };
      registry.families.set(key, entry);
    }
    entry.weights.add(weight);
    entry.italics.add(italic);
    entry.chars += Math.max(textLength, isIcon ? 1 : 0);
    if (isIcon) entry.icon = true;

    const iconKey = iconFamilyKey(family);
    if (iconKey && isIcon) registry.icons.add(iconKey);
    return family;
  }

  function normalizeWeight(value) {
    const named = { normal: 400, bold: 700, lighter: 300, bolder: 700 };
    if (named[value]) return named[value];
    const n = parseInt(value, 10);
    return isNaN(n) ? 400 : n;
  }

  /* ======================================================================== *
   * SECTION: style capture
   * ======================================================================== */

  function captureStyle(el, cs, parentCs, tag, opts, index) {
    const defaults = defaultsFor(tag);
    const style = Object.create(null);
    const isRoot = !!(opts && opts.isRoot);

    const inSvg = tag === 'svg' || !!el.ownerSVGElement;

    for (const prop of PROPS) {
      let value = cs.getPropertyValue(prop);
      if (value == null || value === '') continue;

      // SVG paint properties are computed on every HTML element too.
      if (!inSvg && SVG_PRESENTATION_PROPS.has(prop)) continue;

      // Context-derived values only count when the author declared them.
      if (AUTHORED_ONLY.has(prop) && !authoredProp(el, prop, index)) continue;

      const protected_ = PROTECTED_PROPS.has(prop);

      if (INHERITED.has(prop)) {
        if (isRoot) {
          // The root has no parent in the export, so it pins the inherited text
          // context — but only the part that affects rendering.
          if (!ROOT_INHERITED.has(prop) && defaults[prop] === value) continue;
        } else if (!protected_ && parentCs && parentCs.getPropertyValue(prop) === value) {
          continue;
        }
      } else if (defaults[prop] === value) {
        // Reset-adjusted default — the exported document re-supplies it. Applies
        // even to protected properties; see the note on PROTECTED_PROPS.
        continue;
      }

      let cleaned = cleanValue(prop, value);
      if (!cleaned) continue;

      // Some values survive computation with var() intact (notably inside
      // color-mix() and other functions the engine defers). The custom property
      // is not coming along, so an unresolved var() would render as nothing at
      // all — resolve it from the element, or drop the declaration.
      if (cleaned.indexOf('var(--') !== -1) {
        cleaned = resolveCustomProperties(cs, cleaned);
        if (cleaned.indexOf('var(--') !== -1) continue;
      }

      if (!protected_ && isDroppableValue(prop, cleaned)) continue;
      style[prop] = cleaned;
    }

    // Zero-width borders leave colour/style behind as noise.
    for (const side of ['top', 'right', 'bottom', 'left']) {
      if ((parseFloat(cs.getPropertyValue('border-' + side + '-width')) || 0) === 0) {
        delete style['border-' + side + '-color'];
        delete style['border-' + side + '-style'];
        delete style['border-' + side + '-width'];
      }
    }
    if ((parseFloat(cs.outlineWidth) || 0) === 0 || cs.outlineStyle === 'none') {
      delete style['outline-width']; delete style['outline-style'];
      delete style['outline-color']; delete style['outline-offset'];
    }

    // text-decoration-color computes to the element's colour even with no
    // decoration to paint, so it echoes `color` on essentially every node.
    if (cs.textDecorationLine === 'none' || !cs.textDecorationLine) {
      delete style['text-decoration-color'];
      delete style['text-decoration-style'];
      delete style['text-decoration-thickness'];
      delete style['text-underline-offset'];
    }
    // Same echo, different property: only meaningful when it disagrees with
    // colour (the gradient-text trick sets it to transparent).
    if (style['-webkit-text-fill-color'] === cleanValue('color', cs.color)) {
      delete style['-webkit-text-fill-color'];
    }

    // backdrop-filter needs the -webkit- alias to work in Safari-family engines.
    if (style['backdrop-filter'] && style['backdrop-filter'] !== 'none' &&
        !style['-webkit-backdrop-filter']) {
      style['-webkit-backdrop-filter'] = style['backdrop-filter'];
    }
    // `background-clip: text` is still prefix-only in several engines, and it is
    // half of the gradient-text technique — without the alias the text renders
    // transparent over an unclipped gradient, i.e. invisible.
    if (style['background-clip'] === 'text') {
      style['-webkit-background-clip'] = 'text';
    }

    applySizingPolicy(el, cs, tag, style, opts, index);
    return style;
  }

  /**
   * Sizing policy. A computed width is always a used px value, so emitting it
   * blindly pixel-locks text that was fluid. Authored-ness is decided from the
   * cascade (matched rules + inline style), not guessed.
   */
  function applySizingPolicy(el, cs, tag, style, opts, index) {
    const replaced = REPLACED_TAGS.has(tag) || tag === 'input' || tag === 'select' ||
      tag === 'textarea' || tag === 'progress' || tag === 'meter';
    const isRoot = !!(opts && opts.isRoot);
    const rect = rectOf(el);

    if (replaced) {
      if (rect.width) style.width = Math.round(rect.width * 100) / 100 + 'px';
      if (rect.height && tag !== 'textarea') style.height = Math.round(rect.height * 100) / 100 + 'px';
      return;
    }

    if (isRoot) {
      // Root-level structural elements adapt to the preview width rather than
      // being pinned to whatever the source viewport happened to be.
      const structural = /^(block|flex|grid|inline-flex|inline-grid)$/.test(cs.display) &&
        (el.childElementCount > 0 || rect.width > 320);
      if (structural && rect.width > 0) {
        style.width = '100%';
        style['max-width'] = Math.round(rect.width) + 'px';
      } else if (rect.width > 0 && authoredSizing(el, 'width', index)) {
        style.width = Math.round(rect.width * 100) / 100 + 'px';
      } else {
        delete style.width;
      }
      if (!authoredSizing(el, 'height', index)) delete style.height;
      return;
    }

    const hasText = !!(el.textContent || '').trim();
    const clips = /^(hidden|clip|auto|scroll)$/.test(cs.overflowY) || /^(hidden|clip|auto|scroll)$/.test(cs.overflowX);
    const isBox = !hasText && (hasPaint(cs) || cs.maskImage !== 'none' || cs.webkitMaskImage !== 'none');

    if (!authoredSizing(el, 'width', index) && !isBox) delete style.width;
    if (!authoredSizing(el, 'height', index) && !isBox && !clips) delete style.height;
  }

  /**
   * Which of the authorship-sensitive properties does the cascade actually
   * declare for this element? Answered from matched rules plus the inline style,
   * so an authored `width: 240px` is kept while a width that merely fell out of
   * layout is dropped. Memoized per element; only a small rule subset is scanned.
   */
  // Cascade-declared properties come from the pre-built index (see
  // buildMatchIndex); only the element's own inline style needs reading here.
  const authoredCache = new WeakMap();
  function authoredPropsOf(el, index) {
    let set = authoredCache.get(el);
    if (set) return set;

    set = new Set(index && index.authored.get(el));
    const inline = el.style;
    if (inline && inline.length) {
      for (let i = 0; i < inline.length; i += 1) set.add(inline.item(i));
    }

    authoredCache.set(el, set);
    return set;
  }

  function authoredProp(el, prop, index) {
    const set = authoredPropsOf(el, index);
    if (set.has(prop)) return true;
    // A width authored via flex-basis (or vice versa) still counts as authored.
    if (prop === 'width' && set.has('flex-basis')) return true;
    if (prop === 'flex-basis' && set.has('width')) return true;
    return false;
  }

  function authoredSizing(el, which, index) {
    return authoredProp(el, which, index);
  }

  /* ======================================================================== *
   * SECTION: hover capture
   * ======================================================================== */

  /**
   * Pre-index which elements each rule applies to, ONCE per capture.
   *
   * The obvious implementation — for each element, test it against every rule —
   * is O(elements x rules), and real applications make that fatal rather than
   * merely slow. YouTube Music ships tens of thousands of CSS rules, so a few
   * hundred selected nodes becomes millions of matches() calls and the capture
   * looks like a hang. Inverting it to one querySelectorAll per rule over the
   * selected subtree makes the cost O(rules) with the selector engine doing the
   * matching in native code, which is where it belongs.
   *
   * Returns { hover: Map<el, {own, ancestorRules}>, authored: Map<el, Set<prop>> }.
   */
  function buildMatchIndex(rootEl, scopes) {
    const { hoverRules, authoredRules } = scanStyleSheets();
    const hover = new Map();
    const authored = new Map();

    // querySelectorAll only looks at descendants, so the root itself is tested
    // separately or its own rules would be missed.
    const eachMatch = (selector, visit) => {
      for (const scope of scopes) {
        try {
          if (scope.nodeType === 1 && scope.matches(selector)) visit(scope);
          const found = scope.querySelectorAll(selector);
          for (const el of found) visit(el);
        } catch (_) { /* unsupported or malformed selector */ }
      }
    };

    for (const rule of hoverRules) {
      eachMatch(rule.full, (el) => {
        let entry = hover.get(el);
        if (!entry) { entry = { own: null, ancestorRules: [] }; hover.set(el, entry); }
        if (rule.onSubject) {
          if (!entry.own) entry.own = Object.create(null);
          for (const prop of Object.keys(rule.props)) {
            const cleaned = cleanValue(prop, rule.props[prop]);
            if (cleaned) entry.own[prop] = cleaned;
          }
        } else {
          entry.ancestorRules.push(rule);
        }
      });
    }

    for (const rule of authoredRules) {
      eachMatch(rule.selector, (el) => {
        let set = authored.get(el);
        if (!set) { set = new Set(); authored.set(el, set); }
        for (const prop of rule.declared) set.add(prop);
      });
    }

    return { hover, authored };
  }

  function captureHover(el, cs, chain, index) {
    const entry = index && index.hover.get(el);
    if (!entry) return null;

    const own = entry.own || Object.create(null);
    const viaAncestor = [];

    for (const rule of entry.ancestorRules) {

      // :hover sits on an ancestor (".card:hover .title" — hovering the card
      // reveals the button). Find which ancestor inside the capture it refers to
      // so the export can reproduce the nesting.
      //
      // Recorded as a HOP COUNT, not an object reference: finalize() works on a
      // deep clone of the frozen tree, so a reference into the original would
      // dangle. `up` counts levels from this node to the hovered ancestor, which
      // is stable under cloning.
      let up = 0;
      for (let i = chain.length - 1; i >= 0; i -= 1) {
        let hit = false;
        try { hit = chain[i].el.matches(rule.hoverCompound); } catch (_) { hit = false; }
        if (hit) { up = chain.length - i; break; }
      }
      if (!up) continue;
      const props = Object.create(null);
      for (const prop of Object.keys(rule.props)) {
        const cleaned = cleanValue(prop, rule.props[prop]);
        if (cleaned) props[prop] = cleaned;
      }
      if (Object.keys(props).length) viaAncestor.push({ up, props });
    }

    // Only the difference from the resting state is worth emitting.
    const diff = Object.create(null);
    for (const prop of Object.keys(own)) {
      const resting = cleanValue(prop, cs.getPropertyValue(prop));
      if (own[prop] !== resting) diff[prop] = own[prop];
    }

    const hasOwn = Object.keys(diff).length > 0;
    if (!hasOwn && !viaAncestor.length) return null;
    return { own: hasOwn ? diff : null, viaAncestor };
  }

  /* ======================================================================== *
   * SECTION: pseudo-element capture
   * ======================================================================== */

  const PSEUDO_PAINT_PROPS = ['background-image', 'box-shadow', 'transform', 'mask-image', '-webkit-mask-image'];

  function capturePseudo(el, which, cs) {
    let ps;
    try { ps = getComputedStyle(el, which); } catch (_) { return null; }
    if (!ps) return null;

    let content = ps.content;
    if (content === 'normal' || content === 'none' || content === '') content = null;

    // content: attr(x) computes as the literal function — resolve it.
    if (content && /^attr\(/.test(content)) {
      const attr = (/^attr\(\s*([^\s,)]+)/.exec(content) || [])[1];
      const value = attr && el.getAttribute ? el.getAttribute(attr) : null;
      content = value == null ? '' : JSON.stringify(value);
    }

    const hasVisual =
      !isTransparent(ps.backgroundColor) ||
      maxBorderWidth(ps) > 0 ||
      PSEUDO_PAINT_PROPS.some((p) => {
        const v = ps.getPropertyValue(p);
        return v && v !== 'none';
      }) ||
      (parseFloat(ps.width) > 0 && parseFloat(ps.height) > 0);

    // Include decorative pseudos with empty content — dividers, toggle handles,
    // custom checkbox marks all live there.
    if (content == null && !hasVisual) return null;
    if (content != null && stripQuotes(content) === '' && !hasVisual) return null;

    const style = Object.create(null);
    for (const prop of PSEUDO_PROPS) {
      if (prop === 'content') continue;
      const value = ps.getPropertyValue(prop);
      if (!value) continue;
      // Pseudos have no per-tag UA defaults worth diffing against, so compare to
      // the host element instead: identical values are inherited noise.
      if (INHERITED.has(prop) && cs.getPropertyValue(prop) === value) continue;
      const cleaned = cleanValue(prop, value);
      if (!cleaned) continue;
      if (isDroppableValue(prop, cleaned)) continue;
      if (cleaned === 'none' || cleaned === 'auto' || cleaned === 'normal') continue;
      if (/^0px$/.test(cleaned) && prop !== 'width' && prop !== 'height') continue;
      style[prop] = cleaned;
    }
    if (!style.display && content != null) style.display = ps.display;
    if (style.position === 'static') delete style.position;

    const text = content == null ? '' : stripQuotes(content);
    const stack = parseFamilyStack(ps.fontFamily);
    const firstFamily = stack[0] || '';
    const iconKey = stack.length ? iconFamilyKey(firstFamily) : null;
    const isIconGlyph = !!iconKey && containsPua(text);

    // Same font-cannot-travel problem as a text glyph, but a pseudo-element has no
    // node to swap for an <img>. The raster becomes its background instead, with
    // the content emptied so nothing tries to draw the missing character.
    let rasterized = false;
    if (isIconGlyph && !iconGlyphSurvivesAsText(firstFamily)) {
      const box = { width: parseFloat(ps.width) || parseFloat(ps.fontSize) || 16,
                    height: parseFloat(ps.height) || parseFloat(ps.fontSize) || 16 };
      const raster = rasterizeGlyph(text, ps, box);
      if (raster) {
        rasterized = true;
        style['background-image'] = 'url("' + raster.src + '")';
        style['background-size'] = 'contain';
        style['background-repeat'] = 'no-repeat';
        style['background-position'] = 'center';
        style.width = raster.w + 'px';
        style.height = raster.h + 'px';
        style.display = style.display && style.display !== 'inline' ? style.display : 'inline-block';
        delete style['font-family'];
      }
    }

    return {
      which: which === '::before' ? 'before' : 'after',
      content: rasterized ? '' : (content == null ? null : text),
      style,
      rasterized,
      iconFamily: isIconGlyph && !rasterized ? firstFamily : null,
      iconKey: isIconGlyph && !rasterized ? iconKey : null
    };
  }

  function stripQuotes(value) {
    const v = String(value).trim();
    if ((v[0] === '"' && v[v.length - 1] === '"') || (v[0] === "'" && v[v.length - 1] === "'")) {
      return v.slice(1, -1).replace(/\\(?:([0-9a-fA-F]{1,6})\s?|(.))/g, (m, hex, ch) =>
        hex ? String.fromCodePoint(parseInt(hex, 16)) : ch);
    }
    return v;
  }

  /* ======================================================================== *
   * SECTION: media capture
   * ======================================================================== */

  /**
   * Canvas-painted UI carries no clonable DOM, so the live bitmap is the only
   * truth available. Tainted canvases and unreadable contexts degrade to a
   * correctly-sized placeholder — never a throw, never an aborted export.
   */
  function captureCanvas(el, diag) {
    const rect = rectOf(el);
    const width = Math.round(rect.width) || el.width || 0;
    const height = Math.round(rect.height) || el.height || 0;

    let dataUri = null;
    try {
      dataUri = el.toDataURL('image/png');
      if (!dataUri || dataUri.length < 200) dataUri = null;
    } catch (_) {
      dataUri = null;                       // SecurityError: cross-origin taint
    }

    // A WebGL context without preserveDrawingBuffer reads back FULLY TRANSPARENT
    // rather than throwing, and a transparent 120x120 PNG is a perfectly valid
    // data URI of respectable length — so a size check alone silently exports a
    // blank rectangle where the WebGL scene was. Sample the pixels instead.
    //
    // A genuinely empty 2d canvas is also transparent, but there a placeholder
    // would be a lie: nothing was lost. So the two are told apart by which
    // context owns the canvas.
    if (dataUri && isBlankBitmap(el)) {
      if (!ownsTwoDContext(el)) dataUri = null;
    }

    if (!dataUri) {
      diag.canvasPlaceholders += 1;
      return { kind: 'placeholder', label: 'canvas ' + (el.width || 0) + '×' + (el.height || 0), width, height };
    }
    return { kind: 'image', src: dataUri, width, height, intrinsic: { w: el.width, h: el.height } };
  }

  /** Every sampled pixel fully transparent? Sampled small, so cost is constant. */
  function isBlankBitmap(el) {
    try {
      const size = 24;
      const probe = document.createElement('canvas');
      probe.width = size;
      probe.height = size;
      const ctx = probe.getContext('2d', { willReadFrequently: true });
      if (!ctx) return false;
      ctx.drawImage(el, 0, 0, size, size);
      const data = ctx.getImageData(0, 0, size, size).data;
      for (let i = 3; i < data.length; i += 4) {
        if (data[i] !== 0) return false;
      }
      return true;
    } catch (_) {
      return false;   // unreadable for another reason; let the caller decide
    }
  }

  /**
   * True when a 2d context owns this canvas. Contexts are exclusive, so a canvas
   * already driven by WebGL/WebGPU returns null here — which is the signal that a
   * transparent read means "could not read" rather than "nothing was drawn".
   */
  function ownsTwoDContext(el) {
    try { return !!el.getContext('2d'); } catch (_) { return false; }
  }

  const SVG_GEOMETRY = 'path,circle,rect,ellipse,line,polyline,polygon,text,image,use,foreignObject';

  /**
   * Inline SVG is preserved whole, but sprite definitions virtually always live
   * OUTSIDE the selected subtree, so every <use href="#id"> is resolved into a
   * local <defs>. Nested <use> inside a resolved symbol is followed too.
   */
  function captureSvg(el, cs, diag, keepDecorative) {
    let clone;
    try { clone = el.cloneNode(true); } catch (_) { return null; }

    // Drop the extension's own layers and anything executable.
    clone.querySelectorAll('script,' + '.' + PREFIX + 'style').forEach((n) => n.remove());
    clone.querySelectorAll('*').forEach((node) => {
      for (const attr of Array.from(node.attributes || [])) {
        if (/^on/i.test(attr.name)) node.removeAttribute(attr.name);
      }
    });

    // The writer splices our class/style into the serialized root tag, so the
    // page's own root class/style must go — otherwise the output carries a
    // duplicate attribute and the browser keeps the page's copy, not ours.
    clone.removeAttribute('class');
    clone.removeAttribute('style');

    resolveSvgUses(clone, el);

    // A purely decorative empty SVG (transparent outline-only rings and the
    // like) is noise; a stroke-only icon is not. Only drop the former.
    // keepDecorative is set when the user selected this svg on purpose, in which
    // case "it's only decoration" is not ours to decide.
    const geometry = clone.querySelectorAll(SVG_GEOMETRY);
    if (!keepDecorative) {
      if (!geometry.length && !clone.querySelector('defs symbol')) {
        diag.svgDropped += 1;
        return null;
      }
      if (geometry.length && allGeometryInvisible(el)) {
        diag.svgDropped += 1;
        return null;
      }
    }

    const rect = rectOf(el);
    if (rect.width) clone.setAttribute('width', Math.round(rect.width * 100) / 100);
    if (rect.height) clone.setAttribute('height', Math.round(rect.height * 100) / 100);
    if (!clone.getAttribute('viewBox') && el.viewBox && el.viewBox.baseVal) {
      const vb = el.viewBox.baseVal;
      if (vb.width) clone.setAttribute('viewBox', vb.x + ' ' + vb.y + ' ' + vb.width + ' ' + vb.height);
    }
    if (!clone.getAttribute('xmlns')) clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');

    // currentColor resolves against a `color` that may not survive; pin it.
    const fill = clone.getAttribute('fill');
    if (!fill || fill === 'currentColor') {
      const resolved = cleanValue('fill', cs.fill);
      if (resolved && resolved !== 'none') clone.setAttribute('fill', resolved);
    }
    if (clone.getAttribute('stroke') === 'currentColor') {
      const resolved = cleanValue('stroke', cs.stroke);
      if (resolved && resolved !== 'none') clone.setAttribute('stroke', resolved);
    }

    return { kind: 'raw', html: clone.outerHTML.replace(/\s*\n\s*/g, ' ') };
  }

  function allGeometryInvisible(el) {
    const nodes = el.querySelectorAll(SVG_GEOMETRY);
    if (!nodes.length) return true;
    for (const node of nodes) {
      let cs;
      try { cs = getComputedStyle(node); } catch (_) { return false; }
      const fillVisible = cs.fill && cs.fill !== 'none' && !isTransparent(cs.fill);
      const strokeVisible = cs.stroke && cs.stroke !== 'none' && !isTransparent(cs.stroke) &&
        (parseFloat(cs.strokeWidth) || 0) > 0;
      if (fillVisible || strokeVisible) return false;
    }
    return true;
  }

  function findById(id, contextNode) {
    const roots = [contextNode && contextNode.getRootNode ? contextNode.getRootNode() : document, document];
    for (const root of state.shadowRoots) roots.push(root);
    for (const root of roots) {
      if (!root) continue;
      try {
        const found = root.getElementById ? root.getElementById(id) : root.querySelector('#' + CSS.escape(id));
        if (found) return found;
      } catch (_) { /* noop */ }
    }
    return null;
  }

  function resolveSvgUses(clone, original) {
    const defs = { node: null };
    const added = new Set();
    const visited = new Set();

    const ensureDefs = () => {
      if (defs.node) return defs.node;
      let existing = clone.querySelector(':scope > defs');
      if (!existing) {
        existing = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
        clone.insertBefore(existing, clone.firstChild);
      }
      defs.node = existing;
      return existing;
    };

    const resolveIn = (scope, depth) => {
      if (depth > 6) return;
      const uses = scope.querySelectorAll('use');
      for (const use of uses) {
        const href = use.getAttribute('href') || use.getAttribute('xlink:href') || '';
        const hashIndex = href.indexOf('#');
        if (hashIndex === -1) continue;                 // external file, no hash
        const id = href.slice(hashIndex + 1);
        if (!id || added.has(id)) continue;
        if (visited.has(id)) continue;
        visited.add(id);

        const target = findById(id, original);
        if (!target) continue;

        let copy;
        try { copy = target.cloneNode(true); } catch (_) { continue; }
        copy.querySelectorAll && copy.querySelectorAll('script').forEach((n) => n.remove());
        ensureDefs().appendChild(copy);
        added.add(id);

        // Rewrite to a bare local reference so the export needs no page context.
        use.setAttribute('href', '#' + id);
        use.removeAttribute('xlink:href');

        resolveIn(copy, depth + 1);                     // nested <use>
      }
    };

    try { resolveIn(clone, 0); } catch (_) { /* leave unresolved rather than fail */ }
  }

  /* ======================================================================== *
   * SECTION: pixel recovery
   *
   * The fallback of last resort. When a node cannot be reproduced from source —
   * a tainted canvas, a cross-origin iframe, an icon whose font cannot travel, an
   * external SVG sprite we cannot fetch, or a box that would simply render empty —
   * its region is cropped out of a screenshot of the tab.
   *
   * One screenshot per export, cropped N times, because captureVisibleTab is
   * rate-limited and only sees the visible viewport.
   * ======================================================================== */

  /**
   * Would this node render as nothing at all?
   *
   * The point is to catch fidelity failures whose mechanism we never identified.
   * A box that takes up icon-sized space but has no text, no children, no
   * background, no border, no mask and no shadow is a hole in the export — whatever
   * produced it. Recovering its pixels is strictly better than shipping the hole.
   */
  function wouldRenderEmpty(node, style) {
    if (!node || node.k !== 'e') return false;
    if (node.ch && node.ch.length) return false;
    if (node.icon) return false;                       // handled by the icon path
    const s = style || node.style || {};
    if (s['background-image'] && s['background-image'] !== 'none') return false;
    if (s['mask-image'] || s['-webkit-mask-image']) return false;
    if (s['box-shadow'] && s['box-shadow'] !== 'none') return false;
    if (!isTransparent(s['background-color'] || 'transparent')) return false;
    for (const side of ['top', 'right', 'bottom', 'left']) {
      if (s['border-' + side + '-width'] && parseFloat(s['border-' + side + '-width']) > 0) return false;
    }
    return true;
  }

  const PIXEL_MIN = 6;        // smaller than this is a spacer, not a lost visual
  const PIXEL_MAX = 512;      // larger than this is a region, not a missing icon
  const PIXEL_LIMIT = 60;     // a cap, so a pathological page cannot emit hundreds
  const EMPTY_BOX_MAX = 64;   // "an icon is missing", not "this is a layout gap"

  function requestPixels(ctx, node, el, why) {
    if (ctx.pixelRequests.length >= PIXEL_LIMIT) {
      ctx.diag.pixelsSkipped = (ctx.diag.pixelsSkipped || 0) + 1;
      return;
    }

    // Inside a same-origin iframe, rects are relative to the FRAME's viewport. The
    // screenshot is of the top document, so the frame's offset has to be added or
    // every crop inside a frame samples the wrong part of the page.
    const raw = rectOf(el);
    const offset = ctx.frameOffset || { x: 0, y: 0 };
    const rect = offset.x || offset.y
      ? {
        left: raw.left + offset.x, top: raw.top + offset.y,
        right: raw.right + offset.x, bottom: raw.bottom + offset.y,
        width: raw.width, height: raw.height
      }
      : raw;

    if (rect.width < PIXEL_MIN || rect.height < PIXEL_MIN) return;
    if (rect.width > PIXEL_MAX || rect.height > PIXEL_MAX) return;

    // Only what is actually on screen can be cropped out of a screenshot.
    if (rect.bottom <= 0 || rect.top >= vh() || rect.right <= 0 || rect.left >= vw()) return;

    // The speculative trigger needs a tighter net than the known ones. A canvas or
    // an iframe is definitely a real visual we failed to read; an empty box is only
    // *probably* a missing icon, and pages are full of legitimate empty spacers.
    // Requiring it to be small and roughly square keeps icons and rejects gaps.
    if (why === 'empty box') {
      if (rect.width > EMPTY_BOX_MAX || rect.height > EMPTY_BOX_MAX) return;
      const ratio = rect.width / Math.max(1, rect.height);
      if (ratio < 0.5 || ratio > 2) return;
    }

    ctx.pixelRequests.push({
      node,
      why,
      rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
    });
  }

  /**
   * Take one screenshot and crop every pending request out of it.
   *
   * Our own overlay is hidden first — it is fixed-position chrome drawn over the
   * page, and captureVisibleTab photographs it along with everything else, so the
   * red hover outline would end up baked into the export.
   */
  async function recoverPixels(ctx) {
    if (!ctx.pixelRequests.length) return;

    const hostWasVisible = ui.host && ui.host.style.display !== 'none';
    if (hostWasVisible) ui.host.style.display = 'none';
    await nextTick();
    await nextTick();               // one frame to hide, one for the compositor

    let shot = null;
    try {
      shot = await sendToWorker({ type: 'CHEATER_CAPTURE_TAB' });
    } finally {
      if (hostWasVisible && ui.host) ui.host.style.display = '';
    }

    const dataUrl = shot && shot.value && shot.value.ok && shot.value.dataUrl;
    if (!dataUrl) {
      ctx.diag.pixelsFailed = ctx.pixelRequests.length;
      return;
    }

    let image;
    try {
      image = await loadImage(dataUrl);
    } catch (_) {
      ctx.diag.pixelsFailed = ctx.pixelRequests.length;
      return;
    }

    // The screenshot is in device pixels; derive the factor rather than trusting
    // devicePixelRatio, which disagrees with it under browser zoom.
    const scale = image.width / Math.max(1, vw());

    for (const request of ctx.pixelRequests) {
      const cropped = cropRegion(image, request.rect, scale);
      if (!cropped) { ctx.diag.pixelsFailed = (ctx.diag.pixelsFailed || 0) + 1; continue; }

      const node = request.node;
      node.k = 'img';
      node.tag = 'img';
      node.src = cropped;
      node.w = Math.round(request.rect.width);
      node.h = Math.round(request.rect.height);
      node.attrs = { alt: request.why };
      delete node.ch;
      delete node.label;
      ctx.diag.pixelsRecovered += 1;
    }
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('screenshot did not decode'));
      image.src = src;
    });
  }

  function cropRegion(image, rect, scale) {
    try {
      // Clamp to the screenshot: a partially offscreen element still yields the
      // part that was visible.
      const sx = Math.max(0, Math.round(rect.left * scale));
      const sy = Math.max(0, Math.round(rect.top * scale));
      const sw = Math.min(image.width - sx, Math.round(rect.width * scale));
      const sh = Math.min(image.height - sy, Math.round(rect.height * scale));
      if (sw <= 0 || sh <= 0) return null;

      const canvas = document.createElement('canvas');
      canvas.width = sw;
      canvas.height = sh;
      const ctx2d = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx2d) return null;
      ctx2d.drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh);

      // A crop with nothing in it is not a recovery. Emitting a flat 24x24 PNG for
      // every legitimately-empty spacer would bloat the export while claiming to
      // have fixed something, so a uniform region is refused and the node keeps
      // whatever it had.
      if (isUniformRegion(ctx2d, sw, sh)) return null;

      return canvas.toDataURL('image/png');
    } catch (_) {
      return null;
    }
  }

  function isUniformRegion(ctx2d, width, height) {
    try {
      const data = ctx2d.getImageData(0, 0, width, height).data;
      if (!data.length) return true;
      const r = data[0], g = data[1], b = data[2], a = data[3];
      for (let i = 4; i < data.length; i += 4) {
        if (data[i] !== r || data[i + 1] !== g || data[i + 2] !== b || data[i + 3] !== a) return false;
      }
      return true;
    } catch (_) {
      return false;   // unreadable: assume there is something there
    }
  }

  const INLINE_BUDGET = 10 * 1024 * 1024;
  const MAX_INLINE_PIXELS = 4e6;

  /**
   * Use the source the browser is ACTUALLY displaying: currentSrc reflects both
   * the chosen srcset/<picture> candidate and the real URL after a lazy-loader
   * has swapped out its placeholder.
   */
  function captureImage(el, diag, budget, taintedForPixels) {
    const src = el.currentSrc || el.getAttribute('src') || '';
    const rect = rectOf(el);

    // An image with no resolvable source renders as a broken-image glyph and
    // wrecks the row it sits in, so drop it and count it instead.
    if (!src) { diag.imagesDropped += 1; return null; }

    // Same for one that never actually loaded — a lazy-loader placeholder that
    // was still pending, or a 404.
    if ((!el.complete || !el.naturalWidth) && !/^data:/.test(src)) {
      diag.imagesDropped += 1;
      return null;
    }

    const width = Math.round(rect.width) || el.naturalWidth || 0;
    const height = Math.round(rect.height) || el.naturalHeight || 0;

    let out = src;
    const pixels = (el.naturalWidth || 0) * (el.naturalHeight || 0);
    if (!/^data:/.test(src) && pixels && pixels <= MAX_INLINE_PIXELS && budget.used < INLINE_BUDGET) {
      const inlined = inlineBitmap(el);
      if (inlined) {
        budget.used += inlined.length;
        out = inlined;
        diag.imagesInlined += 1;
      } else {
        diag.imagesTainted += 1;
        // Small cross-origin images (avatars, profile photos, favicons) commonly
        // need cookies the export will never have, and a broken-image glyph wrecks
        // the row. Recover the pixels instead; large images keep their URL, where a
        // screenshot crop would be a resolution downgrade.
        if (Math.max(width, height) <= 128) taintedForPixels.push(el);
      }
    }
    return { kind: 'image', src: out, width, height };
  }

  /**
   * Draw-and-read rather than fetch: the bitmap is already decoded in memory, so
   * this costs no network. A cross-origin image without CORS taints the canvas
   * and throws, which is the signal to keep the absolute URL instead.
   */
  function inlineBitmap(el) {
    try {
      const w = el.naturalWidth;
      const h = el.naturalHeight;
      if (!w || !h) return null;
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(el, 0, 0);
      // webp is dramatically smaller than png for photographic content and is
      // supported everywhere the export will realistically be opened.
      const webp = canvas.toDataURL('image/webp', 0.9);
      if (webp && webp.indexOf('data:image/webp') === 0) return webp;
      return canvas.toDataURL('image/png');
    } catch (_) {
      return null;
    }
  }

  /* ======================================================================== *
   * SECTION: form state
   * ======================================================================== */

  const BOOL_ATTRS = ['checked', 'selected', 'disabled', 'readonly', 'required', 'multiple', 'hidden', 'open'];

  /**
   * Live state, not markup defaults. Without this, <details> always exports
   * collapsed, checkboxes always export unchecked, and a filled-in search field
   * exports empty.
   */
  function captureFormState(el, tag, attrs) {
    if (tag === 'input') {
      const type = el.getAttribute('type') || 'text';
      attrs.type = type;
      if (type === 'checkbox' || type === 'radio') {
        if (el.checked) attrs.checked = true;
      } else if (el.value != null && el.value !== '') {
        attrs.value = el.value;
      }
    } else if (tag === 'textarea') {
      attrs['data-cheater-value'] = el.value || '';
    } else if (tag === 'option') {
      if (el.selected) attrs.selected = true;
    } else if (tag === 'select') {
      if (el.multiple) attrs.multiple = true;
    }

    for (const name of BOOL_ATTRS) {
      if (name === 'checked' || name === 'selected' || name === 'multiple') continue;
      if (el[name] === true || (el.hasAttribute && el.hasAttribute(name))) attrs[name] = true;
    }
    if (tag === 'details' && el.open) attrs.open = true;

    const placeholder = el.getAttribute && (el.getAttribute('placeholder') || el.getAttribute('aria-label'));
    if (placeholder && (tag === 'input' || tag === 'textarea')) attrs.placeholder = placeholder;

    const ariaLabel = el.getAttribute && el.getAttribute('aria-label');
    if (ariaLabel) attrs['aria-label'] = ariaLabel;
  }

  const KEEP_ATTRS = new Set([
    'href', 'src', 'alt', 'title', 'type', 'role', 'colspan', 'rowspan', 'span',
    'target', 'rel', 'datetime', 'lang', 'dir', 'for', 'name', 'value', 'min',
    'max', 'step', 'cols', 'rows', 'maxlength', 'width', 'height', 'download',
    'viewBox', 'd', 'points', 'cx', 'cy', 'r'
  ]);

  function captureAttributes(el, tag) {
    const attrs = Object.create(null);
    for (const attr of Array.from(el.attributes || [])) {
      const name = attr.name;
      if (name === 'class' || name === 'style' || name === 'id') continue;
      if (name.indexOf('cheater-') !== -1) continue;
      if (KEEP_ATTRS.has(name) || name.indexOf('aria-') === 0 || name.indexOf('data-') === 0) {
        if (name.indexOf('data-') === 0 && attr.value.length > 200) continue;
        attrs[name] = attr.value;
      }
    }
    if (tag === 'a' && attrs.href) attrs.href = absoluteUrl(attrs.href);
    if (tag === 'img') {
      delete attrs.src; delete attrs.srcset; delete attrs.width; delete attrs.height;
      if (!attrs.alt) attrs.alt = '';
    }
    captureFormState(el, tag, attrs);
    return attrs;
  }

  /* ======================================================================== *
   * SECTION: the capture walk (raw IR)
   * ======================================================================== */

  function newDiagnostics() {
    return {
      dropped: 0, hiddenDropped: 0, machineryDropped: 0, canvasPlaceholders: 0,
      imagesDropped: 0, imagesInlined: 0, imagesTainted: 0, svgDropped: 0,
      iconNodes: 0, iconsRasterized: 0, iconsLost: 0,
      pixelsRecovered: 0, pixelsFailed: 0, hiddenMenus: 0, closedMenusWired: 0,
      framesInlined: 0, framesPixels: 0, nativeSelects: 0, nodes: 0
    };
  }

  /**
   * Register every open shadow root in the subtree BEFORE the walk starts.
   *
   * Registering them lazily mid-walk would invalidate the stylesheet cache
   * repeatedly (each new root can contribute hover rules), turning one scan into
   * one-scan-per-root on component-heavy pages. Doing it up front means a single
   * scan that already sees every participating sheet.
   */
  function collectShadowRoots(root) {
    // Also returns every scope a selector has to be run against separately:
    // querySelectorAll does not cross a shadow boundary, so each root is its own
    // query scope for buildMatchIndex().
    const scopes = [root];
    const stack = [root];
    while (stack.length) {
      const el = stack.pop();
      if (!el || el.nodeType !== 1) continue;
      if (el.shadowRoot) {
        registerRoot(el.shadowRoot);
        scopes.push(el.shadowRoot);
        for (const child of el.shadowRoot.children) stack.push(child);
      }
      // A same-origin iframe's document is another scope entirely:
      // querySelectorAll does not cross a frame boundary any more than it crosses
      // a shadow boundary, so its rules would match nothing without this.
      if (tagOf(el) === 'iframe') {
        const doc = readableFrameDoc(el);
        if (doc) {
          registerFrameDoc(doc);
          scopes.push(doc);
          stack.push(doc.documentElement);
        }
      }
      for (const child of el.children) stack.push(child);
    }
    return scopes;
  }

  /**
   * How many elements the walk will visit, for the progress denominator.
   *
   * An estimate, not a promise: `querySelectorAll('*')` misses shadow content and
   * counts nodes the walk will filter out. Close enough to drive a bar, and the
   * reported percentage is clamped below 100 until the walk actually finishes so
   * it can never claim to be done early.
   */
  function estimateNodeCount(rootEl) {
    let total = 1;
    try { total += rootEl.querySelectorAll('*').length; } catch (_) { /* noop */ }
    for (const root of state.shadowRoots) {
      try { total += root.querySelectorAll('*').length; } catch (_) { /* noop */ }
    }
    return Math.max(1, total);
  }

  const YIELD_INTERVAL_MS = 16;   // one frame: long enough to be efficient, short
                                  // enough that the page never feels locked up
  const YIELD_CHECK_EVERY = 64;   // checking the clock per node would itself cost

  function nextTick() {
    return new Promise((resolve) => {
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
      else setTimeout(resolve, 0);
    });
  }

  /**
   * Cooperative yield during the walk.
   *
   * Trade-off worth being explicit about: a synchronous walk is an atomic snapshot
   * of the DOM, and yielding gives the page a chance to mutate mid-capture. Yields
   * are therefore spaced a frame apart rather than taken per node — the window is
   * small, and the alternative is a multi-second freeze with no feedback, which is
   * worse in every case a user actually hits.
   */
  async function maybeYield(ctx) {
    ctx.sinceCheck = (ctx.sinceCheck || 0) + 1;
    if (ctx.sinceCheck < YIELD_CHECK_EVERY) return;
    ctx.sinceCheck = 0;

    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (now - ctx.lastYield < YIELD_INTERVAL_MS) return;
    ctx.lastYield = now;

    if (ctx.onProgress) ctx.onProgress(ctx.diag.nodes / ctx.estimatedTotal);
    await nextTick();
  }

  async function captureRaw(rootEl, options) {
    const opts = options || {};
    const diag = newDiagnostics();
    const registry = makeFontRegistry();
    const budget = { used: 0 };

    const scopes = collectShadowRoots(rootEl);
    scanStyleSheets();                  // one scan, with every root in view

    const ctx = {
      index: buildMatchIndex(rootEl, scopes),
      diag,
      registry,
      budget,
      estimatedTotal: estimateNodeCount(rootEl),
      lastYield: (typeof performance !== 'undefined' ? performance.now() : Date.now()),
      sinceCheck: 0,
      onProgress: opts.onProgress || null,
      pixelRequests: [],
      // Closed-dropdown capture: how many were revealed, the pairs still to wire,
      // and a element -> node map, since a menu's trigger and host are built
      // before the menu itself is reached.
      ddRevealed: 0,
      ddPending: [],
      ddSeq: 0,
      nodeByEl: new Map()
    };

    // The crosshair is applied with !important, so it would be captured as a
    // genuine `cursor` value on every node. Lift it for the duration of the
    // (synchronous) walk so the extension's own affordance cannot leak into an
    // export — this is the one piece of our UI that isn't a DOM node we can skip.
    return withCursorSuppressed(async () => {
      const rootCs = getComputedStyle(rootEl);
      const parentEl = parentOrHost(rootEl);
      const node = await walkElement(rootEl, rootCs, null, ctx, [], true);

      // Wire closed menus to their triggers while the DOM is still here to consult.
      if (ctx.ddPending.length) resolveClosedMenus(ctx, rootEl);

      // Anything the walk could not reproduce gets its pixels cropped out of a
      // single screenshot. Deliberately after the walk: one screenshot, N crops.
      if (ctx.pixelRequests.length) {
        if (ctx.onProgress) ctx.onProgress(0.99);
        await recoverPixels(ctx);
      }

      return {
        node,
        diag,
        registry,
        parent: parentEl ? describeParentLayout(parentEl) : null,
        parentKey: parentEl,
        rect: rectOf(rootEl),
        position: rootCs.position
      };
    });
  }

  /**
   * Capture a closed dropdown menu by revealing it just long enough to read it.
   *
   * The node comes back marked as a menu, and the pairing is queued rather than
   * resolved here: the trigger is usually an earlier sibling whose node already
   * exists, and the host has to be an ancestor, so both are looked up after the
   * walk finishes.
   */
  async function captureClosedMenu(el, parentCs, ctx, chain) {
    if (ctx.ddRevealed >= MAX_HIDDEN_MENUS) return null;

    const restore = revealTemporarily(el);
    if (!restore) return null;

    ctx.ddRevealed += 1;
    let built = null;
    try {
      // Re-read after the reveal: this is the whole point, since the pre-reveal
      // style says display:none and every rect in the subtree reads zero.
      const revealedCs = getComputedStyle(el);
      built = await walkElement(el, revealedCs, parentCs, ctx, chain, false);
    } catch (_) {
      built = null;
    } finally {
      restore();
    }

    if (!built) return null;
    built.ddRole = 'menu';
    ctx.ddPending.push({ node: built, el });
    return built;
  }

  /**
   * Wire each captured closed menu to the thing that opens it.
   *
   * Three nodes matter: the menu, the trigger, and a host that contains both — the
   * host is what `:focus-within` is tested on. Runs after the walk, while the DOM
   * is still available, because the trigger and host nodes are built before the
   * menu is reached.
   */
  function resolveClosedMenus(ctx, rootEl) {
    for (const pending of ctx.ddPending) {
      const triggerEl = findMenuTrigger(pending.el, rootEl);

      // The host must contain both, and must itself be in the export.
      let hostEl = triggerEl ? commonAncestorEl(pending.el, triggerEl) : pending.el.parentElement;
      let hostNode = null;
      while (hostEl) {
        hostNode = ctx.nodeByEl.get(hostEl);
        if (hostNode) break;
        if (hostEl === rootEl) break;
        hostEl = hostEl.parentElement;
      }
      // No host in the export means the menu is a top-level selection of its own,
      // which the writer handles by synthesizing a wrapper instead.
      if (!hostNode || hostNode === pending.node) continue;

      const id = 'dd' + (ctx.ddSeq += 1);
      hostNode.ddId = id;
      hostNode.ddRole = 'host';
      pending.node.ddId = id;

      const triggerNode = triggerEl ? ctx.nodeByEl.get(triggerEl) : null;
      if (triggerNode && triggerNode !== hostNode && triggerNode !== pending.node) {
        triggerNode.ddId = id;
        triggerNode.ddRole = 'trigger';
      } else {
        // No distinct trigger node survived the walk, so the host itself takes the
        // focus. Clicking anywhere in the component opens the menu, which beats a
        // menu that cannot open at all.
        hostNode.ddFocusHost = true;
      }
      ctx.diag.closedMenusWired += 1;
    }
  }

  function detailsHidesContent(el) {
    for (const child of el.children) {
      if (tagOf(child) === 'summary') continue;
      let cs;
      try { cs = getComputedStyle(child); } catch (_) { continue; }
      if (cs.display === 'none' || cs.visibility === 'hidden') return true;
    }
    return false;
  }

  function commonAncestorEl(a, b) {
    if (!a || !b) return null;
    const seen = new Set();
    for (let el = a; el; el = el.parentElement) seen.add(el);
    for (let el = b; el; el = el.parentElement) if (seen.has(el)) return el;
    return null;
  }

  /**
   * Inline a same-origin iframe's real content.
   *
   * Previously every iframe — same-origin included — became a flat screenshot crop.
   * It looked right and was useless: there is no DOM in a picture, so "rebuild this
   * in React" had nothing to work from and the TOON carried a placeholder.
   *
   * The exported element becomes a plain <div> with the iframe's own box, because an
   * <iframe> cannot host captured children — it loads a URL. Inside it goes the
   * child's <body>, which carries the frame's background and base typography.
   *
   * Returns null when the frame cannot be read, so the caller can fall back.
   */
  async function captureFrame(el, cs, node, ctx, chain) {
    if ((ctx.frameDepth || 0) >= MAX_FRAME_DEPTH) return null;

    const doc = readableFrameDoc(el);
    if (!doc || !doc.body) return null;

    // Nothing to rebuild here: collectShadowRoots() walks into readable frames
    // before the capture starts, so the frame's document is already a scope in the
    // match index and its stylesheets are already in the scan.
    registerFrameDoc(doc);

    const rect = rectOf(el);

    // Rects inside a frame are relative to the FRAME's viewport, not the top one.
    // Pixel recovery crops from a screenshot of the top document, so anything
    // requested while inside here needs the frame's own offset added.
    const savedOffset = ctx.frameOffset || { x: 0, y: 0 };
    ctx.frameOffset = {
      x: savedOffset.x + rect.left + (parseFloat(cs.borderLeftWidth) || 0),
      y: savedOffset.y + rect.top + (parseFloat(cs.borderTopWidth) || 0)
    };
    ctx.frameDepth = (ctx.frameDepth || 0) + 1;

    let bodyNode = null;
    try {
      const bodyCs = getComputedStyle(doc.body);
      bodyNode = await walkElement(doc.body, bodyCs, cs, ctx, chain, false);
    } catch (_) {
      bodyNode = null;
    } finally {
      ctx.frameDepth -= 1;
      ctx.frameOffset = savedOffset;
    }

    if (!bodyNode) return null;

    // The frame's root is a <body>, and a nested <body> start tag is DISCARDED by
    // the HTML parser — its attributes get merged onto the export's own body, so the
    // frame's background and padding would silently leak to the whole page while the
    // frame box lost them. Retag it; the captured styles are what matter, not the
    // element name.
    if (bodyNode.tag === 'body' || bodyNode.tag === 'html') bodyNode.tag = 'div';

    ctx.diag.framesInlined += 1;

    // The whole frame document is captured, not just the part that happened to be
    // visible — so the exported box has to be SCROLLABLE, or everything past the
    // first screenful is present in the markup and unreachable in the render. An
    // iframe scrolls; `overflow:hidden` on the stand-in div silently threw that away.
    //
    // A frame that genuinely cannot scroll keeps hidden, so a deliberately clipped
    // banner or ad slot does not sprout a scrollbar it never had.
    node.tag = 'div';
    node.attrs = {};
    if (el.getAttribute('title')) node.attrs['aria-label'] = el.getAttribute('title');

    const box = {
      width: Math.round(rect.width) + 'px',
      height: Math.round(rect.height) + 'px',
      overflow: frameScrolls(el, doc) ? 'auto' : 'hidden'
    };

    // The frame's backdrop can come from its <html>, not its <body> — a common
    // pattern, and one that leaves the frame transparent in the export otherwise,
    // showing the host page through it.
    const rootBackground = frameRootBackground(doc, bodyNode);
    if (rootBackground) box['background-color'] = rootBackground;

    node.style = Object.assign({}, node.style || {}, box);
    node.ch = [bodyNode];
    return node;
  }

  async function walkElement(el, cs, parentCs, ctx, chain, isRoot) {
    const tag = tagOf(el);
    ctx.diag.nodes += 1;
    await maybeYield(ctx);

    const attrs = captureAttributes(el, tag);
    const style = captureStyle(el, cs, parentCs, tag, { isRoot }, ctx.index);

    // A native <select> keeps its <option> children — they are real DOM, so the
    // control still works in the export. Its OPEN popup, however, is drawn by the
    // operating system and exists nowhere in the document, so no capture technique
    // can reach it. Counted so the export can say that plainly.
    if (tag === 'select') ctx.diag.nativeSelects += 1;

    const node = {
      k: 'e', tag, attrs, style,
      hover: null, pseudo: null, ch: [], icon: false
    };
    ctx.nodeByEl.set(el, node);

    // Media paths replace the node's children wholesale.
    if (tag === 'canvas') {
      const shot = captureCanvas(el, ctx.diag);
      if (shot.kind === 'image') {
        return { k: 'img', tag: 'img', attrs: { alt: '' }, style, src: shot.src, w: shot.width, h: shot.height };
      }
      // Unreadable canvas: the bitmap is invisible to us but not to the screen.
      const placeholder = { k: 'ph', tag: 'div', attrs: {}, style, label: shot.label, w: shot.width, h: shot.height };
      requestPixels(ctx, placeholder, el, 'canvas');
      return placeholder;
    }
    // isRoot means the user pointed at this element deliberately. The "drop it"
    // rules below exist to keep noise out of a subtree walk, and applying them to
    // an explicit target instead produces "I clicked it and nothing happened".
    // An explicit target is therefore never dropped, only degraded.
    if (tag === 'svg') {
      const shot = captureSvg(el, cs, ctx.diag, isRoot);
      if (shot) return { k: 'raw', html: shot.html, style, tag: 'svg' };
      if (!isRoot) return null;
      const rect = rectOf(el);
      const placeholder = {
        k: 'ph', tag: 'div', attrs: {}, style,
        label: 'empty svg', w: Math.round(rect.width), h: Math.round(rect.height)
      };
      requestPixels(ctx, placeholder, el, 'svg');
      return placeholder;
    }
    if (tag === 'img') {
      const tainted = [];
      const shot = captureImage(el, ctx.diag, ctx.budget, tainted);
      if (shot) {
        const imgNode = { k: 'img', tag: 'img', attrs, style, src: shot.src, w: shot.width, h: shot.height };
        if (tainted.length) requestPixels(ctx, imgNode, el, 'cross-origin image');
        return imgNode;
      }
      if (!isRoot) return null;
      const rect = rectOf(el);
      const placeholder = {
        k: 'ph', tag: 'div', attrs: {}, style,
        label: 'image unavailable', w: Math.round(rect.width), h: Math.round(rect.height)
      };
      requestPixels(ctx, placeholder, el, 'image');
      return placeholder;
    }
    if (tag === 'iframe') {
      const inlined = await captureFrame(el, cs, node, ctx, chain.concat([{ el, node }]));
      if (inlined) return inlined;
      // Cross-origin, or too deep: nothing here can read it, so the pixels are the
      // only truthful thing left.
      const rect = rectOf(el);
      const placeholder = {
        k: 'ph', tag: 'div', attrs: {}, style,
        label: 'cross-origin iframe', w: Math.round(rect.width), h: Math.round(rect.height)
      };
      ctx.diag.framesPixels += 1;
      requestPixels(ctx, placeholder, el, 'iframe');
      return placeholder;
    }
    if (tag === 'video' || tag === 'embed' || tag === 'object') {
      const rect = rectOf(el);
      const placeholder = {
        k: 'ph', tag: 'div', attrs: {}, style,
        label: tag, w: Math.round(rect.width), h: Math.round(rect.height)
      };
      requestPixels(ctx, placeholder, el, tag);
      return placeholder;
    }

    node.hover = captureHover(el, cs, chain, ctx.index);
    const before = capturePseudo(el, '::before', cs);
    const after = capturePseudo(el, '::after', cs);
    if (before || after) node.pseudo = { before, after };
    for (const pseudo of [before, after]) {
      if (pseudo && pseudo.iconKey) {
        ctx.registry.icons.add(pseudo.iconKey);
        recordFont(ctx.registry, { fontFamily: pseudo.iconFamily, fontWeight: '400', fontStyle: 'normal' }, 1, true);
      }
    }

    // Icon-font signal. First family in the stack ONLY, plus a glyph-shaped
    // payload — see looksLikeGlyph() for why both halves are mandatory.
    const ownText = directText(el);
    const stack = parseFamilyStack(cs.fontFamily);
    const firstFamily = stack[0] || '';
    const iconKey = iconFamilyKey(firstFamily);
    const classSignal = ICON_CLASS_RE.test(classListOf(el).join(' '));
    const glyphish = looksLikeGlyph(ownText);
    if (glyphish && (iconKey || (classSignal && containsPua(ownText)))) {
      node.icon = true;
      ctx.diag.iconNodes += 1;

      if (!iconGlyphSurvivesAsText(firstFamily)) {
        // The font cannot come along, so the glyph is rasterized and the node
        // becomes an image. Without this the icon exports as an invisible
        // private-use character and the component looks gutted.
        const raster = rasterizeGlyph(ownText, cs, rectOf(el));
        if (raster) {
          ctx.diag.iconsRasterized += 1;
          noteIconFamily(ctx.diag, firstFamily, ownText, 'rasterized');
          delete node.style['font-family'];
          delete node.style['font-feature-settings'];
          delete node.style['-webkit-font-feature-settings'];
          delete node.style['font-variation-settings'];
          return {
            k: 'img', tag: 'img', attrs: { alt: ownText }, style: node.style,
            src: raster.src, w: raster.w, h: raster.h
          };
        }
        ctx.diag.iconsLost += 1;
        noteIconFamily(ctx.diag, firstFamily, ownText, 'lost');
        requestPixels(ctx, node, el, 'icon');
      } else {
        if (iconKey) ctx.registry.icons.add(iconKey);
        noteIconFamily(ctx.diag, firstFamily, ownText,
          fontFaceExistsFor(firstFamily) ? 'bundled' : 'linked');
      }

      // Ligature families render the literal word "search" without this.
      node.style['font-feature-settings'] = node.style['font-feature-settings'] || '"liga"';
      node.style['-webkit-font-feature-settings'] = '"liga"';
      if (/material symbols/i.test(firstFamily)) {
        node.style['font-variation-settings'] = cs.fontVariationSettings && cs.fontVariationSettings !== 'normal'
          ? cs.fontVariationSettings
          : "'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 24";
      }
    }

    if (ownText || node.icon) recordFont(ctx.registry, cs, ownText.length, node.icon);

    const shadow = el.shadowRoot;
    if (shadow) registerRoot(shadow);

    const nextChain = chain.concat([{ el, node }]);

    // A closed <details> hides its own content, so every child would be filtered as
    // hidden and the export would render a disclosure widget with nothing inside it
    // — it opens, and stays empty. Opening it for the duration of the child walk
    // fixes that; the export keeps `open` absent, so it still renders closed and
    // works natively with no help from us.
    // Only when the engine actually hides that content: current Chrome lays a closed
    // details' children out and hides ::details-content instead, so this costs
    // nothing and touches nothing there. Older engines used display:none on the
    // children, and on those it is the difference between a working disclosure and
    // an empty one.
    let detailsOpened = false;
    if (tag === 'details' && !el.hasAttribute('open') && detailsHidesContent(el)) {
      try { el.setAttribute('open', ''); detailsOpened = true; } catch (_) { detailsOpened = false; }
    }

    const childNodes = collectChildNodes(el, shadow);
    const collapses = !/^(pre|pre-wrap|pre-line|break-spaces)$/.test(cs.whiteSpace);
    const dropsWhitespace = /^(flex|grid|inline-flex|inline-grid|table|table-row|table-row-group|none)$/.test(cs.display);

    // A <slot> is a projection point, not a box: it is replaced by whatever the
    // light DOM assigned to it, spliced in at the slot's position so the flattened
    // tree matches what the browser actually renders.
    const expanded = [];
    for (const child of childNodes) {
      if (child.nodeType === 1 && tagOf(child) === 'slot') {
        for (const projected of slotContent(child)) expanded.push(projected);
      } else {
        expanded.push(child);
      }
    }

    try {
    for (const child of expanded) {
      if (child.nodeType === 3) {
        const text = normalizeText(child.nodeValue, collapses, dropsWhitespace, child);
        if (text) node.ch.push({ k: 't', v: text });
        continue;
      }
      if (child.nodeType !== 1) continue;
      if (isOurs(child)) continue;

      const childTag = tagOf(child);
      if (SKIP_TAGS.has(childTag)) { ctx.diag.machineryDropped += 1; ctx.diag.dropped += 1; continue; }

      let childCs;
      try { childCs = getComputedStyle(child); } catch (_) { continue; }

      // opacity:0 is usually animation state, so it is deliberately NOT filtered.
      if (childCs.display === 'none' || childCs.visibility === 'hidden') {
        // A closed dropdown is the one hidden subtree worth having. Dropping it is
        // why an exported dropdown had nothing to open: the menu was never in the
        // capture at all. Everything else hidden stays dropped — capturing every
        // hidden subtree on a page would bloat exports and carry along content
        // nobody selected.
        if (looksLikeHiddenMenu(child)) {
          ctx.diag.hiddenMenus += 1;
          const built = await captureClosedMenu(child, cs, ctx, nextChain);
          if (built) { node.ch.push(built); continue; }
        }
        ctx.diag.hiddenDropped += 1;
        ctx.diag.dropped += 1;
        continue;
      }
      if (isEmptyZeroBox(child, childCs)) { ctx.diag.dropped += 1; continue; }

      const built = await walkElement(child, childCs, cs, ctx, nextChain, false);
      if (built) node.ch.push(built);
    }

    } finally {
      if (detailsOpened) {
        try { el.removeAttribute('open'); } catch (_) { /* noop */ }
      }
    }

    if (tag === 'textarea' && node.attrs['data-cheater-value']) {
      node.ch = [{ k: 't', v: node.attrs['data-cheater-value'] }];
      delete node.attrs['data-cheater-value'];
    }

    // Last check before handing the node back: does it occupy icon-sized space and
    // yet paint nothing at all? That is a hole in the export whose cause we never
    // identified — a glyph from a font we could not detect, an external sprite
    // reference, a pseudo we filtered, a technique nobody has thought of yet.
    // Rather than shipping the hole, recover the pixels.
    if (!isRoot && wouldRenderEmpty(node, node.style) && !node.pseudo) {
      requestPixels(ctx, node, el, 'empty box');
    }

    return node;
  }

  /**
   * The children that actually render: the shadow tree when one is attached,
   * otherwise the light DOM.
   *
   * When a shadow root exists, ONLY its children are returned. The light DOM is
   * not appended alongside — it reaches the screen through <slot>, and the walk
   * expands each slot into its assigned nodes (see the slot branch in the child
   * loop). Appending it here as well would duplicate every projected node, and
   * skipping it entirely would drop projected content on the floor.
   */
  function collectChildNodes(el, shadow) {
    if (shadow) return Array.from(shadow.childNodes);
    return Array.from(el.childNodes);
  }

  /**
   * The flattened content of a <slot>: whatever the light DOM projected into it,
   * or the slot's own fallback children when nothing was assigned.
   */
  function slotContent(slot) {
    let assigned = [];
    try {
      assigned = slot.assignedNodes ? slot.assignedNodes({ flatten: true }) : [];
    } catch (_) { assigned = []; }
    return assigned.length ? assigned : Array.from(slot.childNodes);
  }

  function directText(el) {
    let out = '';
    for (const child of el.childNodes) {
      if (child.nodeType === 3) out += child.nodeValue;
    }
    return out.trim();
  }

  function isEmptyZeroBox(el, cs) {
    const rect = rectOf(el);
    if (rect.width > 0 || rect.height > 0) return false;
    if (el.childElementCount > 0) return false;
    if ((el.textContent || '').trim()) return false;
    if (VOID_TAGS.has(tagOf(el))) return false;
    try {
      const before = getComputedStyle(el, '::before').content;
      const after = getComputedStyle(el, '::after').content;
      if ((before && before !== 'none' && before !== 'normal') ||
          (after && after !== 'none' && after !== 'normal')) return false;
    } catch (_) { /* noop */ }
    return true;
  }

  /**
   * Interleaved text must keep its position AND its edge spaces:
   * `Best price, <em>guaranteed</em> daily` loses its meaning otherwise.
   */
  function normalizeText(raw, collapses, dropsWhitespace, node) {
    if (!collapses) return raw;
    if (!/\S/.test(raw)) {
      if (dropsWhitespace) return '';
      const hasElementSibling = (node.previousSibling && node.nextSibling);
      return hasElementSibling ? ' ' : '';
    }
    return raw.replace(/\s+/g, ' ');
  }

  function describeParentLayout(parentEl) {
    let cs;
    try { cs = getComputedStyle(parentEl); } catch (_) { return null; }
    if (!/^(flex|grid|inline-flex|inline-grid|table-row)$/.test(cs.display)) return null;

    const props = [
      'display', 'flex-direction', 'flex-wrap', 'justify-content', 'align-items',
      'align-content', 'gap', 'grid-template-columns',
      'grid-template-rows', 'grid-template-areas', 'grid-auto-flow',
      'grid-auto-columns', 'grid-auto-rows', 'padding-top',
      'padding-right', 'padding-bottom', 'padding-left'
    ];
    const style = Object.create(null);
    for (const prop of props) {
      const value = cleanValue(prop, cs.getPropertyValue(prop));
      if (!value || value === 'normal' || value === 'none' || value === '0px' || value === 'auto') continue;
      style[prop] = value;
    }
    style.display = cs.display === 'table-row' ? 'flex' : cs.display;
    return style;
  }

  /* ======================================================================== *
   * SECTION: @font-face selection
   * ======================================================================== */

  /**
   * Did this @font-face come from a Google Fonts stylesheet?
   *
   * The test is the ORIGIN OF THE RULE, not the host of the binary. Judging by the
   * font URL misclassifies a page that self-hosts a font it happened to copy from
   * gstatic: that face would be dropped from the bundle and then requested from
   * Google under a family name Google has never heard of — HTTP 400, no font.
   *
   * Usually returns false even for real Google fonts, because a plain
   * `<link rel="stylesheet">` is fetched in no-cors mode and `cssRules` throws no
   * matter what CORS headers the response carries. googleLinkedFamilies() below is
   * what actually recognises them.
   */
  const GOOGLE_CSS_HOST = /(^|\.)fonts\.googleapis\.com$/i;

  function isGoogleHostedFace(face) {
    if (face.inline || !face.sheetHref) return false;
    try { return GOOGLE_CSS_HOST.test(new URL(face.sheetHref).hostname); } catch (_) { return false; }
  }

  /**
   * Families the page loads from Google Fonts, read straight off the <link> hrefs.
   *
   * This exists because the stylesheet contents are unreadable (see above), yet we
   * still need to know these families are safely linkable. Without it, every
   * Google-font page would be flagged "primary font isn't auto-loadable" even
   * though the export renders it perfectly — and the warning that is supposed to
   * explain real text-width drift would become noise nobody trusts.
   *
   * Handles both API generations: css2 uses one `family=` param per family, css
   * (v1) packs them into `family=A|B|C`.
   */
  function googleLinkedFamilies() {
    const out = new Set();
    let hrefs = [];
    try {
      hrefs = Array.from(document.querySelectorAll('link[href]')).map((l) => l.href);
    } catch (_) { hrefs = []; }

    // @import url(...) inside any readable stylesheet counts too.
    for (const sheet of allStyleSheets()) {
      let rules = null;
      try { rules = sheet.cssRules; } catch (_) { continue; }
      for (const rule of rules || []) {
        if (rule.type === 3 /* IMPORT_RULE */ && rule.href) hrefs.push(rule.href);
      }
    }

    for (const href of hrefs) {
      if (!href || href.indexOf('fonts.googleapis.com') === -1) continue;
      try {
        const url = new URL(href, document.baseURI);
        for (const [key, value] of url.searchParams) {
          if (key !== 'family') continue;
          for (const part of String(value).split('|')) {
            const name = part.split(':')[0].trim();
            if (name) out.add(name.toLowerCase());
          }
        }
      } catch (_) { /* malformed href */ }
    }
    return out;
  }

  function pickFontFaces(registry) {
    const { fontFaces } = scanStyleSheets();
    const googleHosted = googleLinkedFamilies();
    if (!fontFaces.length) return { bundle: [], googleHosted };

    const used = new Set();
    for (const entry of registry.families.values()) used.add(entry.family.toLowerCase());

    const bundle = [];
    const seen = new Set();

    for (const face of fontFaces) {
      const key = face.family.toLowerCase();
      if (!used.has(key)) continue;
      if (isGoogleHostedFace(face)) { googleHosted.add(key); continue; }
      if (seen.has(face.url)) continue;
      seen.add(face.url);
      bundle.push(face);
    }
    return { bundle, googleHosted };
  }

  function buildFontPlan(registry, bundledFamilies, googleHosted) {
    const google = [];
    let primary = null;
    let primaryChars = -1;

    for (const entry of registry.families.values()) {
      const key = entry.family.toLowerCase();
      if (entry.chars > primaryChars) { primaryChars = entry.chars; primary = entry; }
      if (SYSTEM_FAMILIES.has(key)) continue;
      if (iconFamilyKey(entry.family)) continue;      // icon families get their own link
      if (bundledFamilies.has(key)) continue;         // shipped as @font-face binaries
      google.push({
        family: entry.family,
        weights: Array.from(entry.weights).sort((a, b) => a - b),
        italics: Array.from(entry.italics),
        // Confirmed present on Google Fonts, because the page itself loaded it
        // from there — so this link is guaranteed to resolve.
        confirmed: !!(googleHosted && googleHosted.has(key))
      });
    }

    const primaryFamily = primary ? primary.family : '';
    const primaryKey = primaryFamily.toLowerCase();

    // "Loadable" means something in the export will actually supply this font.
    // A family we merely GUESS is on Google Fonts is not a guarantee, so only a
    // confirmed Google-hosted family or a bundled binary counts — otherwise the
    // UI would stay silent about the very case that causes text-width drift.
    const loadable =
      !primaryFamily ||
      SYSTEM_FAMILIES.has(primaryKey) ||
      bundledFamilies.has(primaryKey) ||
      !!iconFamilyKey(primaryFamily) ||
      google.some((f) => f.family.toLowerCase() === primaryKey && f.confirmed);

    return {
      google,
      icons: Array.from(registry.icons),
      primary: primaryFamily,
      primaryLoadable: loadable,
      primarySystem: SYSTEM_FAMILIES.has(primaryKey)
    };
  }

  /* ======================================================================== *
   * SECTION: finalize (pure — no DOM reads)
   *
   * Turns the frozen raw trees into a payload with shared style tables. A style
   * set used more than once becomes a .sN class; a genuinely one-off set stays
   * inline, which is exactly the "don't repeat the same 40 properties 60 times,
   * don't invent a class for a unique value" split the format wants.
   * ======================================================================== */

  function styleKey(style) {
    if (!style) return '';
    const keys = Object.keys(style).sort();
    let out = '';
    for (const key of keys) out += key + ':' + style[key] + ';';
    return out;
  }

  /**
   * Deep clone of a raw node tree.
   *
   * finalize() rewrites nodes in place (styles move into the shared table, hover
   * and pseudo data are consumed), so it MUST work on a copy. Without this, a
   * second export of the same selection — or the service worker collecting a
   * frame twice — would serialize trees whose styles had already been stripped,
   * producing a silently unstyled document. Structured-clone-shaped by hand
   * because the raw tree holds only plain objects, arrays and primitives.
   */
  function cloneNodeTree(node) {
    if (node == null || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map(cloneNodeTree);
    const out = {};
    for (const key of Object.keys(node)) out[key] = cloneNodeTree(node[key]);
    return out;
  }

  function finalize(selections) {
    // Work on clones so the frozen capture stays reusable (see cloneNodeTree).
    const work = selections.map((sel) => ({
      sel,
      node: cloneNodeTree(sel.raw.node),
      parentKey: sel.raw.parentKey,
      parentLayout: sel.raw.parent,
      position: sel.raw.position
    }));

    const counts = new Map();
    const countNode = (node) => {
      if (!node) return;
      if (node.style && Object.keys(node.style).length) {
        const key = styleKey(node.style);
        counts.set(key, (counts.get(key) || 0) + 1);
      }
      (node.ch || []).forEach(countNode);
    };
    for (const item of work) countNode(item.node);

    const styles = Object.create(null);
    const pseudos = Object.create(null);
    const wrappers = Object.create(null);
    const hovers = [];
    const classByKey = new Map();
    const pseudoByKey = new Map();
    let sSeq = 0, pSeq = 0, wSeq = 0;

    // A style set used more than once becomes a shared class; a genuinely
    // one-off set stays inline. `force` mints a class anyway for nodes that need
    // one to hang a :hover rule on, since there is nothing to attach otherwise.
    const classFor = (style, force) => {
      const key = styleKey(style);
      if (!key && !force) return null;
      if (!force && (counts.get(key) || 0) < 2) return null;
      let name = classByKey.get(key);
      if (!name) {
        name = 's' + (sSeq += 1);
        classByKey.set(key, name);
        styles[name] = style || {};
      }
      return name;
    };

    const pseudoClassFor = (pseudo) => {
      const payload = {
        before: pseudo.before ? { content: pseudo.before.content, style: pseudo.before.style } : null,
        after: pseudo.after ? { content: pseudo.after.content, style: pseudo.after.style } : null
      };
      const key = JSON.stringify(payload);
      let name = pseudoByKey.get(key);
      if (!name) {
        name = 'p' + (pSeq += 1);
        pseudoByKey.set(key, name);
        pseudos[name] = payload;
      }
      return name;
    };

    // Pass 0: mark the hosts of ancestor-hover rules.
    //
    // ".hover-card:hover .reveal" is recorded on the *reveal* node, but the
    // selector needs a class on the CARD. The card frequently has no other reason
    // to get one (its own style set is unique, and it has no :hover of its own),
    // so without this pass classFor() declines to mint one and the whole rule is
    // dropped — the card's hover-to-reveal behaviour silently disappears.
    const markHoverHosts = (node, stack) => {
      if (!node || node.k === 't') return;
      for (const rule of (node.hover && node.hover.viaAncestor) || []) {
        const host = stack[stack.length - rule.up];
        if (host) host.needsClass = true;
      }
      const nextStack = stack.concat([node]);
      (node.ch || []).forEach((child) => markHoverHosts(child, nextStack));
    };
    for (const item of work) markHoverHosts(item.node, []);

    // Pass 1: assign classes. Must complete before hover selectors are written,
    // because an ancestor-hover rule needs the ancestor's class to exist.
    const assign = (node) => {
      if (!node) return;
      if (node.k === 't') return;        // text nodes carry no style or classes
      node.cls = [];
      const hasHover = !!(node.hover && (node.hover.own || (node.hover.viaAncestor || []).length));
      const name = classFor(node.style, hasHover || node.needsClass);
      if (name) {
        node.sClass = name;
        node.cls.push(name);
      } else if (node.style && Object.keys(node.style).length) {
        node.inline = node.style;       // genuinely per-element — stays inline
      }
      delete node.style;                // from here on: cls + inline only
      delete node.needsClass;
      if (node.pseudo && (node.pseudo.before || node.pseudo.after)) {
        node.cls.push(pseudoClassFor(node.pseudo));
      }
      (node.ch || []).forEach(assign);
    };
    for (const item of work) assign(item.node);

    // Pass 2: hover selectors. `stack` holds this node's ancestors within the
    // selection (root first), so a rule recorded as `up: 2` resolves to
    // stack[stack.length - 2] — the same element captureHover() matched.
    const emitHovers = (node, stack) => {
      if (!node) return;
      if (node.hover) {
        if (node.hover.own && node.sClass) {
          hovers.push({ sel: '.' + node.sClass + ':hover', props: node.hover.own });
        }
        for (const rule of node.hover.viaAncestor || []) {
          const host = stack[stack.length - rule.up];
          if (host && host.sClass && node.sClass) {
            hovers.push({ sel: '.' + host.sClass + ':hover .' + node.sClass, props: rule.props });
          }
        }
        delete node.hover;
      }
      delete node.pseudo;
      const nextStack = stack.concat([node]);
      (node.ch || []).forEach((child) => emitHovers(child, nextStack));
    };
    for (const item of work) emitHovers(item.node, []);

    // Several nodes can share one style class, so the same selector can be
    // emitted more than once. Merge instead of repeating the rule.
    const hoversBySelector = new Map();
    for (const rule of hovers) {
      const existing = hoversBySelector.get(rule.sel);
      if (existing) Object.assign(existing.props, rule.props);
      else hoversBySelector.set(rule.sel, rule);
    }
    hovers.length = 0;
    for (const rule of hoversBySelector.values()) hovers.push(rule);

    // Parent-layout wrapping: siblings sharing a parent wrap together, so inner
    // selections keep flowing correctly instead of collapsing into a stack.
    const groups = [];
    const byParent = new Map();
    for (const item of work) {
      if (!item.parentLayout || !item.parentKey) { groups.push({ layout: null, items: [item] }); continue; }
      let group = byParent.get(item.parentKey);
      if (!group) {
        group = { layout: item.parentLayout, items: [] };
        byParent.set(item.parentKey, group);
        groups.push(group);
      }
      group.items.push(item);
    }

    /* ----------------------------------------------- dropdown interactivity --
     * Two kinds of dropdown reach this point, and both end up expressed the same
     * way — a host, a trigger and a menu sharing one id, which the writer turns
     * into a :focus-within toggle needing no JavaScript.
     *
     *   in-tree  — a closed menu revealed and captured during the walk, already
     *              carrying host/trigger/menu roles from resolveClosedMenus().
     *   adopted  — an open portal menu captured as a separate top-level
     *              selection, paired below. The writer synthesizes a host for it,
     *              since the export has no ancestor containing both.
     *
     * Ids are minted per capture, so two selections can both produce `dd1`.
     * Renumbering here is what keeps them distinct once merged — otherwise one
     * trigger would open another component's menu.
     */
    let ddSeq = 0;
    const visitNodes = (node, fn) => {
      if (!node) return;
      fn(node);
      for (const child of node.ch || []) visitNodes(child, fn);
    };
    for (const item of work) {
      const remap = new Map();
      visitNodes(item.node, (node) => {
        if (!node.ddId) return;
        if (!remap.has(node.ddId)) remap.set(node.ddId, 'dd' + (ddSeq += 1));
        node.ddId = remap.get(node.ddId);
      });
    }

    /**
     * Pair each adopted menu with the selection it was adopted from.
     *
     * Assigned before normalizePosition so a dd menu keeps `absolute` and is
     * anchored under its trigger rather than being pushed into normal flow.
     */
    for (let i = 0; i < work.length; i += 1) {
      const item = work[i];
      const diag = item.sel && item.sel.diag;
      if (!diag || !diag.adopted || !item.node) continue;

      // Prefer the recorded trigger; fall back to the nearest earlier non-adopted
      // selection for payloads captured before adoptedFrom existed.
      const from = item.sel.adoptedFrom;
      let trigger = null;
      for (let j = i - 1; j >= 0; j -= 1) {
        const candidate = work[j];
        if (!candidate.node) continue;
        if (from && candidate.sel && candidate.sel.el === from) { trigger = candidate; break; }
        if (!from && !(candidate.sel && candidate.sel.diag && candidate.sel.diag.adopted)) {
          trigger = candidate;
          break;
        }
      }
      if (!trigger) continue;

      // This selection may already be the host of its own in-tree closed menu. That
      // wiring is complete and its descendants reference the id, so it wins; the
      // adopted menu still renders, just without a toggle of its own.
      if (trigger.node.ddId && trigger.node.ddRole !== 'trigger') continue;

      // One trigger can own more than one overlay (a menu plus its tooltip), so an
      // existing id is reused rather than overwritten — otherwise the first menu
      // would be left pointing at an id nothing else shares.
      const id = trigger.node.ddId || 'dd' + (ddSeq += 1);
      trigger.node.ddId = id;
      trigger.node.ddRole = 'trigger';
      item.node.ddId = id;
      item.node.ddRole = 'menu';
    }

    const nodes = [];
    let wrapped = 0;
    for (const group of groups) {
      const children = group.items.map((item) => item.node).filter(Boolean);
      if (!children.length) continue;

      for (const item of group.items) {
        item.stylesRef = styles;
        normalizePosition(item);
      }

      if (group.layout) {
        const name = 'w' + (wSeq += 1);
        wrappers[name] = group.layout;
        wrapped += children.length;
        for (const item of group.items) item.sel.diag.wrapped = true;
        nodes.push({ k: 'e', tag: 'div', attrs: {}, cls: [name], ch: children });
      } else {
        for (const child of children) nodes.push(child);
      }
    }

    return { styles, pseudos, wrappers, hovers, nodes, wrapped };
  }

  /**
   * An absolute/fixed selection with no positioned ancestor in the export would
   * render pinned to the corner of <body>. Neutralize the offsets; drop a
   * percentage translate too, since it was centring against that missing
   * ancestor and would otherwise push the component out of view.
   */
  const POSITION_NEUTRAL = {
    position: 'relative', top: 'auto', right: 'auto', bottom: 'auto', left: 'auto',
    'z-index': 'auto'
  };

  /**
   * An absolute/fixed selection with no positioned ancestor in the export would
   * render pinned to the corner of <body>. Neutralize the offsets.
   *
   * Written as an INLINE override rather than into the style set: by this point
   * the set may have become a shared .sN class that non-top-level nodes also
   * use, and un-pinning those would be wrong. Inline also wins the cascade
   * without any specificity games.
   */
  function normalizePosition(item) {
    const node = item.node;
    if (!node) return null;
    if (item.position !== 'absolute' && item.position !== 'fixed') return null;

    // A paired dropdown menu is the one case where absolute positioning is what we
    // want: it hangs off the synthetic wrapper, directly under its trigger.
    // Neutralizing it here would drop the menu into normal flow, where it stops
    // reading as a dropdown at all.
    if (node.ddRole === 'menu') {
      node.inline = Object.assign({}, node.inline, {
        position: 'absolute', top: '100%', left: '0', right: 'auto', bottom: 'auto'
      });
      item.sel.diag.positionNormalized = true;
      return null;
    }

    item.sel.diag.positionNormalized = true;
    node.inline = Object.assign({}, node.inline, POSITION_NEUTRAL);

    // A percentage translate was centring against the ancestor that is no longer
    // here, so leaving it in place shifts the component clean out of view.
    const transform = (node.inline && node.inline.transform) ||
      (node.sClass && styleOf(item, node.sClass, 'transform'));
    if (transform && /-?\d+(?:\.\d+)?%/.test(transform)) node.inline.transform = 'none';

    return null;
  }

  // Only used by normalizePosition, to peek at a value that has already moved
  // into the shared table.
  function styleOf(item, className, prop) {
    const table = item.stylesRef;
    return table && table[className] ? table[className][prop] : null;
  }

  /* ======================================================================== *
   * SECTION: selection management
   * ======================================================================== */

  function describeSelection(el, raw) {
    const rect = raw.rect;
    return {
      tag: tagOf(el),
      classes: labelClasses(el).join('.'),
      w: Math.round(rect.width),
      h: Math.round(rect.height),
      x: Math.round(rect.left + window.scrollX),
      y: Math.round(rect.top + window.scrollY),
      dropped: raw.diag.dropped,
      nodes: raw.diag.nodes,
      wrapped: false
    };
  }

  /**
   * Capture is async now (it yields so progress can be shown), so overlapping
   * gestures have to be rejected rather than interleaved — two walks writing to
   * state.selections at once would produce a half-built selection set.
   */
  /* ======================================================================== *
   * SECTION: attached overlays (portal-rendered menus)
   *
   * A modern dropdown does not put its menu inside the trigger. React, Radix, MUI
   * and friends render it through a PORTAL — appended to <body> and positioned
   * over the trigger — so the menu is not a descendant of anything you would think
   * to select. Capturing the trigger's subtree therefore captures no menu, which
   * is why open dropdowns still came out empty.
   *
   * So the capture has to look outside the selection, and it does that in three
   * ways, most reliable first: explicit ARIA wiring, the native popover registry,
   * and finally geometry.
   * ======================================================================== */

  // Explicit wiring, most precise first. `aria-describedby` catches tooltips and
  // help bubbles, which are the same problem in a smaller costume.
  const REFERENCE_ATTRS = ['aria-controls', 'aria-owns', 'popovertarget', 'aria-describedby'];

  const FLOATING_SELECTOR = [
    '[role="menu"]', '[role="listbox"]', '[role="dialog"]', '[role="tooltip"]',
    '[role="grid"]', '[role="tree"]', '[data-radix-popper-content-wrapper]',
    '[class*="dropdown"]', '[class*="menu"]', '[class*="popover"]', '[class*="popper"]',
    '[class*="autocomplete"]', '[class*="combobox"]', '[class*="tooltip"]', '[class*="flyout"]'
  ].join(',');

  // Names that mark a floating layer, used as a cheap prefilter on mutations —
  // running a big selector against every mutation on a busy app would cost more
  // than the feature is worth.
  const LAYER_HINT_RE = /(tooltip|popover|popper|flyout|dropdown|overlay|hovercard|hover-card|\bmenu\b|\btip\b|hint)/i;

  // How recently a layer must have appeared to count as "this hover produced it".
  const APPEARED_WINDOW_MS = 6000;
  const APPEARED_MAX = 240;          // a cap, so a chatty page cannot grow this forever

  // Landmarks are page furniture. A tooltip is never one, and adopting one would
  // drag a header or a whole app shell into the capture.
  const LANDMARK_SELECTOR = 'header,nav,main,footer,aside,[role="banner"],[role="navigation"],[role="main"],[role="contentinfo"]';

  function looksLikeLayer(el) {
    if (!el || el.nodeType !== 1 || isOurs(el)) return false;
    // Portals are appended at the top of the document, which is the single most
    // reliable structural signal and costs nothing to test.
    if (el.parentElement === document.body || el.parentElement === document.documentElement) return true;
    const role = (el.getAttribute && el.getAttribute('role')) || '';
    if (role === 'tooltip' || role === 'menu' || role === 'listbox' || role === 'dialog') return true;
    if (el.hasAttribute && el.hasAttribute('popover')) return true;
    const hints = ((el.getAttribute && el.getAttribute('class')) || '') + ' ' +
      ((el.getAttribute && el.getAttribute('data-testid')) || '') + ' ' + (el.id || '');
    return LAYER_HINT_RE.test(hints);
  }

  function noteAppeared(el) {
    if (!looksLikeLayer(el)) return;
    if (state.appeared.size >= APPEARED_MAX) {
      // Drop the oldest; Map preserves insertion order.
      const oldest = state.appeared.keys().next();
      if (!oldest.done) state.appeared.delete(oldest.value);
    }
    state.appeared.set(el, now());
  }

  /**
   * Watch for floating layers appearing, so a hover tooltip can be captured.
   *
   * A chart tooltip is the case this exists for: it is portal-rendered next to the
   * cursor, carries no ARIA relationship to the thing you are hovering, and its
   * trigger has no aria-expanded — so explicit wiring finds nothing and the
   * open-trigger gate keeps geometry from even running. "It appeared while I was
   * hovering here" is the only real evidence available, so it is recorded.
   *
   * Deliberately cheap: attribute filter is narrow, and every candidate goes
   * through a string test rather than a selector match.
   */
  function startAppearanceWatch() {
    if (state.appearedObserver || typeof MutationObserver !== 'function') return;
    try {
      const observer = new MutationObserver((records) => {
        for (const record of records) {
          if (record.type === 'childList') {
            for (const node of record.addedNodes) noteAppeared(node);
          } else if (record.target) {
            noteAppeared(record.target);
          }
        }
      });
      observer.observe(document, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['style', 'class', 'hidden', 'aria-hidden', 'data-state', 'open', 'popover']
      });
      state.appearedObserver = observer;
    } catch (_) { state.appearedObserver = null; }
  }

  function stopAppearanceWatch() {
    if (state.appearedObserver) {
      try { state.appearedObserver.disconnect(); } catch (_) { /* noop */ }
    }
    state.appearedObserver = null;
    state.appeared = new Map();
  }

  /**
   * Is this layer plausibly the tooltip or card for what we are capturing?
   *
   * Positioned, not page furniture, and either sitting near the pointer or
   * overlapping the thing being captured — which is how tooltips are placed.
   */
  function layerBelongsToHover(el, candidate) {
    if (!isPositionedLayer(candidate)) return false;
    if (!overlayIsPlausible(el, candidate, false)) return false;
    try {
      if (candidate.matches(LANDMARK_SELECTOR) || candidate.querySelector(LANDMARK_SELECTOR)) return false;
    } catch (_) { /* noop */ }

    const rect = rectOf(candidate);
    const point = state.pointer || { x: -1, y: -1 };
    if (point.x >= 0) {
      const margin = 32;
      const nearPointer = point.x >= rect.left - margin && point.x <= rect.right + margin &&
        point.y >= rect.top - margin && point.y <= rect.bottom + margin;
      if (nearPointer) return true;
    }

    // Anchored to the element, or to one of its containers.
    //
    // A sidebar mega-menu is the case that forces the ancestor walk: the link you
    // hover is narrow and indented, and the panel opens beside the RAIL, so it can
    // sit 200px+ away from the link and nowhere near the pointer. Measured against
    // the link alone it looks unrelated; measured against the rail it is obviously
    // its flyout.
    //
    // Climbing is capped by SIZE rather than by depth, because a page-sized ancestor
    // is adjacent to everything and would let any stray layer through.
    let anchor = el;
    for (let depth = 0; depth < 5 && anchor && anchor.nodeType === 1; depth += 1) {
      const host = rectOf(anchor);
      if (areaOf(host) > vw() * vh() * 0.6) break;
      if (overlapsOrAdjoins(host, rect)) return true;
      anchor = parentOrHost(anchor);
    }
    return false;
  }

  /**
   * Do these two boxes overlap, or sit next to each other with only a hairline gap?
   *
   * Both orientations matter: a dropdown opens below its trigger (horizontal overlap,
   * small vertical gap) and a flyout opens beside its rail (vertical overlap, small
   * horizontal gap). Only ever asked about a layer that already passed the recency
   * and plausibility checks, so the tolerance can be generous.
   */
  function overlapsOrAdjoins(host, rect, tolerance) {
    const gap = tolerance == null ? 28 : tolerance;
    const overlapX = Math.min(rect.right, host.right) - Math.max(rect.left, host.left);
    const overlapY = Math.min(rect.bottom, host.bottom) - Math.max(rect.top, host.top);
    if (overlapX > 0 && overlapY > 0) return true;
    if (overlapY > 0) {
      const sideGap = rect.left >= host.right ? rect.left - host.right : host.left - rect.right;
      if (sideGap >= -2 && sideGap <= gap) return true;
    }
    if (overlapX > 0) {
      const stackGap = rect.top >= host.bottom ? rect.top - host.bottom : host.top - rect.bottom;
      if (stackGap >= -2 && stackGap <= gap) return true;
    }
    return false;
  }

  /** Does the selection contain something that is currently open? */
  function hasOpenTrigger(el) {
    if (!el || el.nodeType !== 1) return false;
    const check = (node) => {
      if (!node.getAttribute) return false;
      if (node.getAttribute('aria-expanded') === 'true') return true;
      if (node.hasAttribute('aria-haspopup') && node.getAttribute('aria-expanded') !== 'false') return true;
      return tagOf(node) === 'details' && node.hasAttribute('open');
    };
    if (check(el)) return true;
    try {
      for (const node of el.querySelectorAll('[aria-expanded],[aria-haspopup],details[open]')) {
        if (check(node)) return true;
      }
    } catch (_) { /* noop */ }
    return false;
  }

  function overlayIsPlausible(el, candidate, explicit) {
    if (!candidate || candidate.nodeType !== 1 || isOurs(candidate)) return false;
    if (candidate === el || el.contains(candidate) || candidate.contains(el)) return false;

    let cs;
    try { cs = getComputedStyle(candidate); } catch (_) { return false; }
    if (!isVisible(candidate, cs)) return false;

    const rect = rectOf(candidate);
    if (rect.width < 8 || rect.height < 8) return false;

    // A layer covering most of the viewport is a modal or a backdrop rather than
    // this control's menu, and adopting it would drag half the page along. When the
    // component told us explicitly which element it controls, a dialog-sized layer
    // is a legitimate answer, so the ceiling is higher.
    const ceiling = explicit ? 0.9 : 0.6;
    if (areaOf(rect) > vw() * vh() * ceiling) return false;
    return true;
  }

  function isPositionedLayer(candidate) {
    try {
      const position = getComputedStyle(candidate).position;
      return position === 'absolute' || position === 'fixed';
    } catch (_) { return false; }
  }

  /** document plus every shadow root we know about — portals hide in both. */
  function overlayScopes() {
    const scopes = [document];
    for (const root of state.shadowRoots) scopes.push(root);
    return scopes;
  }

  function queryAllScopes(selector) {
    const out = [];
    for (const scope of overlayScopes()) {
      try {
        for (const node of scope.querySelectorAll(selector)) out.push(node);
      } catch (_) { /* a bad selector in one scope must not stop the rest */ }
    }
    return out;
  }

  /** Is this floating layer anchored to the selection, i.e. does it belong to it? */
  function overlayIsAnchoredTo(el, candidate) {
    let cs;
    try { cs = getComputedStyle(candidate); } catch (_) { return false; }
    if (cs.position !== 'absolute' && cs.position !== 'fixed') return false;

    const a = rectOf(el);
    const b = rectOf(candidate);

    // Horizontal overlap, and vertically adjacent (menus open just below or above
    // their trigger) or directly on top of it.
    const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    if (overlapX < Math.min(a.width, b.width) * 0.25) return false;

    const gapBelow = b.top - a.bottom;
    const gapAbove = a.top - b.bottom;
    const overlaps = b.top < a.bottom && b.bottom > a.top;
    return overlaps || (gapBelow >= -4 && gapBelow <= 32) || (gapAbove >= -4 && gapAbove <= 32);
  }

  /**
   * Everything currently open that belongs to this selection.
   * Read-only: nothing is clicked, nothing on the page is altered.
   */
  const MAX_ADOPTED = 4;

  function isHiddenNow(el) {
    let cs;
    try { cs = getComputedStyle(el); } catch (_) { return true; }
    return cs.display === 'none' || cs.visibility === 'hidden';
  }

  /**
   * Briefly reveal a closed menu so it can be captured, and hand back a function
   * that puts the page back exactly as it was.
   *
   * A closed dropdown is `display:none`, and a `display:none` subtree has no
   * geometry at all — every rect reads 0x0, so icons inside menu rows would export
   * as zero-sized holes and any rect-derived sizing would be wrong. Reading it
   * while it is laid out is the only way to capture it faithfully.
   *
   * This is the one place the extension touches the page's own elements, so it is
   * deliberately narrow: it changes only the declarations that do the hiding, fires
   * no events (unlike synthetic clicks, which can submit forms or navigate), and
   * restores in a `finally`. The menu may flash visible for a few milliseconds.
   *
   * Returns null when the element cannot be revealed, in which case nothing was
   * changed and the caller should fall back to dropping it.
   */
  function revealTemporarily(el) {
    const style = el.style;
    const undo = [];

    const saveInline = (prop) => {
      undo.push({
        kind: 'inline', prop,
        value: style.getPropertyValue(prop),
        priority: style.getPropertyPriority(prop)
      });
    };
    const restore = () => {
      // Reverse order, so a class re-added after its own removal cannot be undone
      // by an earlier step.
      for (let i = undo.length - 1; i >= 0; i -= 1) {
        const step = undo[i];
        if (step.kind === 'inline') {
          style.removeProperty(step.prop);
          if (step.value) style.setProperty(step.prop, step.value, step.priority);
        } else if (step.kind === 'attr') {
          el.setAttribute('hidden', step.value == null ? '' : step.value);
        } else if (step.kind === 'class') {
          el.classList.add(step.cls);
        }
      }
    };

    try {
      // 1. The hidden attribute, and inline hiding declarations. Between them these
      //    cover how most libraries actually close a menu.
      if (el.hasAttribute('hidden')) {
        undo.push({ kind: 'attr', value: el.getAttribute('hidden') });
        el.removeAttribute('hidden');
      }
      for (const prop of ['display', 'visibility', 'opacity']) {
        if (style.getPropertyValue(prop)) { saveInline(prop); style.removeProperty(prop); }
      }
      if (!isHiddenNow(el)) return restore;

      // 2. Hidden by a stylesheet rule instead. Removing the class that does it lets
      //    the real cascade produce the menu's true open layout — better than forcing
      //    a value, which would flatten a flex menu to a block. State-looking class
      //    names are tried first so we strip `is-collapsed` rather than `.menu`.
      const classes = Array.from(el.classList);
      const ordered = classes.filter((c) => STATE_CLASS_RE.test(c))
        .concat(classes.filter((c) => !STATE_CLASS_RE.test(c)));
      for (const cls of ordered) {
        el.classList.remove(cls);
        if (!isHiddenNow(el)) { undo.push({ kind: 'class', cls }); return restore; }
        el.classList.add(cls);
      }

      // 3. Last resort: force it open. `block` rather than a guess at the author's
      //    intent — a vertical menu of rows still stacks correctly, it just loses
      //    any flex gap.
      saveInline('display'); saveInline('visibility'); saveInline('opacity');
      style.setProperty('display', 'block', 'important');
      style.setProperty('visibility', 'visible', 'important');
      style.setProperty('opacity', '1', 'important');
      if (!isHiddenNow(el)) return restore;

      restore();
      return null;
    } catch (_) {
      try { restore(); } catch (_e) { /* noop */ }
      return null;
    }
  }

  /**
   * The element you would click to open this menu.
   *
   * Explicit ARIA wiring first, then the menu naming its own trigger, then document
   * order — a menu's trigger is almost always a preceding sibling, or inside one.
   */
  function findMenuTrigger(menuEl, rootEl) {
    const root = rootEl && rootEl.nodeType === 1 ? rootEl : document.documentElement;
    const escape = (value) => (window.CSS && CSS.escape ? CSS.escape(value) : value.replace(/["\\]/g, ''));
    const usable = (el) => el && el !== menuEl && !menuEl.contains(el) && root.contains(el);

    // 1. Something points at this menu.
    if (menuEl.id) {
      const safe = escape(menuEl.id);
      const selector = REFERENCE_ATTRS.map((attr) => '[' + attr + '~="' + safe + '"]').join(',');
      try {
        for (const candidate of root.querySelectorAll(selector)) {
          if (usable(candidate)) return candidate;
        }
        if (root.matches && root.matches(selector) && usable(root)) return root;
      } catch (_) { /* malformed id */ }
    }

    // 2. The menu points at its trigger.
    for (const attr of ['aria-labelledby', 'aria-owns', 'aria-activedescendant']) {
      const value = menuEl.getAttribute && menuEl.getAttribute(attr);
      if (!value) continue;
      for (const id of value.split(/\s+/)) {
        if (!id) continue;
        const target = findById(id, menuEl);
        if (usable(target)) return target;
      }
    }

    // 3. Document order: the nearest preceding sibling that is, or contains, a
    //    trigger — walking up a level at a time for menus nested deeper than the
    //    trigger, which is common once a library wraps things in layout divs.
    const triggerIn = (el) => {
      if (!el || el.nodeType !== 1 || menuEl.contains(el)) return null;
      try {
        if (el.matches(TRIGGER_SELECTOR)) return el;
        const inner = el.querySelector(TRIGGER_SELECTOR);
        if (inner && !menuEl.contains(inner)) return inner;
      } catch (_) { /* noop */ }
      return null;
    };

    let current = menuEl;
    for (let depth = 0; depth < 4 && current && current !== root.parentElement; depth += 1) {
      for (let sib = current.previousElementSibling; sib; sib = sib.previousElementSibling) {
        const found = triggerIn(sib);
        if (usable(found)) return found;
      }
      const parent = current.parentElement;
      if (!parent) break;
      // The parent itself may be the trigger (a clickable wrapper).
      if (parent !== root && triggerIn(parent) === parent && usable(parent)) return parent;
      current = parent;
      if (current === root) break;
    }

    return null;
  }

  /**
   * True when this floating layer already declares a relationship with some trigger
   * outside the selection.
   *
   * Geometry alone cannot tell two dropdowns apart when they happen to sit near
   * each other — on a filter bar with several menus, or wherever a second menu
   * renders close to the first. If the layer names its own trigger (or a trigger
   * elsewhere names the layer), that beats proximity: it belongs to that one, and
   * adopting it here would staple a stranger's menu onto this capture.
   *
   * Only consulted for the geometry pass. Explicit wiring is handled earlier and
   * is always trusted.
   */
  function ownedByAnotherTrigger(el, candidate) {
    if (!candidate || !candidate.getAttribute) return false;

    // Forward: the layer points back at its own trigger.
    for (const attr of ['aria-labelledby', 'aria-owns', 'aria-controls']) {
      const value = candidate.getAttribute(attr);
      if (!value) continue;
      for (const id of value.split(/\s+/)) {
        if (!id) continue;
        const target = findById(id, candidate);
        // A layer pointing into the selection is ours; one pointing anywhere else
        // is not. A dangling id proves nothing either way.
        if (target && target !== el && !el.contains(target) && !target.contains(el)) return true;
      }
    }

    // Reverse: some other trigger on the page points at this layer.
    if (candidate.id) {
      const escape = (value) => (window.CSS && CSS.escape ? CSS.escape(value) : value.replace(/["\\]/g, ''));
      const safe = escape(candidate.id);
      const selector = REFERENCE_ATTRS.map((attr) => '[' + attr + '~="' + safe + '"]').join(',');
      let owners = [];
      try { owners = queryAllScopes(selector); } catch (_) { owners = []; }
      for (const owner of owners) {
        if (owner !== el && !el.contains(owner) && !owner.contains(el)) return true;
      }
    }

    return false;
  }

  function findAttachedOverlays(el) {
    const found = [];
    const seen = new Set();
    const add = (candidate, why, explicit) => {
      if (!candidate || seen.has(candidate) || found.length >= MAX_ADOPTED) return;
      if (!overlayIsPlausible(el, candidate, explicit)) return;
      seen.add(candidate);
      found.push({ el: candidate, why });
    };

    // 1. Explicit wiring. When a component says which element it controls, that is
    //    an exact answer and no geometry is needed.
    const triggers = [el];
    try {
      for (const node of el.querySelectorAll('[aria-controls],[aria-owns],[popovertarget]')) {
        triggers.push(node);
      }
    } catch (_) { /* noop */ }

    for (const trigger of triggers) {
      if (!trigger.getAttribute) continue;
      for (const attr of REFERENCE_ATTRS) {
        const value = trigger.getAttribute(attr);
        if (!value) continue;
        for (const id of value.split(/\s+/)) {
          if (id) add(findById(id, trigger), attr, true);
        }
      }
    }

    // 2. Reverse wiring. Plenty of libraries do it the other way round — the menu
    //    carries aria-labelledby pointing back at its trigger, and the trigger says
    //    nothing. Restricted to positioned layers so this finds popovers rather than
    //    ordinary page text that happens to reference the selection.
    const ids = [];
    if (el.id) ids.push(el.id);
    try {
      for (const node of el.querySelectorAll('[id]')) {
        if (node.id) ids.push(node.id);
        if (ids.length >= 30) break;
      }
    } catch (_) { /* noop */ }

    if (ids.length) {
      const escape = (value) => (window.CSS && CSS.escape ? CSS.escape(value) : value.replace(/["\\]/g, ''));
      const selector = ids.map((id) => {
        const safe = escape(id);
        return '[aria-labelledby~="' + safe + '"],[aria-controls~="' + safe + '"],' +
               '[aria-describedby~="' + safe + '"]';
      }).join(',');
      for (const candidate of queryAllScopes(selector)) {
        if (seen.has(candidate) || !isPositionedLayer(candidate)) continue;
        add(candidate, 'reverse-aria', true);
      }
    }

    // 3. Native popovers that are actually showing.
    for (const pop of queryAllScopes('[popover]')) {
      let open = false;
      try { open = pop.matches(':popover-open'); } catch (_) { open = false; }
      if (open) add(pop, 'popover', true);
    }

    // 4. MODAL dialogs only. showModal() promotes a dialog to the top layer, where
    //    it is genuinely detached from whatever opened it. A plain <dialog open> sits
    //    in normal flow and is captured the ordinary way if it is inside the
    //    selection — adopting those would attach a stray dialog to every capture on
    //    the page.
    for (const dialog of queryAllScopes('dialog[open]')) {
      let modal = false;
      try { modal = dialog.matches(':modal'); } catch (_) { modal = false; }
      if (modal) add(dialog, 'modal', true);
    }

    // 5. Layers that APPEARED while we were pointing here. This is the hover
    //    tooltip case: a chart tile's card is portal-rendered next to the cursor
    //    with no ARIA relationship to the tile and no aria-expanded anywhere, so
    //    every signal above finds nothing. Recency plus placement is the evidence.
    // Only meaningful if a hover is actually being tracked: this pass attributes a
    // layer to "the thing I am pointing at", and with no pointer there is nothing to
    // attribute it to. Without this guard the window falls back to wall-clock time
    // and everything the page built at load qualifies.
    if (state.hoverStamp > 0) {
      // Must have appeared since this hover began, and within the outer window. The
      // first keeps page furniture out; the second stops a stale entry qualifying
      // after you have wandered away and come back.
      const cutoff = Math.max(now() - APPEARED_WINDOW_MS, state.hoverStamp - 150);
      for (const [candidate, stamp] of state.appeared) {
        if (stamp < cutoff) continue;
        if (seen.has(candidate) || !candidate.isConnected) continue;
        if (!layerBelongsToHover(el, candidate)) continue;
        add(candidate, 'appeared on hover', false);
      }
    }

    // 6. Still nothing, but a floating layer is sitting right under the pointer.
    //    Covers a tooltip that was already in the DOM and merely revealed by CSS,
    //    where there is no mutation to observe at all.
    if (!found.length && state.pointer.x >= 0) {
      for (const candidate of queryAllScopes(FLOATING_SELECTOR)) {
        if (seen.has(candidate)) continue;
        if (ownedByAnotherTrigger(el, candidate)) continue;
        if (layerBelongsToHover(el, candidate)) add(candidate, 'under the pointer', false);
      }
    }

    // 7. Geometry, last and least trusted, and only when the selection actually has
    //    something open — otherwise every floating tooltip on the page qualifies.
    if (hasOpenTrigger(el)) {
      for (const candidate of queryAllScopes(FLOATING_SELECTOR)) {
        if (seen.has(candidate)) continue;
        if (ownedByAnotherTrigger(el, candidate)) continue;
        if (overlayIsPlausible(el, candidate, false) && overlayIsAnchoredTo(el, candidate)) {
          add(candidate, 'anchored', false);
        }
      }
    }

    return found;
  }

  async function addSelection(el, replace, options) {
    if (!el) return;
    if (state.capturing) return;

    if (replace) state.selections = [];

    const existing = state.selections.findIndex((s) => s.el === el);
    if (existing !== -1) {                      // clicking a selected element deselects it
      state.selections.splice(existing, 1);
      renderSelection();
      return;
    }

    // Selecting an ancestor of an existing selection subsumes it.
    state.selections = state.selections.filter((s) => !el.contains(s.el));
    if (state.selections.some((s) => s.el.contains(el))) {
      toast('Already inside a selection');
      return;
    }

    state.capturing = true;
    let raw;
    try {
      const label = 'Extracting ' + tagOf(el) + (labelClasses(el).length ? '.' + labelClasses(el)[0] : '');
      // Only announce progress once the walk is big enough to be worth a panel;
      // a small component finishes before the first yield and shows nothing.
      raw = await captureRaw(el, {
        onProgress: (fraction) => showProgress(label, Math.min(fraction, 0.99))
      });
    } catch (error) {
      toast('Capture failed: ' + (error && error.message));
      return;
    } finally {
      state.capturing = false;
      hideProgress();
    }

    if (!raw || !raw.node) { toast('Nothing capturable there'); return; }

    const diag = describeSelection(el, raw);
    state.selections.push({ el, raw, diag });
    renderSelection();

    // Alt means "exactly this element", so it must not quietly bring a panel along.
    if (!(options && options.noAdopt)) await adoptAttachedOverlays(el);
  }

  /**
   * Pull in any open portal-rendered menu belonging to this selection.
   *
   * Added as ordinary extra selections rather than grafted into the trigger's tree:
   * they get the same capture, the same position normalization (so an absolutely
   * positioned menu lands in flow under its trigger instead of pinned to a corner
   * of <body>) and their own diagnostics row, which is what makes it visible that
   * adoption happened at all.
   */
  async function adoptAttachedOverlays(el) {
    let overlays;
    try { overlays = findAttachedOverlays(el); } catch (_) { return; }
    if (!overlays.length) return;

    for (const overlay of overlays) {
      if (state.selections.some((s) => s.el === overlay.el ||
          s.el.contains(overlay.el) || overlay.el.contains(s.el))) continue;
      if (state.capturing) break;

      state.capturing = true;
      let raw = null;
      try {
        raw = await captureRaw(overlay.el, {
          onProgress: (fraction) => showProgress('Extracting attached menu', Math.min(fraction, 0.99))
        });
      } catch (_) {
        raw = null;
      } finally {
        state.capturing = false;
        hideProgress();
      }

      if (!raw || !raw.node) continue;
      const diag = describeSelection(overlay.el, raw);
      diag.adopted = overlay.why;
      // Recorded explicitly so the export can pair this menu with its trigger by
      // identity. Adjacency in the selection list happens to hold today, but that
      // is an accident of when adoption runs, not something to depend on.
      state.selections.push({ el: overlay.el, raw, diag, adoptedFrom: el });
      toast('Also captured the attached menu (' + overlay.why + ')');
    }
    renderSelection();
  }

  function replaceSelection(el) { return addSelection(el, true); }

  function clearSelection() {
    state.selections = [];
    renderSelection();
  }

  /* ======================================================================== *
   * SECTION: payload assembly
   * ======================================================================== */

  function buildPayload() {
    if (!state.selections.length) return null;

    const finalized = finalize(state.selections);

    // Merge per-selection font registries.
    const registry = makeFontRegistry();
    for (const sel of state.selections) {
      for (const [key, entry] of sel.raw.registry.families) {
        let target = registry.families.get(key);
        if (!target) {
          target = { family: entry.family, weights: new Set(), italics: new Set(), chars: 0, icon: false };
          registry.families.set(key, target);
        }
        entry.weights.forEach((w) => target.weights.add(w));
        entry.italics.forEach((i) => target.italics.add(i));
        target.chars += entry.chars;
        target.icon = target.icon || entry.icon;
      }
      sel.raw.registry.icons.forEach((i) => registry.icons.add(i));
    }

    const picked = pickFontFaces(registry);
    const fontFaces = picked.bundle;
    const bundled = new Set(fontFaces.map((f) => f.family.toLowerCase()));
    const fonts = buildFontPlan(registry, bundled, picked.googleHosted);

    const diag = {
      topLevel: state.selections.length,
      wraps: finalized.wrapped,
      dropped: 0,
      hiddenDropped: 0,
      machineryDropped: 0,
      canvasPlaceholders: 0,
      imagesDropped: 0,
      imagesInlined: 0,
      imagesTainted: 0,
      svgDropped: 0,
      iconNodes: 0,
      iconsRasterized: 0,
      iconsLost: 0,
      pixelsRecovered: 0,
      pixelsFailed: 0,
      hiddenMenus: 0,
      closedMenusWired: 0,
      framesInlined: 0,
      framesPixels: 0,
      nativeSelects: 0,
      nodes: 0,
      styleCount: Object.keys(finalized.styles).length,
      pseudoCount: Object.keys(finalized.pseudos).length,
      hoverCount: finalized.hovers.length,
      wrapperCount: Object.keys(finalized.wrappers).length,
      adoptedOverlays: state.selections.filter((s) => s.diag && s.diag.adopted).length,
      selections: state.selections.map((s) => s.diag),
      frames: 1
    };
    diag.iconFamilies = {};
    for (const sel of state.selections) {
      for (const key of Object.keys(sel.raw.diag)) {
        if (typeof diag[key] === 'number') diag[key] += sel.raw.diag[key];
      }
      const families = sel.raw.diag.iconFamilies || {};
      for (const key of Object.keys(families)) {
        diag.iconFamilies[key] = (diag.iconFamilies[key] || 0) + families[key];
      }
    }

    return {
      url: location.href,
      title: document.title || '',
      frameUrl: location.href,
      isFrame: window.top !== window,
      viewport: { w: vw(), h: vh() },
      // So the export sits on the same surface the original did, instead of a
      // guessed white that turns a dark component invisible.
      pageBackground: document.body ? cleanValue('background-color', effectiveBackground(document.body)) : '',
      styles: finalized.styles,
      pseudos: finalized.pseudos,
      wrappers: finalized.wrappers,
      hovers: finalized.hovers,
      nodes: finalized.nodes,
      fonts,
      fontFaces,
      diagnostics: diag
    };
  }

  /* ======================================================================== *
   * SECTION: shortcuts
   * ======================================================================== */

  function loadShortcuts() {
    return new Promise((resolve) => {
      try {
        chrome.storage.sync.get({ shortcuts: null }, (result) => {
          state.shortcuts = (result && result.shortcuts) || DEFAULT_SHORTCUTS;
          renderMode();                       // the hint names the grab key
          resolve(state.shortcuts);
        });
      } catch (_) {
        state.shortcuts = DEFAULT_SHORTCUTS;
        resolve(state.shortcuts);
      }
    });
  }

  function matchesShortcut(event, config) {
    if (!config || !config.key) return false;
    const primary = isMac ? event.metaKey : event.ctrlKey;
    if (!!config.primary !== !!primary) return false;
    if (!!config.shift !== !!event.shiftKey) return false;
    if (!!config.alt !== !!event.altKey) return false;
    const key = String(event.key || '');
    return key.toLowerCase() === String(config.key).toLowerCase();
  }

  /* ======================================================================== *
   * SECTION: activation + events
   * ======================================================================== */

  // The crosshair needs !important to beat page rules, which means it becomes a
  // real computed `cursor` value on every element. captureRaw() lifts it for the
  // duration of the walk (see withCursorSuppressed) so it never lands in output.
  let cursorStyleEl = null;

  function applyCursor() {
    if (cursorStyleEl) return;
    const style = document.createElement('style');
    style.className = PREFIX + 'style';
    style.setAttribute('data-cheater', 'cursor');
    style.textContent = '*{cursor:crosshair !important}';
    (document.head || document.documentElement).appendChild(style);
    cursorStyleEl = style;
  }

  function removeCursor() {
    if (cursorStyleEl && cursorStyleEl.parentNode) cursorStyleEl.parentNode.removeChild(cursorStyleEl);
    cursorStyleEl = null;
  }

  async function withCursorSuppressed(fn) {
    const wasApplied = !!cursorStyleEl;
    if (wasApplied) cursorStyleEl.disabled = true;
    try {
      return await fn();
    } finally {
      if (wasApplied && cursorStyleEl) cursorStyleEl.disabled = false;
    }
  }

  function activate() {
    if (state.active) { setPaused(false); return; }
    state.active = true;
    state.paused = false;
    state.styleSheetCache = null;
    state.frameDocs = new Set();
    startAppearanceWatch();
    buildUI();
    applyCursor();
    reportActiveState();
  }

  function deactivate() {
    state.active = false;
    state.paused = false;
    state.hovered = null;
    state.pointer = { x: -1, y: -1 };
    stopAppearanceWatch();
    clearSelection();
    teardownUI();
    destroyProbe();
    removeCursor();
    reportActiveState();
  }

  /**
   * Hand the page back without losing the selection.
   *
   * The overlay and the crosshair go away and every interception stops, so the
   * page behaves exactly as it normally would: menus open, tabs switch, popovers
   * appear. Selections made so far are kept, so you can pause, open a menu, resume
   * and add it to what you already had.
   */
  function setPaused(paused) {
    if (!state.active) return false;
    const next = !!paused;
    if (next === state.paused) return true;        // no spurious toasts
    state.paused = next;

    // The outline layers are hidden via a host class rather than by hiding the
    // host itself: the toast lives in the same shadow root, and hiding the host
    // would make the "Paused" message — the one thing you need to see — invisible.
    if (ui.host) ui.host.classList.toggle(PREFIX + 'paused', state.paused);

    if (state.paused) {
      // The outline stays: hover is how you aim the grab key. Only the crosshair
      // goes, since the page's own cursors should be visible while you use it.
      removeCursor();
      toast('Interact mode — the page has your clicks. Open a menu or hover it, then ' +
        shortcutLabel((state.shortcuts || DEFAULT_SHORTCUTS).grab) + ' captures what you are pointing at.');
    } else {
      applyCursor();
      renderSelection();
      toast('Select mode — clicks select again');
    }
    renderMode();
    reportActiveState();
    return true;
  }

  function reportActiveState() {
    try {
      chrome.runtime.sendMessage(
        { type: 'CHEATER_ACTIVE', active: state.active, paused: state.paused },
        () => { void chrome.runtime.lastError; }   // badge state only
      );
    } catch (_) { /* noop */ }
  }

  function onPointerMove(event) {
    // Deliberately still runs while interacting. This listener never intercepts
    // anything — it only reads — and the outline it draws is the only thing telling
    // you what the grab key would capture. Killing it in interact mode is what made
    // hover-revealed menus impossible to capture at all.
    if (!state.active) return;
    state.pointer = { x: event.clientX, y: event.clientY };
    avoidPointer(event.clientX, event.clientY);
    const target = hitTarget(event);

    if (!target) {
      // Over bare page background. Clear the outline rather than leaving a stale
      // one pointing at an element the cursor has already left — otherwise the
      // next click looks like it "didn't select what I was pointing at".
      if (state.hovered) { state.hovered = null; showHover(null); }
      return;
    }
    if (target === state.hovered) return;
    state.hovered = target;
    state.hoverStamp = now();

    // Deliberately does NOT re-anchor the navigation path when a selection
    // exists: Alt+Arrow walks the SELECTION, and nudging the mouse must not
    // silently move the thing the arrows are about to traverse.
    if (!state.selections.length) resetNav(target);

    showHover(target);
  }

  /**
   * Selection happens on pointerdown, not click.
   *
   * Many sites navigate, open a menu or tear down the node from their own
   * mousedown/pointerdown handler, so by the time a click event exists there is
   * nothing left to select — which reads exactly like "I clicked and nothing got
   * selected". Acting on pointerdown and swallowing the rest of the interaction
   * sequence takes the element before the page can react to it.
   */
  function onPointerDown(event) {
    if (!state.active || state.paused) return;
    if (event.button !== undefined && event.button !== 0) return;   // left button only

    const target = hitTarget(event);
    if (!target) return;

    event.preventDefault();
    event.stopPropagation();
    if (event.stopImmediatePropagation) event.stopImmediatePropagation();

    // Alt bypasses expansion entirely; Shift adds to the selection.
    const exact = event.altKey || event.shiftKey;
    const chosen = exact ? target : smartExpand(target);

    resetNav(chosen);
    addSelection(chosen, !event.shiftKey);
    showHover(chosen);
  }

  /**
   * Swallow the remainder of the interaction (mousedown/up, click, auxclick,
   * dblclick) so the page never sees a selection gesture as a real one — no
   * navigation, no menu opening, no focus change.
   */
  function swallowInteraction(event) {
    // While paused the page owns its own events — that is the entire point.
    if (!state.active || state.paused) return;
    const path = (event.composedPath && event.composedPath()) || [];
    for (const node of path) {
      if (node && node.nodeType === 1 && isOurs(node)) return;   // our own chrome
    }
    event.preventDefault();
    event.stopPropagation();
    if (event.stopImmediatePropagation) event.stopImmediatePropagation();
  }

  /**
   * Wheel: walk the tree, or scroll the page?
   *
   * Hijacking every wheel event makes the page unscrollable in selection mode,
   * so anything below the fold becomes unreachable — which itself presents as
   * "I can't select that". Tree-walking is therefore opt-in per gesture:
   *
   *   Alt+wheel                      -> walk (Alt is already the precision key)
   *   wheel over the current selection -> walk (you have committed to an element
   *                                       and are refining which one it is)
   *   anything else                  -> the page scrolls, untouched
   */
  function shouldWalkOnWheel(event) {
    if (event.altKey) return true;
    const target = state.hovered;
    if (!target || !state.selections.length) return false;
    return state.selections.some((sel) => sel.el === target || sel.el.contains(target));
  }

  function onWheel(event) {
    if (!state.active || state.paused || !state.hovered) return;
    if (!shouldWalkOnWheel(event)) return;              // let the page scroll
    event.preventDefault();
    event.stopPropagation();
    ensureNavAnchor(state.hovered);                     // wheel is hover-driven
    navTo(event.deltaY < 0 ? navUp() : navDown());
  }

  function onKeyDown(event) {
    const shortcuts = state.shortcuts || DEFAULT_SHORTCUTS;

    if (matchesShortcut(event, shortcuts.start)) {
      event.preventDefault();
      activate();
      toast('Selection mode — click an element');
      return;
    }
    if (matchesShortcut(event, shortcuts.export)) {
      event.preventDefault();
      requestExport();
      return;
    }
    // Checked before the active/paused guards below, since its whole job is to
    // toggle that state.
    if (matchesShortcut(event, shortcuts.pause)) {
      if (state.active) {
        event.preventDefault();
        event.stopPropagation();
        setPaused(!state.paused);
      }
      return;
    }
    // Grab: capture what the cursor is over, with no click at all.
    //
    // This is what makes a hover-revealed menu capturable. Such a menu closes the
    // instant the pointer leaves it, so any gesture involving the mouse — clicking
    // it, or reaching for a button — destroys the thing being captured. A key does
    // not move the pointer. Works in both modes, since it is strictly better than
    // clicking whenever the page reacts to clicks.
    if (matchesShortcut(event, shortcuts.diagnose)) {
      if (state.active) {
        event.preventDefault();
        event.stopPropagation();
        diagnose();
      }
      return;
    }
    if (matchesShortcut(event, shortcuts.grab)) {
      if (state.active) {
        event.preventDefault();
        event.stopPropagation();
        if (event.stopImmediatePropagation) event.stopImmediatePropagation();
        requestGrab(event.altKey);
      }
      return;
    }
    if (matchesShortcut(event, shortcuts.history)) {
      event.preventDefault();
      sendToWorker({ type: 'CHEATER_OPEN_HISTORY' }).then((result) => {
        if (result.error) toast('Could not open history: ' + result.error, true);
      });
      return;
    }
    if (matchesShortcut(event, shortcuts.fullpage)) {
      event.preventDefault();
      // Must await the capture before exporting, or the payload would be empty.
      selectBody().then((ok) => { if (ok) requestExport(); });
      return;
    }

    if (!state.active) return;

    // Paused means hands off entirely: no Escape, no arrows. Pages close menus on
    // Escape, and stealing it would shut the thing being captured.
    if (state.paused) return;

    // Escape is only swallowed while we are actually active with something to
    // clear — the page's own Escape handling is otherwise untouched.
    if (event.key === 'Escape') {
      if (state.selections.length || state.hovered) {
        event.preventDefault();
        event.stopPropagation();
        deactivate();
      }
      return;
    }

    // Alt+Arrow traverses the SELECTION's ancestors and children — not whatever
    // the mouse happens to be over. ensureNavAnchor keeps the back-stack, so
    // Alt+Up xN followed by Alt+Down xN returns exactly where it started.
    if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      const subject = navSubject();
      if (!subject) return;
      event.preventDefault();
      event.stopPropagation();
      ensureNavAnchor(subject);
      navTo(event.key === 'ArrowUp' ? navUp() : navDown());
    }
  }

  /**
   * Capture whatever the pointer is over right now.
   *
   * Uses smart expansion like a click does, so pointing at a menu row still gives
   * the menu. Alt held takes the exact node instead, matching Alt+Click.
   */
  /**
   * Ask every frame to grab, not just this one.
   *
   * The frame that receives the keystroke is the one with keyboard focus; the frame
   * that knows what the cursor is over is the one containing the cursor. Those are
   * different frames whenever the thing you are pointing at lives in an iframe,
   * which is how a charting widget is usually embedded. Broadcasting removes the
   * question entirely.
   */
  function requestGrab(exact) {
    // If this frame is itself hovering something, it is the right answer and there
    // is no reason to involve the worker.
    if (state.hovered) { grabHovered(exact); return; }

    sendToWorker({ type: 'CHEATER_CMD', cmd: 'grab', exact: !!exact }).then((result) => {
      if (result && result.grabbed) return;
      toast('Nothing under the cursor. Point at the thing you want — in Interact mode the ' +
        'outline shows what will be captured.');
    });
  }

  /**
   * Explain, in this frame, exactly what the extension can see right now.
   *
   * Every failure mode of hover capture looks identical from the outside — nothing
   * happens. This distinguishes them: is the pointer even being tracked, is the
   * layer in a closed shadow root or another frame, did it get rejected for size or
   * placement, is it a canvas with no DOM at all. Copied to the clipboard so it can
   * be pasted somewhere useful.
   */
  function diagnose() {
    const lines = [];
    const say = (label, value) => lines.push(label + ': ' + value);
    const describe = (el) => {
      if (!el) return 'none';
      const cls = labelClasses(el).slice(0, 3).join('.');
      const r = rectOf(el);
      return tagOf(el) + (el.id ? '#' + el.id : '') + (cls ? '.' + cls : '') +
        ' [' + Math.round(r.width) + 'x' + Math.round(r.height) + ' @ ' +
        Math.round(r.left) + ',' + Math.round(r.top) + ']';
    };

    say('cheater', (chrome.runtime.getManifest ? chrome.runtime.getManifest().version : '?') +
      (state.paused ? ' · interact mode' : ' · select mode'));
    say('frame', (window.top === window ? 'TOP' : 'SUBFRAME') + ' ' + location.href.slice(0, 120));
    say('pointer', state.pointer.x < 0 ? 'NEVER MOVED IN THIS FRAME' : state.pointer.x + ',' + state.pointer.y);
    say('hovered', describe(state.hovered));
    say('selections', state.selections.length);
    say('layers seen appearing', state.appeared.size);

    // Is the pointer over an iframe? Then this frame cannot see the hover at all and
    // the frame underneath is the one that matters.
    let under = null;
    try { under = document.elementFromPoint(state.pointer.x, state.pointer.y); } catch (_) { under = null; }
    say('element at pointer', describe(under));
    if (under && (tagOf(under) === 'iframe' || tagOf(under) === 'canvas')) {
      say('WARNING', tagOf(under) === 'canvas'
        ? 'the pointer is over a <canvas> — a canvas-drawn tooltip has no DOM at all and can only be recovered as pixels'
        : 'the pointer is over an <iframe> — that frame owns the hover; grab is broadcast so it should still answer');
    }

    // Every floating layer in this frame, with a verdict.
    const host = state.hovered || document.body;
    let candidates = [];
    try { candidates = Array.from(queryAllScopes(FLOATING_SELECTOR)); } catch (_) { candidates = []; }
    for (const [el] of state.appeared) if (candidates.indexOf(el) === -1) candidates.push(el);

    const verdictOf = (candidate) => {
      if (!candidate.isConnected) return 'detached';
      if (!isVisible(candidate)) return 'not visible';
      if (!isPositionedLayer(candidate)) return 'not positioned (absolute/fixed)';
      if (host.contains(candidate)) return 'inside the selection already';
      if (!overlayIsPlausible(host, candidate, false)) return 'rejected: too large, or too small';
      if (!layerBelongsToHover(host, candidate)) return 'rejected: not near the pointer or the element';
      return 'WOULD BE ADOPTED';
    };

    // Rank by how much the line tells you. A page has dozens of hidden menus and
    // exactly one interesting layer, and truncating the list at random order buries
    // the one you needed — which it did the first time this ran.
    const RANK = {
      'WOULD BE ADOPTED': 0,
      'rejected: not near the pointer or the element': 1,
      'rejected: too large, or too small': 2,
      'inside the selection already': 3,
      'not positioned (absolute/fixed)': 4,
      'not visible': 5,
      detached: 6
    };
    const judged = candidates
      .filter((candidate) => !isOurs(candidate))
      .map((candidate) => ({ candidate, verdict: verdictOf(candidate) }))
      .sort((a, b) => RANK[a.verdict] - RANK[b.verdict]);

    lines.push('');
    say('floating layers in this frame', judged.length);
    const boring = judged.filter((entry) => RANK[entry.verdict] >= 5).length;
    for (const entry of judged.slice(0, 12)) {
      lines.push('  ' + describe(entry.candidate) + ' -> ' + entry.verdict);
    }
    if (judged.length > 12) lines.push('  … ' + (judged.length - 12) + ' more');
    if (boring) say('(of those, hidden or detached)', boring);

    let adopted = [];
    try { adopted = findAttachedOverlays(host); } catch (error) { adopted = []; }
    lines.push('');
    say('adoption result', adopted.length
      ? adopted.map((a) => describe(a.el) + ' (' + a.why + ')').join('; ')
      : 'NOTHING ADOPTED');
    say('shadow roots known', state.shadowRoots.size);
    say('same-origin frames seen', state.frameDocs.size);

    const report = lines.join('\n');
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(report);
    } catch (_) { /* clipboard needs focus; the console copy below always works */ }
    // eslint-disable-next-line no-console
    console.log('%c[cheater diagnose]%c\n' + report, 'color:#FFB224;font-weight:700', 'color:inherit');
    toast('Diagnostic copied to the clipboard, and printed to the console (paste it somewhere useful).');
    return report;
  }

  const HOVER_WHYS = ['appeared on hover', 'under the pointer'];

  /**
   * Capture what the pointer produced, in preference to what it is resting on.
   *
   * You point at a nav link to make its flyout appear; the flyout is the thing you
   * want, and the link is just how you got there. So when a layer appeared for this
   * hover, that layer becomes the selection on its own rather than a second one
   * tacked onto the trigger.
   *
   * Hold Alt to take exactly what is under the cursor instead, matching Alt+Click.
   */
  async function grabHovered(exact) {
    if (!state.active) return false;
    const target = state.hovered;
    if (!target) {
      toast('Nothing under the cursor — point at something and the outline will show what gets captured.');
      return false;
    }

    if (!exact) {
      let layers = [];
      try { layers = findAttachedOverlays(target); } catch (_) { layers = []; }
      const appeared = layers.find((layer) => HOVER_WHYS.indexOf(layer.why) !== -1);
      if (appeared) {
        resetNav(appeared.el);
        await addSelection(appeared.el, true);
        showHover(appeared.el);
        toast('Captured the panel that appeared (' + appeared.why + '). ' +
          shortcutLabel((state.shortcuts || DEFAULT_SHORTCUTS).grab) +
          ' with Alt takes what is under the cursor instead.');
        return true;
      }
    }

    const chosen = exact ? target : smartExpand(target);
    resetNav(chosen);
    await addSelection(chosen, true, { noAdopt: !!exact });
    showHover(chosen);
    return true;
  }

  async function selectBody() {
    activate();
    if (!document.body) return false;
    state.selections = [];
    await addSelection(document.body, true);
    return state.selections.length > 0;
  }

  async function requestExport() {
    if (state.capturing) { toast('Still extracting…'); return; }

    // finalize() + serialization is pure CPU with no natural yield points, so the
    // phase is announced rather than measured. A frame is given up first so the
    // panel actually paints before the work starts.
    showProgress('Serializing capture', null);
    await nextTick();

    let payload = null;
    try {
      payload = buildPayload();
    } catch (error) {
      // Serializing the frozen tree should never throw, but if it does the user
      // needs the reason rather than a blank failure.
      hideProgress();
      reportFailure('Could not serialize the capture', error);
      return;
    }

    if (!payload) {
      hideProgress();
      // Another frame may hold the selection; let the worker poll them all.
      // This frame has nothing, but another frame might — let the worker poll.
      sendToWorker({ type: 'CHEATER_CMD', cmd: 'export' }).then((result) => {
        if (result.error) { reportFailure(result.error); return; }
        const value = result.value;
        if (!value || value.ok) return;
        toast(value.reason === 'empty' ? 'Nothing selected' : 'Export failed: ' + value.reason, true);
      });
      return;
    }

    // Fonts are fetched by the worker, which then opens the export tab; there is
    // no byte count to report from here, so this phase is indeterminate.
    showProgress('Fetching fonts and opening export', null);

    const response = await sendToWorker({ type: 'CHEATER_EXPORT', payload });
    hideProgress();

    if (response.error) { reportFailure(response.error, null, payload); return; }
    if (response.value && response.value.ok) { toast('Exported'); return; }
    if (response.value && response.value.reason === 'empty') { toast('Nothing selected', true); return; }
    reportFailure((response.value && response.value.reason) || 'the extension worker sent no response',
      null, payload);
  }

  /**
   * Send to the service worker, with one retry.
   *
   * An MV3 worker is torn down when idle, and the first message after that can be
   * rejected outright with "Could not establish connection" before Chrome finishes
   * waking it — an intermittent failure that looks exactly like a broken export.
   * One retry after a beat turns it into a non-event.
   *
   * Returns { value } or { error } rather than throwing, so callers cannot forget
   * to read chrome.runtime.lastError — which is the only place an oversized
   * message, a dead worker, or a value the structured clone cannot carry is
   * reported at all.
   */
  function sendToWorker(message, attempt) {
    const tries = attempt || 0;
    return new Promise((resolve) => {
      let done = false;
      const finish = (result) => { if (!done) { done = true; resolve(result); } };

      try {
        chrome.runtime.sendMessage(message, (value) => {
          const lastError = chrome.runtime.lastError;
          if (!lastError) { finish({ value }); return; }

          const transient = /establish connection|message port closed|Receiving end does not exist/i
            .test(lastError.message || '');
          if (transient && tries === 0) {
            setTimeout(() => { sendToWorker(message, 1).then(finish); }, 150);
            return;
          }
          finish({ error: lastError.message || 'messaging failed' });
        });
      } catch (error) {
        finish({ error: (error && error.message) || 'messaging threw' });
      }

      // A worker that never answers must not leave the caller hanging forever.
      setTimeout(() => finish({ error: 'the extension worker did not respond (timed out)' }), 30000);
    });
  }

  /**
   * Report a failure with enough detail to act on.
   *
   * The payload size is included because the likeliest cause of a large export
   * failing is the message itself: chrome.runtime.sendMessage carries the whole
   * capture, and a full page with inlined bitmaps can be tens of megabytes. The
   * console line survives the toast for copying into a bug report.
   */
  function reportFailure(reason, error, payload) {
    let detail = String(reason || 'unknown error');

    if (payload) {
      try {
        const bytes = JSON.stringify(payload).length;
        detail += ' · payload ' + (bytes > 1048576
          ? (bytes / 1048576).toFixed(1) + ' MB'
          : Math.round(bytes / 1024) + ' KB');
        if (bytes > 32 * 1024 * 1024) {
          detail += ' — the capture is very large; try selecting a smaller region';
        }
      } catch (_) {
        detail += ' · payload size unknown';
      }
    }

    // The console line is what gets copied into a bug report, so it carries the
    // same text as the toast plus the objects for inspection.
    console.error('[Cheater] export failed: ' + detail, error || '', payload ? { payload } : '');
    toast('Export failed: ' + detail, true);
  }

  /* ======================================================================== *
   * SECTION: message handling
   * ======================================================================== */

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') return false;

    switch (message.type) {
      case 'CHEATER_START':
        activate();
        sendResponse({ ok: true, frame: location.href });
        return true;

      case 'CHEATER_PAUSE':
        sendResponse({ ok: setPaused(message.paused === undefined ? !state.paused : !!message.paused),
                       paused: state.paused });
        return true;

      case 'CHEATER_CLEAR':
        deactivate();
        sendResponse({ ok: true });
        return true;

      /**
       * Grab, asked of EVERY frame.
       *
       * The key lands in whichever frame holds keyboard focus, which is almost never
       * the frame the cursor is in — composedPath() does not cross a frame boundary,
       * so a chart inside an iframe is hovered by that frame alone while the key goes
       * to the top document. Every frame is asked; only the one with something under
       * its pointer answers.
       */
      case 'CHEATER_GRAB':
        if (!state.active || !state.hovered) { sendResponse({ ok: false, grabbed: false }); return true; }
        grabHovered(!!message.exact).then(
          (grabbed) => sendResponse({ ok: true, grabbed, frame: location.href }),
          () => sendResponse({ ok: false, grabbed: false })
        );
        return true;   // async response

      case 'CHEATER_SELECT_BODY':
        selectBody().then((ok) => sendResponse({ ok }), () => sendResponse({ ok: false }));
        return true;   // async response

      // Only frames that actually hold a selection answer with a payload; every
      // other frame returns null and is skipped by the worker.
      case 'CHEATER_COLLECT': {
        // A capture may still be walking when the worker polls; answering null
        // here would silently drop this frame from the export.
        if (state.capturing) { sendResponse(null); return true; }
        let payload = null;
        try { payload = buildPayload(); } catch (error) { payload = null; }
        sendResponse(payload);
        return true;
      }

      case 'CHEATER_STATUS':
        sendResponse({
          ok: true,
          active: state.active,
          paused: state.paused,
          count: state.selections.length,
          isFrame: window.top !== window
        });
        return true;

      case 'CHEATER_TOAST':
        if (window.top === window) toast(message.text || '');
        sendResponse({ ok: true });
        return true;

      case 'CHEATER_SHORTCUTS':
        state.shortcuts = message.shortcuts || DEFAULT_SHORTCUTS;
        sendResponse({ ok: true });
        return true;

      default:
        return false;
    }
  });

  /* ======================================================================== *
   * SECTION: wiring
   * ======================================================================== */

  document.addEventListener('pointermove', onPointerMove, true);
  document.addEventListener('pointerdown', onPointerDown, { capture: true, passive: false });
  document.addEventListener('wheel', onWheel, { capture: true, passive: false });

  // Everything else in the interaction sequence is swallowed while active, so a
  // selection gesture can never also activate the page.
  for (const type of ['mousedown', 'mouseup', 'pointerup', 'click', 'auxclick', 'dblclick', 'contextmenu']) {
    document.addEventListener(type, swallowInteraction, true);
  }
  document.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('scroll', scheduleRefresh, true);
  window.addEventListener('resize', scheduleRefresh, true);

  // A page that swaps its content out from under a selection leaves a stale
  // outline behind; drop anything that has detached.
  const pruneObserver = new MutationObserver(() => {
    if (!state.active) return;
    const before = state.selections.length;
    state.selections = state.selections.filter((s) => s.el.isConnected);
    if (state.selections.length !== before) renderSelection();
  });
  try {
    pruneObserver.observe(document.documentElement, { childList: true, subtree: true });
  } catch (_) { /* noop */ }

  loadShortcuts();

  /**
   * Debug/test surface.
   *
   * Safe to expose unconditionally: a content script runs in an ISOLATED world,
   * so `window` here is not the page's window and no page script can see or call
   * any of this. It exists so test/fixtures.html can be driven directly (see
   * test/run-fixtures.mjs) and so capture problems can be poked at from the
   * devtools console with the content-script context selected.
   */
  window.__cheater = {
    activate: activate,
    deactivate: deactivate,
    setPaused: setPaused,
    grabHovered: grabHovered,
    diagnose: diagnose,
    noteAppeared: noteAppeared,
    layerBelongsToHover: layerBelongsToHover,
    revealTemporarily: revealTemporarily,
    findMenuTrigger: findMenuTrigger,
    findAttachedOverlays: findAttachedOverlays,
    hasOpenTrigger: hasOpenTrigger,
    smartExpand: smartExpand,
    isStructural: isStructural,
    isLeafish: isLeafish,
    scoreContainer: scoreContainer,
    resolveOverlay: resolveOverlay,
    isTransparentCatcher: isTransparentCatcher,
    looksLikeGlyph: looksLikeGlyph,
    iconFamilyKey: iconFamilyKey,
    parseFamilyStack: parseFamilyStack,
    captureRaw: captureRaw,
    buildPayload: buildPayload,
    addSelection: addSelection,
    clearSelection: clearSelection,
    selectBody: selectBody,
    requestExport: requestExport,
    toast: toast,
    scanStyleSheets: scanStyleSheets,
    pickFontFaces: pickFontFaces,
    nav: {
      up: navUp, down: navDown, reset: resetNav, current: navCurrent,
      anchor: ensureNavAnchor, subject: navSubject, state: state.nav
    },
    shouldWalkOnWheel: shouldWalkOnWheel,
    state: state
  };
})();
