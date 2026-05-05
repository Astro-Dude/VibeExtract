#!/usr/bin/env node
// Convert a captured .toon file back into a previewable .html file.
// Mirrors contentScript.js's structureToHtml + buildExport CSS reset so the
// generated previews match what the Chrome extension would produce when
// saving "Save .html" — useful for diffing across versions of VibeExtract.
//
// Usage:
//   node scripts/toon-to-html.js "/mnt/c/.../component (1).toon"
//   node scripts/toon-to-html.js "/mnt/c/.../component (1).toon" "/tmp/out.html"

const fs = require('fs');
const path = require('path');

// ---------- TOON parser ----------

function parseToon(text) {
  // Split into sections by "## <name>" markers.
  const sections = {};
  const lines = text.split('\n');
  let current = null;
  for (const line of lines) {
    const m = line.match(/^##\s+(.+?)\s*$/);
    if (m) {
      current = m[1].trim();
      sections[current] = [];
    } else if (current) {
      sections[current].push(line);
    }
  }

  return {
    styles: parseClassBlock(sections['Styles'] || []),
    hoverStyles: parseClassBlock(sections['Hover Styles'] || [], { stripSuffix: ':hover' }),
    pseudoStyles: parsePseudoBlock(sections['Pseudo Styles'] || []),
    structure: parseStructure(sections['Structure'] || []),
  };
}

function parseClassBlock(lines, opts = {}) {
  const out = {};
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    // .sN: <css>   or   .sN:hover: <css>
    const m = line.match(/^\.([A-Za-z0-9_-]+)(:hover)?:\s*(.*)$/);
    if (!m) continue;
    let name = m[1];
    if (opts.stripSuffix && m[2] === opts.stripSuffix) {
      // hoverStyles map keyed by the base class name
    }
    out[name] = m[3];
  }
  return out;
}

function parsePseudoBlock(lines) {
  // Pattern: .pN::before [content="..."]: <css>
  //          .pN::after  [content="..."]: <css>
  const out = {};
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^\.([A-Za-z0-9_-]+)::(before|after)\s*\[content="((?:[^"\\]|\\.)*)"\]:\s*(.*)$/);
    if (!m) continue;
    const [, cls, pos, content, css] = m;
    if (!out[cls]) out[cls] = {};
    out[cls][pos] = { content: content.replace(/\\"/g, '"'), css };
  }
  return out;
}

// Tree of structure nodes. Each node:
//   { tag, style, pseudoClass, inlineStyle, attrs, text, svg, children }
function parseStructure(lines) {
  // Strip trailing empty lines
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();

  // The structure can hold multiple top-level trees separated by blanks.
  // Re-emit the lines through a stack-based parser.
  const stack = [];
  let root = null;
  let pendingChildHolder = null; // node currently waiting for `{ ... }` body

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) continue;

    // Closing brace at any indentation just pops one level.
    if (/^\s*}\s*$/.test(line)) {
      if (stack.length) stack.pop();
      pendingChildHolder = stack[stack.length - 1] || null;
      continue;
    }

    // Indentation of leading whitespace tells us the depth, but we mainly
    // rely on `{` / `}` markers for parent/child relationships.
    const node = parseStructureLine(line.trim());
    if (!node) continue;

    // Attach to parent if any.
    const parent = stack[stack.length - 1];
    if (parent) {
      if (!parent.children) parent.children = [];
      parent.children.push(node);
    } else {
      // Top-level. Wrap multi-trees in a synthetic <div>.
      if (!root) {
        root = node;
      } else if (root._isSynthetic) {
        root.children.push(node);
      } else {
        const old = root;
        root = { tag: 'div', _isSynthetic: true, children: [old, node] };
      }
    }

    if (node._opensBody) {
      stack.push(node);
    }
  }

  return root;
}

function parseStructureLine(line) {
  // SVG: <svg ...>...</svg>
  if (line.startsWith('SVG:')) {
    const svg = line.slice(4).trim();
    return { tag: 'svg', svg };
  }

  // Determine if this line opens a children block.
  let opensBody = false;
  if (line.endsWith('{')) {
    opensBody = true;
    line = line.slice(0, -1).trim();
  }

  // Pull off trailing text  ... "some text"
  let text = null;
  // Walk from the right to find a quoted string preceded by a space.
  // Need to be careful: inline-style brackets contain quoted values too.
  // Strategy: text is the *last* "..." that's not inside [...] or (...).
  const textMatch = matchTrailingString(line);
  if (textMatch) {
    text = textMatch.value;
    line = line.slice(0, textMatch.start).trimEnd();
  }

  // Pull off trailing attrs (...)
  let attrs = '';
  const attrMatch = matchTrailingParen(line);
  if (attrMatch) {
    attrs = attrMatch.value;
    line = line.slice(0, attrMatch.start).trimEnd();
  }

  // Pull off inline style [...]
  let inlineStyle = '';
  const inlineMatch = matchTrailingBracket(line);
  if (inlineMatch) {
    inlineStyle = inlineMatch.value;
    line = line.slice(0, inlineMatch.start).trimEnd();
  }

  // What's left should be tag.s1.p2 (e.g. "div.s1.p2")
  const m = line.match(/^([A-Za-z][A-Za-z0-9-]*)((?:\.[A-Za-z0-9_-]+)*)$/);
  if (!m) return null;
  const tag = m[1];
  const classes = m[2] ? m[2].split('.').filter(Boolean) : [];
  let style = null;
  let pseudoClass = null;
  for (const c of classes) {
    if (/^p\d+$/.test(c)) pseudoClass = c;
    else style = c;
  }

  const node = { tag, style, pseudoClass, inlineStyle, attrs, text };
  if (opensBody) node._opensBody = true;
  return node;
}

