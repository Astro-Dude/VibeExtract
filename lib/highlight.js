/**
 * Cheater — syntax highlighter for the HTML and TOON panels. No dependency.
 *
 * ESCAPE-FIRST, SINGLE-PASS. Both properties matter:
 *
 *   escape-first — the input is HTML-escaped before any markup is added, so a
 *     captured `<div>` in the source can never become a real tag in the panel.
 *     Highlighting escaped text also means the patterns match `&lt;div&gt;`
 *     rather than `<div>`, which the token definitions below account for.
 *     escapeHtml() deliberately escapes only & < > — quotes are safe inside
 *     element text — so string patterns must match a LITERAL `"`, never `&quot;`.
 *
 *   single-pass — one master alternation regex walks the string once. Running
 *     several passes would re-highlight text inside the <span>s emitted by an
 *     earlier pass (a class name matching a keyword, a colour inside a string),
 *     which is the classic way hand-rolled highlighters produce nested garbage.
 */
(function (name, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (typeof globalThis !== 'undefined' ? globalThis : self)[name] = api;
})('CheaterHighlight', function () {
  // Above this, highlighting a full-page export janks the tab for long enough to
  // feel broken. The panel shows plain escaped text instead.
  var SIZE_LIMIT = 400 * 1024;

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function span(cls, text) {
    return '<span class="tk-' + cls + '">' + text + '</span>';
  }

  /* --------------------------------------------------------------- HTML mode */

  // Order is significant: comments, then strings, then tags, then the rest.
  var HTML_RE = new RegExp([
    '(&lt;!--[\\s\\S]*?--&gt;)',                       // 1 comment
    '(&lt;/?)([a-zA-Z][\\w:-]*)',                      // 2 punct  3 tag name
    '("[^"]*")',                                       // 4 attribute value
    '([a-zA-Z-]+)(?==)',                               // 5 attribute name
    '(/?&gt;)'                                         // 6 tag close
  ].join('|'), 'g');

  function highlightHtml(source) {
    var escaped = escapeHtml(source);
    return escaped.replace(HTML_RE, function (match, comment, punct, tagName, str, attr, close) {
      if (comment) return span('comment', comment);
      if (tagName) return span('punct', punct) + span('tag', tagName);
      if (str) return span('string', str);
      if (attr) return span('attr', attr);
      if (close) return span('punct', close);
      return match;
    });
  }

  /* --------------------------------------------------------------- CSS mode */

  var CSS_RE = new RegExp([
    '(/\\*[\\s\\S]*?\\*/)',                            // 1 comment
    '(@[\\w-]+)',                                      // 2 at-rule
    '("[^"]*"|\'[^\']*\')',                            // 3 string
    '(#[0-9a-fA-F]{3,8})\\b',                          // 4 hex colour
    '(-?[\\d.]+)(px|rem|em|%|vh|vw|s|ms|deg|fr|ch)?\\b', // 5 number 6 unit
    '([\\w-]+)(?=\\s*:)'                               // 7 property
  ].join('|'), 'g');

  function highlightCss(source) {
    var escaped = escapeHtml(source);
    return escaped.replace(CSS_RE, function (match, comment, at, str, hex, num, unit, prop) {
      if (comment) return span('comment', comment);
      if (at) return span('keyword', at);
      if (str) return span('string', str);
      if (hex) return span('value', hex);
      if (num) return span('number', num + (unit || ''));
      if (prop) return span('attr', prop);
      return match;
    });
  }

  /* -------------------------------------------------------------- TOON mode */

  var TOON_RE = new RegExp([
    '^(##\\s+.*)$',                                    // 1 section heading
    '("(?:[^"\\\\]|\\\\.)*")',                        // 2 quoted text
    '(\\.[\\w-]+)',                                    // 3 class token
    '(^\\s*)([a-zA-Z][\\w-]*)',                        // 4 indent 5 tag
    '([\\[\\](){}])',                                  // 6 bracket
    '(#[0-9a-fA-F]{3,8})\\b',                          // 7 hex colour
    '(-?[\\d.]+)(px|rem|em|%|vh|vw|s|ms|deg|fr)?\\b'   // 8 number 9 unit
  ].join('|'), 'gm');

  function highlightToon(source) {
    var escaped = escapeHtml(source);
    return escaped.replace(TOON_RE, function (match, heading, str, cls, indent, tag, bracket, hex, num, unit) {
      if (heading) return span('keyword', heading);
      if (str) return span('string', str);
      if (cls) return span('cls', cls);
      if (tag) return indent + span('tag', tag);
      if (bracket) return span('punct', bracket);
      if (hex) return span('value', hex);
      if (num) return span('number', num + (unit || ''));
      return match;
    });
  }

  /**
   * mode: 'html' | 'toon'
   * Returns { html, highlighted } — `highlighted` is false when the source was
   * too large, so the caller can say so rather than looking broken.
   */
  function highlight(source, mode) {
    var text = String(source == null ? '' : source);
    if (text.length > SIZE_LIMIT) {
      return { html: escapeHtml(text), highlighted: false, reason: 'too-large' };
    }
    if (mode === 'toon') return { html: highlightToon(text), highlighted: true };

    // An HTML export is mostly markup with one big <style> island; highlight the
    // style block as CSS so declarations do not read as attribute soup.
    var styleMatch = /^([\s\S]*?<style>)([\s\S]*?)(<\/style>[\s\S]*)$/.exec(text);
    if (styleMatch) {
      return {
        html: highlightHtml(styleMatch[1]) + highlightCss(styleMatch[2]) + highlightHtml(styleMatch[3]),
        highlighted: true
      };
    }
    return { html: highlightHtml(text), highlighted: true };
  }

  return {
    highlight: highlight,
    escapeHtml: escapeHtml,
    SIZE_LIMIT: SIZE_LIMIT
  };
});
