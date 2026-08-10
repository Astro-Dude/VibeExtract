#!/usr/bin/env node
/**
 * Cheater — TOON -> HTML, zero dependencies.
 *
 *   node scripts/toon-to-html.js input.toon [output.html]
 *
 * Parses a saved .toon back into the same HTML the extension's "Save .html"
 * produces, by going through the very same lib/toon-writer.js parser and
 * lib/html-writer.js emitter the extension uses. That shared path is the point:
 * it makes "identical output" a property of the code rather than a promise, so
 * captures can be diffed across versions of the extension.
 *
 * One irreducible difference: TOON truncates embedded base64 payloads (canvas
 * snapshots, inlined bitmaps) to a byte count, because shipping them to an LLM
 * destroys the token budget. Those cannot be reconstructed, so they render as
 * correctly-labelled placeholder boxes. Use the .html export when you need the
 * pixels.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ToonWriter = require('../lib/toon-writer.js');
const HtmlWriter = require('../lib/html-writer.js');

function usage(code) {
  process.stderr.write(
    'Usage: node scripts/toon-to-html.js <input.toon> [output.html]\n' +
    '\n' +
    '  Converts a Cheater .toon capture back into standalone HTML.\n' +
    '  With no output path, writes <input>.html next to the input.\n' +
    '  Use "-" as the output path to write to stdout.\n'
  );
  process.exit(code);
}

function main(argv) {
  const args = argv.filter((arg) => arg !== '--');
  if (!args.length || args[0] === '-h' || args[0] === '--help') usage(args.length ? 0 : 1);

  const inputPath = args[0];
  if (!fs.existsSync(inputPath)) {
    process.stderr.write('error: no such file: ' + inputPath + '\n');
    process.exit(1);
  }

  const source = fs.readFileSync(inputPath, 'utf8');
  const payload = ToonWriter.parseToon(source);

  if (!payload.nodes.length) {
    process.stderr.write(
      'error: no nodes found. Is this a Cheater .toon file? A "## Structure" section is required.\n'
    );
    process.exit(1);
  }

  // fontMode 'relative' matches what "Save .html" writes, so the output pairs
  // with a preview-fonts.zip unzipped alongside it.
  const html = HtmlWriter.build(payload, { fontMode: 'relative', surface: 'auto' });

  const outputPath = args[1] || inputPath.replace(/\.toon$/i, '') + '.html';
  if (outputPath === '-') {
    process.stdout.write(html);
    return;
  }

  fs.writeFileSync(outputPath, html, 'utf8');

  const counts = {
    nodes: countNodes(payload.nodes),
    styles: Object.keys(payload.styles).length,
    hovers: payload.hovers.length,
    pseudos: Object.keys(payload.pseudos).length,
    stripped: countStripped(payload.nodes)
  };

  process.stderr.write(
    'wrote ' + path.relative(process.cwd(), outputPath) +
    '  (' + counts.nodes + ' nodes, ' + counts.styles + ' styles, ' +
    counts.hovers + ' hover rules, ' + counts.pseudos + ' pseudo sets)\n'
  );
  if (counts.stripped) {
    process.stderr.write(
      'note: ' + counts.stripped + ' embedded image payload(s) were truncated in the TOON and ' +
      'render as placeholders. Use the .html export for the real pixels.\n'
    );
  }
}

function countNodes(nodes) {
  let total = 0;
  (function walk(list) {
    for (const node of list || []) {
      total += 1;
      if (node.ch) walk(node.ch);
    }
  })(nodes);
  return total;
}

function countStripped(nodes) {
  let total = 0;
  (function walk(list) {
    for (const node of list || []) {
      if (node.k === 'ph' && /bytes stripped/.test(node.label || '')) total += 1;
      if (node.ch) walk(node.ch);
    }
  })(nodes);
  return total;
}

main(process.argv.slice(2));
