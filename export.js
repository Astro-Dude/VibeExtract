/**
 * Cheater — export tab.
 *
 * Pulls the payload the service worker staged, renders Preview / HTML / TOON,
 * shows diagnostics, and saves files. Everything it needs is already in the
 * payload; this file makes no DOM reads against the captured page and no network
 * calls except a late single font re-fetch when a binary failed earlier.
 */

'use strict';

(function () {
  var HtmlWriter = window.CheaterHtmlWriter;
  var ToonWriter = window.CheaterToonWriter;
  var Zip = window.CheaterZip;
  var Highlight = window.CheaterHighlight;

  var el = function (id) { return document.getElementById(id); };

  var state = {
    payload: null,
    exportId: null,
    savedHtml: '',
    previewHtml: '',
    toon: '',
    width: 'fit',
    surface: 'dark',
    tab: 'preview'
  };

  /* ---------------------------------------------------------------- helpers */

  function toast(text, bad) {
    var node = el('toast');
    node.textContent = text;
    node.className = 'toast show' + (bad ? ' bad' : '');
    clearTimeout(node._timer);
    node._timer = setTimeout(function () { node.className = 'toast'; }, 2600);
  }

  function formatBytes(count) {
    if (count < 1024) return count + ' B';
    if (count < 1024 * 1024) return (count / 1024).toFixed(1) + ' KB';
    return (count / (1024 * 1024)).toFixed(2) + ' MB';
  }

  function byteLength(text) {
    return new TextEncoder().encode(text).length;
  }

  /**
   * Staged progress for the export tab.
   *
   * A full-page payload means megabytes of HTML and TOON to build and highlight,
   * which is seconds of synchronous work. Percentages here are STAGE-based, not
   * measured — each stage is named so the number is honest about what it means
   * rather than pretending to track bytes.
   */
  function setStage(label, pct, sub) {
    var box = el('loading');
    if (!box || box.classList.contains('done')) return;
    el('loading-label').textContent = label;
    el('loading-pct').textContent = Math.round(pct) + '%';
    el('loading-fill').style.width = Math.round(pct) + '%';
    if (sub != null) el('loading-sub').textContent = sub;
  }

  function finishStages() {
    var box = el('loading');
    if (box) box.classList.add('done');
  }

  // Let the browser paint between stages, otherwise the bar jumps straight from
  // 0 to 100 and the whole exercise is pointless.
  function paint() {
    return new Promise(function (resolve) {
      requestAnimationFrame(function () { requestAnimationFrame(resolve); });
    });
  }

  /* ------------------------------------------------------------ diagnostics */

  function pill(label, value, tone) {
    var cls = 'pill' + (tone ? ' ' + tone : '') + (value ? ' on' : '');
    return '<span class="' + cls + '">' + label + ' <b>' + value + '</b></span>';
  }

  function renderDiagnostics() {
    var diag = state.payload.diagnostics || {};
    var fonts = state.payload.fonts || {};
    var pills = [];

    pills.push(pill('selections', diag.topLevel || 0));
    if (diag.frames > 1) pills.push(pill('frames', diag.frames));
    pills.push(pill('wraps', diag.wraps || 0));
    pills.push(pill('dropped', diag.dropped || 0));
    pills.push(pill('styles', diag.styleCount || 0));
    pills.push(pill('pseudos', diag.pseudoCount || 0));
    if (diag.hoverCount) pills.push(pill('hovers', diag.hoverCount));
    if (diag.iconNodes) pills.push(pill('icons', diag.iconNodes));
    if (diag.iconsRasterized) pills.push(pill('icons rasterized', diag.iconsRasterized));
    if (diag.iconsLost) pills.push(pill('icons lost', diag.iconsLost, 'bad'));
    if (diag.pixelsRecovered) pills.push(pill('pixels recovered', diag.pixelsRecovered));
    if (diag.pixelsFailed) pills.push(pill('pixels failed', diag.pixelsFailed, 'warn'));
    pills.push(pill('fonts', diag.fontsBundled || 0));
    if (diag.fontFailures) pills.push(pill('font fails', diag.fontFailures, 'bad'));
    if (diag.canvasPlaceholders) pills.push(pill('canvas gaps', diag.canvasPlaceholders, 'warn'));
    if (diag.imagesDropped) pills.push(pill('imgs dropped', diag.imagesDropped, 'warn'));
    if (fonts.primary && !fonts.primaryLoadable) {
      pills.push(pill('font not loadable', fonts.primary, 'warn'));
    }
    el('pills').innerHTML = pills.join('');

    var rows = (diag.selections || []).map(function (sel) {
      var badges = '';
      if (sel.wrapped) badges += '<span class="badge w">wrapped</span>';
      if (sel.dropped) badges += '<span class="badge d">' + sel.dropped + ' dropped</span>';
      return '<div class="row">' +
        '<span class="tag">' + escapeHtml(sel.tag || '?') + '</span>' +
        '<span class="cls">' + (sel.classes ? '.' + escapeHtml(sel.classes) : '<span class="dim">no classes</span>') + '</span>' +
        '<span class="dim">' + sel.w + '×' + sel.h + '</span>' +
        '<span class="dim">@ ' + sel.x + ',' + sel.y + '</span>' +
        '<span class="dim">' + (sel.nodes || 0) + ' nodes</span>' +
        badges +
        '</div>';
    });
    el('rows').innerHTML = rows.join('') || '<div class="row"><span class="dim">no selections recorded</span></div>';

    // Per-family icon report. When icons come out blank this is the fact that
    // actually identifies the cause: which font, what kind of glyph, and what was
    // decided about it.
    var families = diag.iconFamilies || {};
    var familyKeys = Object.keys(families);
    if (familyKeys.length) {
      el('rows').innerHTML += familyKeys.sort().map(function (key) {
        var parts = key.split(' | ');
        var tone = parts[2] === 'lost' ? 'd' : (parts[2] === 'linked' ? 'w' : '');
        return '<div class="row">' +
          '<span class="tag">icon font</span>' +
          '<span class="cls">' + escapeHtml(parts[0]) + '</span>' +
          '<span class="dim">' + escapeHtml(parts[1]) + '</span>' +
          '<span class="dim">x' + families[key] + '</span>' +
          '<span class="badge ' + tone + '">' + escapeHtml(parts[2]) + '</span>' +
          '</div>';
      }).join('');
    }

    // Notes explain what to DO about a number, which is the difference between
    // a diagnostic and a statistic.
    var notes = [];
    if (diag.dropped) {
      notes.push({
        text: diag.dropped + ' node(s) filtered out (hidden, zero-size, or non-rendered markup like ' +
          '<script>/<noscript>). Use Alt+Click for exact targeting if you want the filtered nodes included.'
      });
    }
    if (diag.fontsBundled) {
      notes.push({ text: diag.fontsBundled + ' self-hosted font file(s) bundled — unzip the fonts next to the saved HTML so it renders offline with matching text widths.' });
    }
    if (diag.fontFailures) {
      notes.push({ warn: true, text: diag.fontFailures + ' font file(s) failed to fetch. "Download fonts" will retry them; a tokenized CDN URL may simply have expired.' });
    }
    if (state.payload.fonts && state.payload.fonts.primary && !state.payload.fonts.primaryLoadable) {
      notes.push({
        warn: true,
        text: 'Primary font "' + state.payload.fonts.primary + '" is not auto-loadable. ' +
          'Fallback metrics change text widths, which is the usual cause of an export looking like it overflows when the original did not.'
      });
    }
    if (diag.iconsRasterized) {
      notes.push({ text: diag.iconsRasterized + ' icon glyph(s) came from a font that cannot travel ' +
        '(loaded via the JS FontFace API, or from a CORS-restricted stylesheet, so there is no ' +
        '@font-face to bundle). They were rendered to images at 2x so they still display — the ' +
        'trade-off is that they no longer scale as text.' });
    }
    var linkedPua = Object.keys(diag.iconFamilies || {}).filter(function (k) {
      return / \| pua \| linked$/.test(k);
    });
    if (linkedPua.length) {
      notes.push({ warn: true, text: 'A private-use icon codepoint is being linked from a public ' +
        'CDN font (' + linkedPua.map(function (k) { return k.split(' | ')[0]; }).join(', ') + '). ' +
        'Codepoints are font-specific, so this may render the wrong glyph or none at all.' });
    }
    if (diag.pixelsRecovered) {
      notes.push({ text: diag.pixelsRecovered + ' element(s) could not be reproduced from source ' +
        '(unreadable canvas, cross-origin frame, an icon whose font cannot travel, or a box that ' +
        'would have rendered empty) and were recovered as cropped pixels from a screenshot of the ' +
        'tab. They look right but are images, not markup.' });
    }
    if (diag.pixelsFailed) {
      notes.push({ warn: true, text: diag.pixelsFailed + ' element(s) could not be recovered even ' +
        'as pixels — the tab screenshot was unavailable (the tab must be active and visible, and ' +
        'Chrome rate-limits it). Re-running the export usually succeeds.' });
    }
    if (diag.iconsLost) {
      notes.push({ warn: true, text: diag.iconsLost + ' icon glyph(s) could not be shipped or ' +
        'rasterized and will render blank. This usually means the icon font was never actually ' +
        'loaded in the page.' });
    }
    if (diag.canvasPlaceholders) {
      notes.push({ warn: true, text: diag.canvasPlaceholders + ' canvas element(s) could not be read (cross-origin taint, or a WebGL context without preserveDrawingBuffer) and became correctly-sized placeholders.' });
    }
    if (diag.imagesDropped) {
      notes.push({ text: diag.imagesDropped + ' image(s) had no resolvable source and were dropped — a broken-image glyph would have wrecked the row layout.' });
    }
    if (diag.imagesTainted) {
      notes.push({ text: diag.imagesTainted + ' image(s) are cross-origin without CORS, so they kept their absolute URL instead of being inlined and need network to render.' });
    }
    if (diag.wraps) {
      notes.push({ text: diag.wraps + ' selection(s) were wrapped in a synthetic container carrying the real parent\'s flex/grid layout, so they still flow correctly.' });
    }
    if (diag.frames > 1) {
      notes.push({ text: 'Merged from ' + diag.frames + ' frames; each frame\'s style classes were renamed to avoid collisions.' });
    }
    if (!notes.length) notes.push({ text: 'Nothing filtered or degraded — the capture is complete.' });

    el('notes').innerHTML = notes.map(function (note) {
      return '<div class="note' + (note.warn ? ' warn' : '') + '">' + escapeHtml(note.text) + '</div>';
    }).join('');
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /* ---------------------------------------------------------------- preview */

  function renderPreview() {
    var frame = el('frame');
    var html = HtmlWriter.build(state.payload, {
      fontMode: 'inline',            // accurate preview needs the real binaries
      surface: state.surface
    });
    state.previewHtml = html;
    frame.srcdoc = html;
  }

  /**
   * Auto-size the iframe to its content, and scale it down when a fixed viewport
   * width does not fit the pane. Same-origin srcdoc is what makes reading
   * scrollHeight possible at all (scripts stay blocked — no allow-scripts).
   */
  function fitFrame() {
    var frame = el('frame');
    var stage = el('stage');
    var pane = el('preview-pane');
    var doc;
    try { doc = frame.contentDocument; } catch (_) { doc = null; }

    var available = Math.max(200, pane.clientWidth - 44);
    var target = state.width === 'fit' ? available : parseInt(state.width, 10);

    frame.style.width = target + 'px';
    stage.style.width = target + 'px';

    var height = 200;
    if (doc && doc.documentElement) {
      // Collapse to measure, so shrinking content shrinks the frame too.
      frame.style.height = '0px';
      height = Math.max(
        doc.documentElement.scrollHeight,
        doc.body ? doc.body.scrollHeight : 0,
        40
      );
    }
    frame.style.height = height + 'px';

    var scale = target > available ? available / target : 1;
    stage.style.transform = scale === 1 ? 'none' : 'scale(' + scale + ')';
    stage.style.height = (height * scale) + 'px';
    stage.style.marginLeft = scale === 1 ? 'auto' : '0';
    stage.style.marginRight = scale === 1 ? 'auto' : '0';
  }

  /* ------------------------------------------------------------------ code */

  function renderCode() {
    var htmlResult = Highlight.highlight(state.savedHtml, 'html');
    el('html-code').innerHTML = htmlResult.html;
    var toonResult = Highlight.highlight(state.toon, 'toon');
    el('toon-code').innerHTML = toonResult.html;
    state.highlightSkipped = !htmlResult.highlighted || !toonResult.highlighted;
  }

  function updateCodeMeta() {
    var fonts = state.payload.fonts || {};
    var isHtml = state.tab === 'html';
    var source = isHtml ? state.savedHtml : state.toon;
    var parts = [formatBytes(byteLength(source))];
    if (fonts.primary) {
      parts.push('font <b>' + escapeHtml(fonts.primary) + '</b>' + (fonts.primaryLoadable ? '' : ' (not loadable)'));
    }
    if (state.highlightSkipped && source.length > Highlight.SIZE_LIMIT) {
      parts.push('highlighting skipped (large)');
    }
    el('code-meta').innerHTML = parts.join(' · ');
  }

  /* -------------------------------------------------------------------- tabs */

  function selectTab(name) {
    state.tab = name;
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (tab) {
      tab.classList.toggle('sel', tab.dataset.tab === name);
    });
    el('preview-pane').classList.toggle('sel', name === 'preview');
    el('html-pane').classList.toggle('sel', name === 'html');
    el('toon-pane').classList.toggle('sel', name === 'toon');
    el('preview-tools').classList.toggle('hidden', name !== 'preview');
    el('code-tools').classList.toggle('hidden', name === 'preview');
    if (name === 'preview') fitFrame();
    else updateCodeMeta();
  }

  /* --------------------------------------------------------------- download */

  /**
   * Downloads go through a blob URL: chrome.downloads.download rejects data:
   * URLs from extension pages, and a blob keeps large exports off the stack.
   * The absolute path is then copied so it can be pasted straight into a prompt.
   */
  function download(filename, content, mime) {
    return new Promise(function (resolve) {
      var blob = content instanceof Uint8Array
        ? new Blob([content], { type: mime })
        : new Blob([content], { type: mime + ';charset=utf-8' });
      var url = URL.createObjectURL(blob);
      chrome.downloads.download({ url: url, filename: filename, saveAs: false }, function (id) {
        if (chrome.runtime.lastError || id == null) {
          URL.revokeObjectURL(url);
          toast('Download failed: ' + ((chrome.runtime.lastError || {}).message || 'unknown'), true);
          resolve(null);
          return;
        }
        // The path only exists once the download completes.
        var poll = setInterval(function () {
          chrome.downloads.search({ id: id }, function (items) {
            var item = items && items[0];
            if (!item) return;
            if (item.state === 'complete') {
              clearInterval(poll);
              URL.revokeObjectURL(url);
              resolve(item.filename || filename);
            } else if (item.state === 'interrupted') {
              clearInterval(poll);
              URL.revokeObjectURL(url);
              resolve(null);
            }
          });
        }, 120);
        setTimeout(function () { clearInterval(poll); URL.revokeObjectURL(url); }, 8000);
      });
    });
  }

  async function copyPath(path) {
    if (!path) return false;
    try {
      await navigator.clipboard.writeText(path);
      return true;
    } catch (_) {
      // Fall back for contexts where the async clipboard is unavailable.
      try {
        var area = document.createElement('textarea');
        area.value = path;
        area.setAttribute('readonly', '');
        area.style.cssText = 'position:fixed;left:-9999px;top:0';
        document.body.appendChild(area);
        area.select();
        var ok = document.execCommand('copy');
        document.body.removeChild(area);
        return ok;
      } catch (_) {
        return false;
      }
    }
  }

  async function saveOne(filename, content, mime) {
    var path = await download(filename, content, mime);
    if (!path) return null;
    var copied = await copyPath(path);
    toast(copied ? 'Saved · path copied → ' + path : 'Saved → ' + path);
    return path;
  }

  async function saveBoth() {
    var htmlPath = await download('preview.html', state.savedHtml, 'text/html');
    var toonPath = await download('component.toon', state.toon, 'text/plain');
    var path = htmlPath || toonPath;
    if (!path) return;
    var copied = await copyPath(path);
    toast(copied ? 'Saved both · path copied → ' + path : 'Saved both → ' + path);
  }

  /**
   * Fonts zip. Entry names are the same relative paths the SAVED html
   * references, so unzipping next to it makes the export render offline.
   * Anything that failed at capture time gets one late retry — tokenized CDN
   * URLs routinely expire between capture and save.
   */
  async function saveFonts() {
    var faces = state.payload.fontFaces || [];
    var binaries = state.payload.fontBinaries || [];
    var byUrl = {};
    binaries.forEach(function (binary) { if (binary && binary.ok) byUrl[binary.url] = binary; });

    var retried = 0;
    for (var i = 0; i < faces.length; i += 1) {
      var face = faces[i];
      if (byUrl[face.url] || face.inline) continue;
      var fresh = await sendMessage({
        type: 'CHEATER_FETCH_FONT', url: face.url, path: face.path, mime: face.mime
      });
      if (fresh && fresh.ok) { byUrl[face.url] = fresh; retried += 1; }
    }

    var files = [];
    var seen = {};
    faces.forEach(function (face) {
      var binary = byUrl[face.url];
      if (!binary || seen[face.path]) return;
      seen[face.path] = true;
      files.push({ name: face.path, base64: binary.base64 });
    });

    if (!files.length) { toast('No font binaries available to zip', true); return; }

    var bytes = Zip.build(files);
    var path = await download('preview-fonts.zip', bytes, 'application/zip');
    if (!path) return;
    var copied = await copyPath(path);
    toast((copied ? 'Saved ' : 'Saved ') + files.length + ' font(s)' +
      (retried ? ' (' + retried + ' re-fetched)' : '') + ' → ' + path);
  }

  function sendMessage(message) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage(message, function (response) {
          if (chrome.runtime.lastError) resolve(null);
          else resolve(response);
        });
      } catch (_) { resolve(null); }
    });
  }

  /**
   * Build every view from state.payload. Shared by the initial boot and by
   * opening an entry from history, so a reopened capture goes through exactly the
   * same path as a fresh one.
   */
  async function renderPayload() {
    var nodeCount = (state.payload.diagnostics || {}).nodes || 0;
    var scale = nodeCount ? nodeCount.toLocaleString() + ' nodes' : '';

    setStage('Building HTML', 25, scale);
    await paint();
    state.savedHtml = HtmlWriter.build(state.payload, { fontMode: 'relative', surface: 'auto' });

    setStage('Building TOON', 45, formatBytes(byteLength(state.savedHtml)) + ' of HTML');
    await paint();
    state.toon = ToonWriter.toToon(state.payload);

    setStage('Diagnostics', 58, formatBytes(byteLength(state.toon)) + ' of TOON');
    await paint();
    renderDiagnostics();

    setStage('Highlighting source', 72,
      state.savedHtml.length > Highlight.SIZE_LIMIT ? 'too large — showing plain source' : '');
    await paint();
    renderCode();

    setStage('Rendering preview', 90);
    await paint();
    renderPreview();

    setStage('Ready', 100);

    var url = state.payload.url || '';
    el('src').innerHTML = url
      ? '<a href="' + escapeHtml(url) + '" target="_blank" rel="noreferrer">' + escapeHtml(url) + '</a>'
      : '<span class="dim">unknown source</span>';

    var bundled = (state.payload.diagnostics || {}).fontsBundled || 0;
    var fontButton = el('save-fonts');
    fontButton.textContent = 'Download fonts (' + bundled + ')';
    fontButton.classList.toggle('hidden', bundled === 0);
  }

  /* ---------------------------------------------------------------- history */

  function timeAgo(ms) {
    var seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (seconds < 60) return seconds + 's ago';
    if (seconds < 3600) return Math.round(seconds / 60) + 'm ago';
    if (seconds < 86400) return Math.round(seconds / 3600) + 'h ago';
    return Math.round(seconds / 86400) + 'd ago';
  }

  async function renderHistory() {
    var response = await sendMessage({ type: 'CHEATER_HISTORY_LIST' });
    var rows = el('hist-rows');

    if (!response || !response.ok) {
      rows.innerHTML = '<div class="hist-empty">History unavailable' +
        (response && response.reason ? ': ' + escapeHtml(response.reason) : '') + '</div>';
      return;
    }
    if (!response.entries.length) {
      rows.innerHTML = '<div class="hist-empty">No captures recorded yet. ' +
        'The last 10 exports are kept here.</div>';
      return;
    }

    rows.innerHTML = response.entries.map(function (entry) {
      var isCurrent = entry.id === state.exportId;
      var size = entry.width && entry.height ? entry.width + '×' + entry.height : '';
      return '<div class="hrow' + (isCurrent ? ' current' : '') + '" data-id="' + escapeHtml(entry.id) + '">' +
        '<span class="when">' + escapeHtml(timeAgo(entry.createdAt)) + '</span>' +
        '<span class="what">' + escapeHtml(entry.label || 'selection') + '</span>' +
        '<span class="where">' + escapeHtml(entry.url || '') + '</span>' +
        '<span class="dim">' + escapeHtml(size) + '</span>' +
        '<span class="dim">' + (entry.nodes || 0) + ' nodes</span>' +
        '<span class="dim">' + formatBytes(entry.bytes || 0) + '</span>' +
        '<span class="acts">' +
          (isCurrent ? '<button disabled>Open</button>'
                     : '<button class="open-btn" data-act="open">Open</button>') +
          '<button data-act="delete">Delete</button>' +
        '</span></div>';
    }).join('');
  }

  async function openHistoryEntry(id) {
    var response = await sendMessage({ type: 'CHEATER_HISTORY_GET', id: id });
    if (!response || !response.ok || !response.payload) {
      toast('Could not open that capture' + (response && response.reason ? ': ' + response.reason : ''), true);
      return false;
    }
    // Reset the loading overlay so the staged progress is visible again.
    el('loading').classList.remove('done');
    state.payload = response.payload;
    state.exportId = id;
    await renderPayload();
    finishStages();

    // Get out of the way: you opened a capture to look at it, and the panel
    // covers the preview. It re-renders (with the new "current" marker) whenever
    // it is opened again, so nothing is stale.
    el('hist').classList.remove('open');
    el('hist-btn').classList.remove('on');

    selectTab('preview');
    toast('Opened capture from history');
    return true;
  }

  /* ------------------------------------------------------------------- boot */

  function showEmpty(message) {
    finishStages();
    document.querySelector('.panes').innerHTML =
      '<div class="empty"><b>No capture</b><div>' + escapeHtml(message) + '</div></div>';
    el('diag').classList.add('hidden');
    document.querySelector('.ftr').classList.add('hidden');
    document.querySelector('.tabs').classList.add('hidden');
    // #hist deliberately stays visible: with no capture loaded, history is the
    // only thing on this page worth interacting with.
  }

  async function boot() {
    el('ver').textContent = 'v' + chrome.runtime.getManifest().version;

    var params = new URLSearchParams(location.search);
    var historyParam = params.get('history');

    // Opened from the popup or the history shortcut rather than from a capture.
    if (historyParam) {
      finishStages();
      if (historyParam !== 'list') {
        var opened = await openHistoryEntry(historyParam);
        if (opened) return;
      }
      showEmpty('Pick a capture from History above.');
      el('hist').classList.add('open');
      el('hist-btn').classList.add('on');
      await renderHistory();
      return;
    }

    state.exportId = params.get('id');
    if (!state.exportId) { showEmpty('No export id in the URL.'); return; }

    setStage('Reading capture', 8);
    await paint();
    var response = await sendMessage({ type: 'CHEATER_GET_PAYLOAD', id: state.exportId });
    if (!response || !response.ok || !response.payload) {
      showEmpty('The capture payload has expired. Re-run the export from the page.');
      return;
    }
    state.payload = response.payload;

    // The worker's copy is only needed until now.
    sendMessage({ type: 'CHEATER_RELEASE_PAYLOAD', id: state.exportId });

    await renderPayload();

    var bundled = (state.payload.diagnostics || {}).fontsBundled || 0;
    var fontButton = el('save-fonts');
    if (bundled > 0) {
      fontButton.textContent = 'Download fonts (' + bundled + ')';
      fontButton.classList.remove('hidden');
    }

    // The preview iframe reports back through its load handler; hide the overlay
    // now that everything measurable is done.
    finishStages();

    // Diagnostics start open when something needs attention.
    var diag = state.payload.diagnostics || {};
    var fonts = state.payload.fonts || {};
    if (diag.dropped || diag.fontFailures || diag.canvasPlaceholders || diag.imagesDropped ||
        (fonts.primary && !fonts.primaryLoadable)) {
      el('diag').classList.add('open');
    }
  }

  /* ------------------------------------------------------------------ wiring */

  el('hist-btn').addEventListener('click', async function () {
    var panel = el('hist');
    var open = !panel.classList.contains('open');
    panel.classList.toggle('open', open);
    el('hist-btn').classList.toggle('on', open);
    if (open) await renderHistory();
    if (state.tab === 'preview') requestAnimationFrame(fitFrame);
  });

  el('hist-close').addEventListener('click', function () {
    el('hist').classList.remove('open');
    el('hist-btn').classList.remove('on');
    if (state.tab === 'preview') requestAnimationFrame(fitFrame);
  });

  el('hist-clear').addEventListener('click', async function () {
    await sendMessage({ type: 'CHEATER_HISTORY_DELETE' });
    await renderHistory();
    toast('History cleared');
  });

  el('hist-rows').addEventListener('click', async function (event) {
    var button = event.target.closest('button[data-act]');
    if (!button) return;
    var row = button.closest('.hrow');
    if (!row) return;
    if (button.dataset.act === 'open') { await openHistoryEntry(row.dataset.id); return; }
    await sendMessage({ type: 'CHEATER_HISTORY_DELETE', id: row.dataset.id });
    await renderHistory();
  });

  el('diag-bar').addEventListener('click', function () {
    el('diag').classList.toggle('open');
    if (state.tab === 'preview') requestAnimationFrame(fitFrame);
  });

  document.querySelectorAll('.tab').forEach(function (tab) {
    tab.addEventListener('click', function () { selectTab(tab.dataset.tab); });
  });

  el('width-seg').addEventListener('click', function (event) {
    var button = event.target.closest('button');
    if (!button) return;
    state.width = button.dataset.w;
    el('width-seg').querySelectorAll('button').forEach(function (b) {
      b.classList.toggle('sel', b === button);
    });
    fitFrame();
  });

  el('surface-seg').addEventListener('click', function (event) {
    var button = event.target.closest('button');
    if (!button) return;
    state.surface = button.dataset.surface;
    el('surface-seg').querySelectorAll('button').forEach(function (b) {
      b.classList.toggle('sel', b === button);
    });
    el('preview-pane').classList.toggle('light', state.surface === 'light');
    renderPreview();
  });

  el('frame').addEventListener('load', function () {
    fitFrame();
    // Content can settle after load (webfont swap changes text height).
    setTimeout(fitFrame, 120);
    setTimeout(fitFrame, 600);
  });

  el('copy').addEventListener('click', async function () {
    var source = state.tab === 'toon' ? state.toon : state.savedHtml;
    var ok = await copyPath(source);
    toast(ok ? 'Copied ' + state.tab.toUpperCase() + ' to clipboard' : 'Copy failed', !ok);
  });

  el('save-html').addEventListener('click', function () {
    saveOne('preview.html', state.savedHtml, 'text/html');
  });
  el('save-toon').addEventListener('click', function () {
    saveOne('component.toon', state.toon, 'text/plain');
  });
  el('save-both').addEventListener('click', saveBoth);
  el('save-fonts').addEventListener('click', saveFonts);

  window.addEventListener('resize', function () {
    if (state.tab === 'preview') fitFrame();
  });

  boot();
})();