// Find a trailing "string" — the last balanced double-quoted segment that
// reaches the end of `s` (possibly preceded by whitespace).
function matchTrailingString(s) {
  if (!s.endsWith('"')) return null;
  let i = s.length - 2;
  while (i >= 0) {
    if (s[i] === '"' && s[i - 1] !== '\\') {
      // Found opening quote at i.
      // Require a space (or start) before i.
      const before = i === 0 ? ' ' : s[i - 1];
      if (before !== ' ' && before !== '\t') return null;
      const value = s.slice(i + 1, s.length - 1);
      return { value, start: i - 1 < 0 ? 0 : i };
    }
    i--;
  }
  return null;
}

function matchTrailingParen(s) {
  if (!s.endsWith(')')) return null;
  // Walk back to matching `(`
  let depth = 0;
  for (let i = s.length - 1; i >= 0; i--) {
    if (s[i] === ')') depth++;
    else if (s[i] === '(') {
      depth--;
      if (depth === 0) {
        // Require a space before
        if (i > 0 && s[i - 1] !== ' ') return null;
        return { value: s.slice(i + 1, s.length - 1), start: i - 1 < 0 ? 0 : i };
      }
    }
  }
  return null;
}

function matchTrailingBracket(s) {
  if (!s.endsWith(']')) return null;
  let depth = 0;
  for (let i = s.length - 1; i >= 0; i--) {
    if (s[i] === ']') depth++;
    else if (s[i] === '[') {
      depth--;
      if (depth === 0) {
        return { value: s.slice(i + 1, s.length - 1), start: i };
      }
    }
  }
  return null;
}

// ---------- HTML emission ----------

