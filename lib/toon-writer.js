/**
 * Cheater — TOON (Token-Optimized Object Notation).
 *
 * A compact, human-readable, LLM-friendly rendering of a capture. Exports both
 * directions so scripts/toon-to-html.js can parse a saved .toon back into the
 * same payload shape lib/html-writer.js consumes:
 *
 *   toToon(payload)  -> string
 *   parseToon(text)  -> payload
 *
 * Node grammar, in strict order:
 *   tag .styleClass .pseudoClass [inline overrides] (attributes) "text" { children }
 *
 * Bare quoted lines inside a block are standalone text nodes, which is what
 * preserves interleaving: `Best price, <em>guaranteed</em> daily` must not lose
 * the text around the <em>.
 */
(function (name, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (typeof globalThis !== 'undefined' ? globalThis : self)[name] = api;
})('CheaterToonWriter', function () {
  var BOOL_ATTRS = [
    'open', 'checked', 'selected', 'disabled', 'readonly', 'required',
    'multiple', 'hidden', 'icon'
  ];
  var BOOL_SET = {};
  for (var b = 0; b < BOOL_ATTRS.length; b += 1) BOOL_SET[BOOL_ATTRS[b]] = true;

  var TRUNCATED_RE = /^(data:[^;,]*(?:;base64)?,)…\((\d+) bytes\)$/;

  /* ---------------------------------------------------------------- escaping */

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t');
  }

  function unesc(value) {
    return String(value == null ? '' : value).replace(/\\(.)/g, function (match, ch) {
      if (ch === 'n') return '\n';
      if (ch === 'r') return '\r';
      if (ch === 't') return '\t';
      return ch;
    });
  }

  /**
   * `content` values get CSS-style hex escaping (\e5cd) rather than a literal
   * glyph. An icon codepoint written literally into a .toon file is invisible in
   * every editor and at the mercy of transfer encoding; \e5cd is legible, is
   * exactly what the author would write in CSS, and survives anything.
   */
  function escContent(value) {
    var str = String(value == null ? '' : value);
    var out = '';
    for (var i = 0; i < str.length; i += 1) {
      var ch = str[i];
      var code = str.charCodeAt(i);
      if (ch === '\\') out += '\\\\';
      else if (ch === '"') out += '\\"';
      else if (ch === '\n') out += '\\n';
      else if (code < 0x20 || code > 0x7e) out += '\\' + code.toString(16);
      else out += ch;
    }
    return out;
  }

  function unescContent(value) {
    return String(value == null ? '' : value).replace(
      /\\([0-9a-fA-F]{1,6})\s?|\\(.)/g,
      function (match, hex, ch) {
        if (hex) return String.fromCharCode(parseInt(hex, 16));
        if (ch === 'n') return '\n';
        if (ch === 'r') return '\r';
        if (ch === 't') return '\t';
        return ch;
      }
    );
  }

  /**
   * Embedded base64 payloads are useless to an LLM and would consume the entire
   * token budget, so they collapse to their data-URI prefix plus a byte count.
   * The HTML keeps the full payload, so the preview still renders.
   */
  function truncateDataUri(value) {
    var str = String(value == null ? '' : value);
    if (str.indexOf('data:') !== 0) return str;
    var comma = str.indexOf(',');
    if (comma === -1 || str.length < 128) return str;
    return str.slice(0, comma + 1) + '…(' + (str.length - comma - 1) + ' bytes)';
  }

  /* -------------------------------------------------------------- serializing */

  /**
   * A data: URI inside a STYLE VALUE needs the same truncation as one in an
   * attribute. Rasterized icon glyphs arrive as
   * `background-image: url("data:image/png;base64,…")`, and left intact a single
   * toolbar puts hundreds of kilobytes of base64 into the ## Styles section —
   * defeating the entire point of the format.
   */
  function truncateUrlsIn(value) {
    var str = String(value);
    if (str.indexOf('data:') === -1) return str;
    return str.replace(/url\((['"]?)(data:[^'")]+)\1\)/g, function (match, quote, uri) {
      return 'url("' + truncateDataUri(uri) + '")';
    });
  }

  function styleBody(style) {
    var parts = [];
    for (var prop in style) {
      if (!Object.prototype.hasOwnProperty.call(style, prop)) continue;
      var value = style[prop];
      if (value == null || value === '') continue;
      parts.push(prop + ': ' + truncateUrlsIn(value));
    }
    return parts.join('; ');
  }

  function attrSegment(attrs, isIcon) {
    var parts = [];
    for (var name in attrs) {
      if (!Object.prototype.hasOwnProperty.call(attrs, name)) continue;
      var value = attrs[name];
      if (value == null || value === false) continue;
      if (value === true) { parts.push(name); continue; }
      if (name === 'src' || name === 'href') value = truncateDataUri(value);
      parts.push(name + '="' + esc(value) + '"');
    }
    if (isIcon) parts.push('icon');
    return parts.length ? ' (' + parts.join(' ') + ')' : '';
  }

  function nodeHeader(node) {
    var out = node.tag || 'div';
    var cls = node.cls || [];
    for (var i = 0; i < cls.length; i += 1) out += '.' + cls[i];
    if (node.inline && Object.keys(node.inline).length) out += ' [' + styleBody(node.inline) + ']';
    out += attrSegment(node.attrs, node.icon);
    return out;
  }

  function writeNode(node, depth, out) {
    if (!node) return;
    var pad = new Array(depth + 1).join('  ');

    if (node.k === 't') {
      var text = String(node.v == null ? '' : node.v);
      if (text) out.push(pad + '"' + esc(text) + '"');
      return;
    }

    if (node.k === 'raw') {
      // Inline SVG markup, newlines collapsed so a node stays one line.
      var head = (node.tag || 'svg');
      var cls = node.cls || [];
      for (var c = 0; c < cls.length; c += 1) head += '.' + cls[c];
      if (node.inline && Object.keys(node.inline).length) head += ' [' + styleBody(node.inline) + ']';
      out.push(pad + head + ' ' + String(node.html || '').replace(/\s*\n\s*/g, ' '));
      return;
    }

    if (node.k === 'ph') {
      out.push(pad + nodeHeader(node) + ' @placeholder ' + (node.w || 0) + 'x' + (node.h || 0) +
        ' "' + esc(node.label || '') + '"');
      return;
    }

    if (node.k === 'img') {
      var attrs = {};
      for (var a in node.attrs) {
        if (Object.prototype.hasOwnProperty.call(node.attrs, a)) attrs[a] = node.attrs[a];
      }
      attrs.src = node.src;
      var imgNode = { tag: 'img', cls: node.cls, inline: node.inline, attrs: attrs, icon: false };
      out.push(pad + nodeHeader(imgNode));
      return;
    }

    var header = nodeHeader(node);
    var children = node.ch || [];

    if (!children.length) { out.push(pad + header); return; }

    // Single text child folds onto the node's own line.
    if (children.length === 1 && children[0].k === 't') {
      out.push(pad + header + ' "' + esc(children[0].v) + '"');
      return;
    }

    out.push(pad + header + ' {');
    for (var i = 0; i < children.length; i += 1) writeNode(children[i], depth + 1, out);
    out.push(pad + '}');
  }

  function fontsLine(fonts) {
    if (!fonts) return '';
    var parts = [];
    var families = fonts.google || [];
    for (var i = 0; i < families.length; i += 1) {
      var entry = families[i];
      var weights = (entry.weights || [400]).slice();
      var italic = (entry.italics || []).indexOf(true) !== -1;
      parts.push(entry.family + ':' + weights.join(',') + (italic ? 'i' : ''));
    }
    return parts.join('; ');
  }

  function toToon(payload) {
    var out = [];

    // ## Meta is an addition to the format sketch: without the font list the CLI
    // cannot reproduce the same <head> that "Save .html" produces.
    out.push('## Meta');
    if (payload.url) out.push('url: ' + payload.url);
    if (payload.title) out.push('title: ' + payload.title);
    var fonts = fontsLine(payload.fonts);
    if (fonts) out.push('fonts: ' + fonts);
    if (payload.fonts && payload.fonts.primary) out.push('primary: ' + payload.fonts.primary);
    if (payload.fonts && (payload.fonts.icons || []).length) out.push('icons: ' + payload.fonts.icons.join(', '));
    if (payload.pageBackground) out.push('background: ' + payload.pageBackground);

    var styles = payload.styles || {};
    var styleNames = Object.keys(styles);
    if (styleNames.length) {
      out.push('');
      out.push('## Styles');
      for (var s = 0; s < styleNames.length; s += 1) {
        out.push('.' + styleNames[s] + ': ' + styleBody(styles[styleNames[s]]));
      }
    }

    var wrappers = payload.wrappers || {};
    var wrapperNames = Object.keys(wrappers);
    if (wrapperNames.length) {
      out.push('');
      out.push('## Wrappers');
      for (var w = 0; w < wrapperNames.length; w += 1) {
        out.push('.' + wrapperNames[w] + ': ' + styleBody(wrappers[wrapperNames[w]]));
      }
    }

    var hovers = payload.hovers || [];
    if (hovers.length) {
      out.push('');
      out.push('## Hover Styles');
      for (var h = 0; h < hovers.length; h += 1) {
        out.push(hovers[h].sel + ': ' + styleBody(hovers[h].props));
      }
    }

    var pseudos = payload.pseudos || {};
    var pseudoNames = Object.keys(pseudos);
    if (pseudoNames.length) {
      out.push('');
      out.push('## Pseudo Styles');
      for (var p = 0; p < pseudoNames.length; p += 1) {
        var name = pseudoNames[p];
        ['before', 'after'].forEach(function (which) {
          var pseudo = pseudos[name][which];
          if (!pseudo) return;
          out.push('.' + name + '::' + which +
            ' [content="' + escContent(pseudo.content) + '"]: ' +
            styleBody(pseudo.style));
        });
      }
    }

    out.push('');
    out.push('## Structure');
    var nodes = payload.nodes || [];
    for (var n = 0; n < nodes.length; n += 1) writeNode(nodes[n], 0, out);
    out.push('');

    return out.join('\n');
  }

  /* ----------------------------------------------------------------- parsing */

  /** Split "a: 1; b: 2" into an object, tolerating values that contain colons. */
  function parseStyleBody(text) {
    var style = {};
    var parts = splitTopLevel(text, ';');
    for (var i = 0; i < parts.length; i += 1) {
      var part = parts[i].trim();
      if (!part) continue;
      var colon = part.indexOf(':');
      if (colon === -1) continue;
      var prop = part.slice(0, colon).trim();
      var value = part.slice(colon + 1).trim();
      if (prop) style[prop] = value;
    }
    return style;
  }

  /** Split on a delimiter that is not inside quotes, parens or brackets. */
  function splitTopLevel(text, delimiter) {
    var out = [];
    var depth = 0;
    var quote = '';
    var current = '';
    for (var i = 0; i < text.length; i += 1) {
      var ch = text[i];
      if (quote) {
        current += ch;
        if (ch === '\\') { current += text[i + 1] || ''; i += 1; continue; }
        if (ch === quote) quote = '';
        continue;
      }
      if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
      if (ch === '(' || ch === '[' || ch === '{') depth += 1;
      if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
      if (ch === delimiter && depth <= 0) { out.push(current); current = ''; continue; }
      current += ch;
    }
    out.push(current);
    return out;
  }

  function parseAttrs(text) {
    var attrs = {};
    var isIcon = false;
    var re = /([\w:.-]+)\s*=\s*"((?:[^"\\]|\\.)*)"|([\w:.-]+)/g;
    var match;
    while ((match = re.exec(text))) {
      if (match[1]) attrs[match[1]] = unesc(match[2]);
      else if (match[3]) {
        if (match[3] === 'icon') isIcon = true;
        else attrs[match[3]] = true;
      }
    }
    return { attrs: attrs, icon: isIcon };
  }

  /**
   * Parse a single node header: tag, classes, [inline], (attrs), then a trailing
   * "text" / raw svg / @placeholder / { marker.
   */
  function parseNodeLine(line) {
    var rest = line;
    var node = { k: 'e', tag: 'div', cls: [], attrs: {}, ch: [] };

    var tagMatch = /^([A-Za-z][\w-]*)/.exec(rest);
    if (!tagMatch) return null;
    node.tag = tagMatch[1];
    rest = rest.slice(tagMatch[1].length);

    var classRe = /^\.([\w-]+)/;
    var classMatch;
    while ((classMatch = classRe.exec(rest))) {
      node.cls.push(classMatch[1]);
      rest = rest.slice(classMatch[0].length);
    }

    rest = rest.replace(/^\s+/, '');

    if (rest[0] === '[') {
      var close = matchBracket(rest, '[', ']');
      if (close !== -1) {
        node.inline = parseStyleBody(rest.slice(1, close));
        rest = rest.slice(close + 1).replace(/^\s+/, '');
      }
    }

    if (rest[0] === '(') {
      var closeParen = matchBracket(rest, '(', ')');
      if (closeParen !== -1) {
        var parsed = parseAttrs(rest.slice(1, closeParen));
        node.attrs = parsed.attrs;
        if (parsed.icon) node.icon = true;
        rest = rest.slice(closeParen + 1).replace(/^\s+/, '');
      }
    }

    // Raw inline SVG markup.
    if (rest[0] === '<') {
      return { node: { k: 'raw', tag: node.tag, cls: node.cls, inline: node.inline, html: rest }, opens: false };
    }

    // Placeholder: @placeholder 320x180 "canvas"
    var phMatch = /^@placeholder\s+(\d+)x(\d+)(?:\s+"((?:[^"\\]|\\.)*)")?/.exec(rest);
    if (phMatch) {
      return {
        node: {
          k: 'ph', tag: node.tag, cls: node.cls, inline: node.inline, attrs: node.attrs,
          w: parseInt(phMatch[1], 10), h: parseInt(phMatch[2], 10), label: unesc(phMatch[3] || '')
        },
        opens: false
      };
    }

    var opens = false;
    if (/\{$/.test(rest)) { opens = true; rest = rest.slice(0, -1).replace(/\s+$/, ''); }

    var textMatch = /^"((?:[^"\\]|\\.)*)"$/.exec(rest);
    if (textMatch) node.ch.push({ k: 't', v: unesc(textMatch[1]) });

    // <img> carries its source as an attribute in TOON; restore the img node shape.
    if (node.tag === 'img') {
      var src = node.attrs.src || '';
      delete node.attrs.src;
      var truncated = TRUNCATED_RE.exec(src);
      if (truncated) {
        // The payload was stripped for the token budget and cannot be restored,
        // so it becomes a correctly-labelled placeholder rather than a dead <img>.
        return {
          node: {
            k: 'ph', tag: 'div', cls: node.cls, inline: node.inline, attrs: {},
            w: 0, h: 0, label: 'image (' + truncated[2] + ' bytes stripped)'
          },
          opens: false
        };
      }
      return { node: { k: 'img', tag: 'img', cls: node.cls, inline: node.inline, attrs: node.attrs, src: src }, opens: false };
    }

    return { node: node, opens: opens };
  }

  function matchBracket(text, open, close) {
    var depth = 0;
    var quote = '';
    for (var i = 0; i < text.length; i += 1) {
      var ch = text[i];
      if (quote) {
        if (ch === '\\') { i += 1; continue; }
        if (ch === quote) quote = '';
        continue;
      }
      if (ch === '"' || ch === "'") { quote = ch; continue; }
      if (ch === open) depth += 1;
      else if (ch === close) { depth -= 1; if (depth === 0) return i; }
    }
    return -1;
  }

  function parseToon(text) {
    var payload = {
      url: '', title: '', pageBackground: '',
      styles: {}, wrappers: {}, hovers: [], pseudos: {}, nodes: [],
      fonts: { google: [], icons: [], primary: '', primaryLoadable: true },
      fontFaces: [], fontBinaries: [], diagnostics: {}
    };

    var lines = String(text).split(/\r?\n/);
    var section = '';
    var stack = [];               // open element nodes awaiting children

    for (var i = 0; i < lines.length; i += 1) {
      var raw = lines[i];
      var line = raw.replace(/\s+$/, '');
      if (!line.trim()) continue;

      var headingMatch = /^##\s+(.+)$/.exec(line.trim());
      if (headingMatch) { section = headingMatch[1].toLowerCase(); stack = []; continue; }

      var trimmed = line.trim();

      if (section === 'meta') {
        var metaColon = trimmed.indexOf(':');
        if (metaColon === -1) continue;
        var key = trimmed.slice(0, metaColon).trim().toLowerCase();
        var value = trimmed.slice(metaColon + 1).trim();
        if (key === 'url') payload.url = value;
        else if (key === 'title') payload.title = value;
        else if (key === 'background') payload.pageBackground = value;
        else if (key === 'primary') payload.fonts.primary = value;
        else if (key === 'icons') payload.fonts.icons = value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
        else if (key === 'fonts') payload.fonts.google = parseFontsLine(value);
        continue;
      }

      if (section === 'styles' || section === 'wrappers') {
        var target = section === 'styles' ? payload.styles : payload.wrappers;
        var sColon = trimmed.indexOf(':');
        if (sColon === -1) continue;
        var sName = trimmed.slice(0, sColon).trim().replace(/^\./, '');
        target[sName] = parseStyleBody(trimmed.slice(sColon + 1));
        continue;
      }

      if (section === 'hover styles') {
        var hColon = trimmed.indexOf(': ');
        if (hColon === -1) continue;
        payload.hovers.push({
          sel: trimmed.slice(0, hColon).trim(),
          props: parseStyleBody(trimmed.slice(hColon + 2))
        });
        continue;
      }

      if (section === 'pseudo styles') {
        var pseudoMatch = /^\.([\w-]+)::(before|after)\s*\[content="((?:[^"\\]|\\.)*)"\]\s*:\s*(.*)$/.exec(trimmed);
        if (!pseudoMatch) continue;
        var pName = pseudoMatch[1];
        if (!payload.pseudos[pName]) payload.pseudos[pName] = { before: null, after: null };
        payload.pseudos[pName][pseudoMatch[2]] = {
          content: unescContent(pseudoMatch[3]),
          style: parseStyleBody(pseudoMatch[4])
        };
        continue;
      }

      if (section === 'structure') {
        if (trimmed === '}') { stack.pop(); continue; }

        var parent = stack.length ? stack[stack.length - 1] : null;

        // A bare quoted line is a standalone text node — this is what keeps
        // interleaved text in its original position.
        var bareText = /^"((?:[^"\\]|\\.)*)"$/.exec(trimmed);
        if (bareText) {
          var textNode = { k: 't', v: unesc(bareText[1]) };
          if (parent) parent.ch.push(textNode);
          else payload.nodes.push(textNode);
          continue;
        }

        var parsedNode = parseNodeLine(trimmed);
        if (!parsedNode) continue;
        if (parent) parent.ch.push(parsedNode.node);
        else payload.nodes.push(parsedNode.node);
        if (parsedNode.opens) stack.push(parsedNode.node);
      }
    }

    return payload;
  }

  function parseFontsLine(value) {
    var out = [];
    var entries = value.split(';');
    for (var i = 0; i < entries.length; i += 1) {
      var entry = entries[i].trim();
      if (!entry) continue;
      var colon = entry.lastIndexOf(':');
      if (colon === -1) { out.push({ family: entry, weights: [400], italics: [false] }); continue; }
      var family = entry.slice(0, colon).trim();
      var spec = entry.slice(colon + 1).trim();
      var italic = /i$/.test(spec);
      if (italic) spec = spec.slice(0, -1);
      var weights = spec.split(',').map(function (w) { return parseInt(w, 10); })
        .filter(function (w) { return !isNaN(w); });
      out.push({
        family: family,
        weights: weights.length ? weights : [400],
        italics: italic ? [false, true] : [false]
      });
    }
    return out;
  }

  return {
    toToon: toToon,
    parseToon: parseToon,
    truncateDataUri: truncateDataUri,
    BOOL_ATTRS: BOOL_ATTRS
  };
});
