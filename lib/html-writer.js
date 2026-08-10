/**
 * Cheater — payload -> standalone HTML.
 *
 * Loaded as a classic script in export.html and required by
 * scripts/toon-to-html.js. Sharing this file is what makes "the CLI produces the
 * same HTML as Save .html" true by construction instead of by hand-maintained
 * duplication, so keep it free of anything browser- or Node-specific.
 *
 * Two output modes:
 *   fontMode: 'inline'   binaries as data URIs — used for the live preview, so
 *                        what you see is genuinely what the fonts do
 *   fontMode: 'relative' url("fonts/Inter-600.woff2") — used for the saved file,
 *                        which stays small and pairs with the fonts zip
 */
(function (name, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (typeof globalThis !== 'undefined' ? globalThis : self)[name] = api;
})('CheaterHtmlWriter', function () {
  var resetModule = (typeof module === 'object' && module.exports)
    ? require('./reset.js')
    : (typeof globalThis !== 'undefined' ? globalThis.CheaterReset : self.CheaterReset);

  var VOID_TAGS = {
    area: 1, base: 1, br: 1, col: 1, embed: 1, hr: 1, img: 1, input: 1, link: 1,
    meta: 1, param: 1, source: 1, track: 1, wbr: 1
  };

  /* ---------------------------------------------------------------- escaping */

  function escapeText(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function escapeAttr(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /**
   * CSS string for `content`. Non-ASCII is escaped to \XXXXXX so a PUA icon
   * codepoint survives any file encoding, with the terminating space CSS
   * requires after a hex escape.
   */
  function cssString(value) {
    var out = '';
    var str = String(value == null ? '' : value);
    for (var i = 0; i < str.length; i += 1) {
      var ch = str[i];
      var code = str.charCodeAt(i);
      if (ch === '"') out += '\\"';
      else if (ch === '\\') out += '\\\\';
      else if (code < 0x20 || code > 0x7e) out += '\\' + code.toString(16) + ' ';
      else out += ch;
    }
    return '"' + out + '"';
  }

  /* ------------------------------------------------------------ declarations */

  function declarations(style, indent) {
    var pad = indent || '  ';
    var out = [];
    for (var prop in style) {
      if (!Object.prototype.hasOwnProperty.call(style, prop)) continue;
      var value = style[prop];
      // `content` is checked BEFORE the empty-value guard: content:"" is
      // meaningful — it is what makes a decorative pseudo (divider, toggle
      // handle, custom checkbox mark) generate a box at all. Dropping it as
      // "empty" silently deletes every such pseudo from the export.
      if (prop === 'content') { out.push(pad + 'content: ' + cssString(value == null ? '' : value) + ';'); continue; }
      if (value == null || value === '') continue;
      out.push(pad + prop + ': ' + value + ';');
    }
    return out.join('\n');
  }

  function inlineDeclarations(style) {
    var out = [];
    for (var prop in style) {
      if (!Object.prototype.hasOwnProperty.call(style, prop)) continue;
      var value = style[prop];
      if (value == null || value === '') continue;
      out.push(prop + ':' + value);
    }
    return out.join(';');
  }

  /* -------------------------------------------------------------------- fonts */

  // One <link> PER FAMILY, deliberately. A single combined css2 request 400s in
  // its entirety if any one family is not hosted on Google Fonts, which would
  // mean one self-hosted family silently costing every other family its webfont.
  function googleFontLinks(fonts) {
    var links = [];
    var families = (fonts && fonts.google) || [];
    for (var i = 0; i < families.length; i += 1) {
      var url = googleFontUrl(families[i]);
      if (url) links.push('<link rel="stylesheet" href="' + escapeAttr(url) + '">');
    }
    return links;
  }

  function googleFontUrl(entry) {
    if (!entry || !entry.family) return null;
    var family = String(entry.family).trim().replace(/\s+/g, '+');
    var weights = (entry.weights && entry.weights.length ? entry.weights : [400])
      .slice().sort(function (a, b) { return a - b; });
    var italics = entry.italics || [];
    var wantsNormal = italics.indexOf(false) !== -1 || italics.length === 0;
    var wantsItalic = italics.indexOf(true) !== -1;

    var spec;
    if (wantsItalic && wantsNormal) {
      var pairs = [];
      for (var i = 0; i < weights.length; i += 1) pairs.push('0,' + weights[i]);
      for (var j = 0; j < weights.length; j += 1) pairs.push('1,' + weights[j]);
      spec = 'ital,wght@' + pairs.join(';');
    } else if (wantsItalic) {
      var ital = [];
      for (var k = 0; k < weights.length; k += 1) ital.push('1,' + weights[k]);
      spec = 'ital,wght@' + ital.join(';');
    } else {
      spec = 'wght@' + weights.join(';');
    }
    return 'https://fonts.googleapis.com/css2?family=' + family + ':' + spec + '&display=swap';
  }

  // Stylesheets for the icon families the capture actually used. Keyed by the
  // family group iconFamilyKey() reports, so "Material Icons Outlined" and
  // "Material Icons" resolve to one link rather than two.
  var ICON_STYLESHEETS = {
    'material-icons': 'https://fonts.googleapis.com/css2?family=Material+Icons&family=Material+Icons+Outlined&family=Material+Icons+Round&family=Material+Icons+Sharp&display=swap',
    'material-symbols': 'https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200&family=Material+Symbols+Rounded&family=Material+Symbols+Sharp&display=swap',
    fa6: 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css',
    fa4: 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/4.7.0/css/font-awesome.min.css',
    'bootstrap-icons': 'https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css',
    glyphicons: 'https://cdn.jsdelivr.net/npm/bootstrap@3.4.1/dist/css/bootstrap.min.css'
  };

  function iconLinks(fonts) {
    var links = [];
    var seen = {};
    var icons = (fonts && fonts.icons) || [];
    for (var i = 0; i < icons.length; i += 1) {
      var href = ICON_STYLESHEETS[icons[i]];
      // 'generic' means a self-hosted icon font — it arrives via @font-face
      // bundling instead, so there is nothing to link.
      if (!href || seen[href]) continue;
      seen[href] = true;
      links.push('<link rel="stylesheet" href="' + escapeAttr(href) + '">');
    }
    return links;
  }

  /**
   * @font-face block for the page's own self-hosted fonts.
   * A descriptor with no successfully fetched binary is skipped rather than
   * emitted with a dead URL — one font failing must not poison the others.
   */
  function fontFaceBlock(payload, fontMode) {
    var faces = payload.fontFaces || [];
    var binaries = {};
    var list = payload.fontBinaries || [];
    for (var b = 0; b < list.length; b += 1) {
      if (list[b] && list[b].ok) binaries[list[b].url] = list[b];
    }

    var out = [];
    for (var i = 0; i < faces.length; i += 1) {
      var face = faces[i];
      var src;

      if (face.inline && /^data:/.test(face.url)) {
        src = 'url("' + face.url + '")';
      } else if (fontMode === 'inline') {
        var binary = binaries[face.url];
        if (!binary) continue;
        src = 'url("data:' + (binary.mime || face.mime) + ';base64,' + binary.base64 + '")';
      } else {
        if (!binaries[face.url] && !face.inline) continue;
        src = 'url("' + face.path + '")';
      }

      var rule = ['@font-face{'];
      rule.push('font-family:"' + face.family + '";');
      rule.push('src:' + src + ' format("' + (face.format || 'woff2') + '");');
      if (face.weight) rule.push('font-weight:' + face.weight + ';');
      if (face.style) rule.push('font-style:' + face.style + ';');
      if (face.unicodeRange) rule.push('unicode-range:' + face.unicodeRange + ';');
      rule.push('font-display:' + (face.display || 'swap') + ';');
      rule.push('}');
      out.push(rule.join(''));
    }
    return out.join('\n');
  }

  /* ------------------------------------------------------------------- rules */

  function styleRules(payload) {
    var out = [];
    var styles = payload.styles || {};
    for (var name in styles) {
      if (!Object.prototype.hasOwnProperty.call(styles, name)) continue;
      var body = declarations(styles[name]);
      if (body) out.push('.' + name + ' {\n' + body + '\n}');
    }
    var wrappers = payload.wrappers || {};
    for (var wrapper in wrappers) {
      if (!Object.prototype.hasOwnProperty.call(wrappers, wrapper)) continue;
      var wrapperBody = declarations(wrappers[wrapper]);
      if (wrapperBody) out.push('.' + wrapper + ' {\n' + wrapperBody + '\n}');
    }
    return out.join('\n');
  }

  function hoverRules(payload) {
    var out = [];
    var hovers = payload.hovers || [];
    for (var i = 0; i < hovers.length; i += 1) {
      var body = declarations(hovers[i].props);
      if (body) out.push(hovers[i].sel + ' {\n' + body + '\n}');
    }
    return out.join('\n');
  }

  function pseudoRules(payload) {
    var out = [];
    var pseudos = payload.pseudos || {};
    for (var name in pseudos) {
      if (!Object.prototype.hasOwnProperty.call(pseudos, name)) continue;
      var entry = pseudos[name];
      ['before', 'after'].forEach(function (which) {
        var pseudo = entry[which];
        if (!pseudo) return;
        var style = {};
        // `content` must always be present or the pseudo does not generate a box
        // at all — decorative pseudos legitimately carry an empty string.
        style.content = pseudo.content == null ? '' : pseudo.content;
        for (var prop in pseudo.style) {
          if (Object.prototype.hasOwnProperty.call(pseudo.style, prop)) style[prop] = pseudo.style[prop];
        }
        out.push('.' + name + '::' + which + ' {\n' + declarations(style) + '\n}');
      });
    }
    return out.join('\n');
  }

  /* ------------------------------------------------------------------- nodes */

  function renderNode(node, depth, out) {
    if (!node) return;
    var pad = new Array(depth + 1).join('  ');

    if (node.k === 't') {
      var text = String(node.v == null ? '' : node.v);
      if (text) out.push(pad + escapeText(text));
      return;
    }

    if (node.k === 'raw') {
      out.push(pad + injectSvgAttrs(node.html, node.cls, node.inline));
      return;
    }

    if (node.k === 'ph') {
      var phStyle = {};
      for (var p in node.inline) if (Object.prototype.hasOwnProperty.call(node.inline, p)) phStyle[p] = node.inline[p];
      if (node.w) phStyle.width = node.w + 'px';
      if (node.h) phStyle.height = node.h + 'px';
      out.push(pad + '<div' + classAttr(node.cls, 'cheater-ph') + styleAttr(phStyle) + '>' +
        escapeText(node.label || '') + '</div>');
      return;
    }

    if (node.k === 'img') {
      var attrs = attrString(node.attrs);
      out.push(pad + '<img' + classAttr(node.cls) + styleAttr(node.inline) +
        ' src="' + escapeAttr(node.src || '') + '"' + attrs + '>');
      return;
    }

    var tag = node.tag || 'div';
    var open = '<' + tag + classAttr(node.cls) + styleAttr(node.inline) + attrString(node.attrs) + '>';

    if (VOID_TAGS[tag]) { out.push(pad + open); return; }

    var children = node.ch || [];
    if (!children.length) { out.push(pad + open + '</' + tag + '>'); return; }

    // A single text child stays on one line; anything interleaved gets indented
    // so the source stays readable.
    if (children.length === 1 && children[0].k === 't') {
      out.push(pad + open + escapeText(children[0].v) + '</' + tag + '>');
      return;
    }

    out.push(pad + open);
    for (var i = 0; i < children.length; i += 1) renderNode(children[i], depth + 1, out);
    out.push(pad + '</' + tag + '>');
  }

  function classAttr(cls, extra) {
    var list = (cls || []).slice();
    if (extra) list.unshift(extra);
    if (!list.length) return '';
    return ' class="' + escapeAttr(list.join(' ')) + '"';
  }

  function styleAttr(style) {
    if (!style) return '';
    var body = inlineDeclarations(style);
    return body ? ' style="' + escapeAttr(body) + '"' : '';
  }

  var BOOL_ATTRS = {
    checked: 1, selected: 1, disabled: 1, readonly: 1, required: 1,
    multiple: 1, hidden: 1, open: 1
  };

  function attrString(attrs) {
    if (!attrs) return '';
    var out = '';
    for (var name in attrs) {
      if (!Object.prototype.hasOwnProperty.call(attrs, name)) continue;
      var value = attrs[name];
      if (value === false || value == null) continue;
      if (value === true || (BOOL_ATTRS[name] && value === '')) { out += ' ' + name; continue; }
      out += ' ' + name + '="' + escapeAttr(value) + '"';
    }
    return out;
  }

  /**
   * The SVG markup arrives as a serialized string, so our class and inline style
   * have to be spliced into its root tag. captureSvg() strips the original root
   * class/style precisely so this cannot produce a duplicate attribute (where the
   * browser would silently keep the first and drop ours).
   */
  function injectSvgAttrs(html, cls, inline) {
    var insert = classAttr(cls) + styleAttr(inline);
    if (!insert) return html;
    return String(html).replace(/^<svg/i, '<svg' + insert);
  }

  /* ----------------------------------------------------------------- surface */

  var PLACEHOLDER_CSS = [
    '.cheater-ph{display:flex;align-items:center;justify-content:center;',
    'font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;',
    'color:#8A8F98;background-color:#f2f3f5;',
    'background-image:repeating-linear-gradient(45deg,rgba(0,0,0,.055) 0 6px,transparent 6px 12px);',
    'border:1px dashed #c8ccd2;letter-spacing:.04em;box-sizing:border-box;overflow:hidden}'
  ].join('');

  function surfaceCss(payload, surface) {
    var background = payload.pageBackground && payload.pageBackground !== 'none'
      ? payload.pageBackground
      : '#ffffff';
    if (surface === 'light') background = '#ffffff';
    if (surface === 'dark') background = '#111315';
    var color = surface === 'dark' ? '#E8E6E1' : 'inherit';
    return 'body{background:' + background + (color !== 'inherit' ? ';color:' + color : '') + '}';
  }

  // A real blur, not merely the property being present: `backdrop-filter: none`
  // must not trigger the decorative backdrop.
  function isRealBackdrop(style) {
    if (!style) return false;
    var value = style['backdrop-filter'];
    return !!value && value !== 'none';
  }

  function usesBackdropFilter(payload) {
    var styles = payload.styles || {};
    for (var name in styles) {
      if (Object.prototype.hasOwnProperty.call(styles, name) && isRealBackdrop(styles[name])) return true;
    }
    var found = false;
    (function walk(list) {
      for (var i = 0; i < list.length && !found; i += 1) {
        var node = list[i];
        if (node && isRealBackdrop(node.inline)) { found = true; return; }
        if (node && node.ch) walk(node.ch);
      }
    })(payload.nodes || []);
    return found;
  }

  /* ------------------------------------------------------------------- entry */

  function build(payload, options) {
    var opts = options || {};
    var fontMode = opts.fontMode || 'relative';
    var surface = opts.surface || 'auto';

    var head = [];
    head.push('<meta charset="utf-8">');
    head.push('<meta name="viewport" content="width=device-width, initial-scale=1">');
    head.push('<title>' + escapeText(opts.title || payload.title || 'Cheater export') + '</title>');
    if (payload.url) head.push('<!-- captured from ' + escapeText(payload.url) + ' -->');

    var links = googleFontLinks(payload.fonts).concat(iconLinks(payload.fonts));
    if (links.length) {
      head.push('<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>');
      head = head.concat(links);
    }

    var backdrop = usesBackdropFilter(payload);
    var css = [];
    css.push('/* reset: zero specificity via :where(), so captured rules always win */');
    css.push(resetModule.RESET_CSS);
    css.push(PLACEHOLDER_CSS);
    css.push(surfaceCss(payload, surface));
    if (backdrop) css.push(resetModule.BACKDROP_SURFACE_CSS);

    var faces = fontFaceBlock(payload, fontMode);
    if (faces) css.push('/* bundled self-hosted fonts */\n' + faces);

    var styles = styleRules(payload);
    if (styles) css.push('/* captured styles */\n' + styles);

    var hovers = hoverRules(payload);
    if (hovers) css.push('/* hover states */\n' + hovers);

    var pseudos = pseudoRules(payload);
    if (pseudos) css.push('/* pseudo-elements */\n' + pseudos);

    head.push('<style>\n' + css.join('\n\n') + '\n</style>');

    var body = [];
    var nodes = payload.nodes || [];
    for (var i = 0; i < nodes.length; i += 1) renderNode(nodes[i], 1, body);

    return [
      '<!DOCTYPE html>',
      '<html lang="en">',
      '<head>',
      head.join('\n'),
      '</head>',
      '<body' + (backdrop ? ' class="cheater-has-backdrop"' : '') + '>',
      body.join('\n'),
      '</body>',
      '</html>',
      ''
    ].join('\n');
  }

  return {
    build: build,
    googleFontUrl: googleFontUrl,
    ICON_STYLESHEETS: ICON_STYLESHEETS,
    escapeText: escapeText,
    escapeAttr: escapeAttr,
    cssString: cssString
  };
});