const VOID = new Set(['area','base','br','col','embed','hr','img','input','link','meta','source','track','wbr']);

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function attrsToHtml(attrStr, isVoid, hasInlineStyle, classNames) {
  // attrStr from TOON looks like:
  //   href="..." type="text" placeholder="Going to" value="..." aria-label="Going to."
  //   icon  (bare keyword for icon flag)
  //   open  checked  selected  disabled  readonly  required  multiple  hidden  (boolean attrs)
  if (!attrStr) return '';
  const out = [];
  // Tokenize on spaces while respecting quoted values.
  let i = 0;
  while (i < attrStr.length) {
    while (i < attrStr.length && attrStr[i] === ' ') i++;
    if (i >= attrStr.length) break;
    const start = i;
    // Read key
    while (i < attrStr.length && attrStr[i] !== '=' && attrStr[i] !== ' ') i++;
    const key = attrStr.slice(start, i);
    if (attrStr[i] === '=') {
      i++;
      // Expect quoted value
      if (attrStr[i] !== '"') continue;
      i++;
      const valStart = i;
      while (i < attrStr.length) {
        if (attrStr[i] === '"' && attrStr[i - 1] !== '\\') break;
        i++;
      }
      const value = attrStr.slice(valStart, i).replace(/\\"/g, '"');
      i++;
      if (key === 'icon') continue; // marker only
      out.push(`${key}="${escapeHtml(value)}"`);
    } else {
      // Bare keyword: icon, open, checked, etc.
      if (key === 'icon') { /* informational only */ }
      else out.push(key); // boolean attribute
    }
  }
  return out.length ? ' ' + out.join(' ') : '';
}

function nodeToHtml(node, indent = 0) {
  const pad = '  '.repeat(indent);
  if (!node) return '';
  if (node.svg) return `${pad}${node.svg}`;
  if (node._isSynthetic) {
    return (node.children || []).map(c => nodeToHtml(c, indent)).join('\n');
  }

  const tag = node.tag;
  const classList = [];
  if (node.style) classList.push(node.style);
  if (node.pseudoClass) classList.push(node.pseudoClass);
  let attrs = '';
  if (classList.length) attrs += ` class="${classList.join(' ')}"`;
  if (node.inlineStyle) attrs += ` style="${escapeHtml(node.inlineStyle)}"`;
  if (node.attrs) attrs += attrsToHtml(node.attrs, VOID.has(tag), !!node.inlineStyle, classList);

  if (VOID.has(tag)) {
    return `${pad}<${tag}${attrs}>`;
  }

  let inner = '';
  if (node.children && node.children.length) {
    inner = '\n' + node.children.map(c => nodeToHtml(c, indent + 1)).join('\n') + '\n' + pad;
  } else if (node.text != null) {
    inner = escapeHtml(node.text);
  }
  return `${pad}<${tag}${attrs}>${inner}</${tag}>`;
}

// ---------- Build full HTML document ----------

function buildHtml(parsed, opts = {}) {
  const { styles, hoverStyles, pseudoStyles, structure } = parsed;

  let css = '';
  for (const [name, decl] of Object.entries(styles)) {
    css += `.${name} { ${sanitizeCss(decl)}; }\n`;
  }
  for (const [name, decl] of Object.entries(hoverStyles)) {
    css += `.${name}:hover { ${sanitizeCss(decl)}; }\n`;
  }
  for (const [name, parts] of Object.entries(pseudoStyles)) {
    if (parts.before) {
      const body = parts.before.css ? `${sanitizeCss(parts.before.css)}; ` : '';
      css += `.${name}::before { content: '${escapeCssString(parts.before.content)}'; ${body}}\n`;
    }
    if (parts.after) {
      const body = parts.after.css ? `${sanitizeCss(parts.after.css)}; ` : '';
      css += `.${name}::after { content: '${escapeCssString(parts.after.content)}'; ${body}}\n`;
    }
  }

  const body = nodeToHtml(structure);
  const title = opts.title || 'Component Preview';

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>${escapeHtml(title)}</title>
  <style>
/* Reset base styles — mirrors VibeExtract's buildExport reset */
html, body { margin: 0; padding: 0; }
body { padding: 16px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji"; box-sizing: border-box; -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; font-size: 14px; line-height: 1.5; }
ul, ol { list-style: none; margin: 0; padding: 0; background: inherit; color: inherit; }
li { list-style: none; background: inherit; color: inherit; }
*, *::before, *::after { box-sizing: border-box; }
img, video, svg, canvas { max-width: 100%; }
button { background: transparent; border: none; cursor: pointer; color: inherit; padding: 0; }
input:where(:not([type]), [type="text"], [type="search"], [type="email"], [type="password"], [type="url"], [type="tel"], [type="number"], [type="date"], [type="time"], [type="datetime-local"], [type="month"], [type="week"]) { background: transparent; border: none; outline: none; color: inherit; min-width: 0; }
input::placeholder { color: inherit; opacity: 0.5; }
select { appearance: none; -webkit-appearance: none; -moz-appearance: none; background: transparent; border: none; outline: none; color: inherit; padding: 0; }
select::-ms-expand { display: none; }
a { color: inherit; text-decoration: inherit; }
span { display: inline; }
fieldset { border: 0; padding: 0; margin: 0; min-width: 0; }
legend { padding: 0; }
hr { border: 0; padding: 0; margin: 0; height: 0; color: inherit; background: transparent; }
${css}
  </style>
</head>
<body>
${body}
</body>
</html>`;
}

function sanitizeCss(s) {
  let r = s
    .replace(/overflow:\s*clip/g, 'overflow: hidden')
    .replace(/overflow-x:\s*clip/g, 'overflow-x: hidden')
    .replace(/overflow-y:\s*clip/g, 'overflow-y: hidden');
  if (r.includes('backdrop-filter:') && !r.includes('-webkit-backdrop-filter:')) {
    const m = r.match(/backdrop-filter:\s*([^;]+)/);
    if (m) r = r.replace(/backdrop-filter:\s*([^;]+)/, `backdrop-filter: ${m[1]}; -webkit-backdrop-filter: ${m[1]}`);
  }
  return r;
}

function escapeCssString(s) {
  if (s == null) return '';
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

// ---------- main ----------

function main() {
  const inputs = process.argv.slice(2);
  if (!inputs.length) {
    console.error('Usage: node toon-to-html.js <input.toon> [output.html]');
    process.exit(1);
  }
  const inPath = inputs[0];
  const outPath = inputs[1] || inPath.replace(/\.toon$/i, '.preview.html');
  const text = fs.readFileSync(inPath, 'utf8');
  const parsed = parseToon(text);
  const html = buildHtml(parsed, { title: path.basename(inPath) });
  fs.writeFileSync(outPath, html);
  console.error(`wrote ${outPath} (${html.length} bytes)`);
}

if (require.main === module) main();

module.exports = { parseToon, buildHtml };
