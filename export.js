// ── State ──
let htmlContent = '';        // Original captured HTML (no @font-face injected)
let toonContent = '';
let sourceUrl = '';
let fontFaces = [];          // [{ family, weight, style, format, url, base64?, ok? }]

// ── Elements ──
const tabs = document.querySelectorAll('.tab');
const panels = document.querySelectorAll('.panel');
const toast = document.getElementById('toast');
const toastText = document.getElementById('toast-text');

// ── Load data from storage ──
chrome.storage.local.get([
  'exportHTML', 'exportTOON', 'exportSourceURL', 'exportDiagnostics', 'exportFontFaces'
], (data) => {
  htmlContent = data.exportHTML || '';
  toonContent = data.exportTOON || '';
  sourceUrl = data.exportSourceURL || '';
  fontFaces = Array.isArray(data.exportFontFaces) ? data.exportFontFaces : [];
  const diagnostics = data.exportDiagnostics || null;

  // Show source url
  if (sourceUrl) {
    document.getElementById('source-url').textContent = sourceUrl;
  }

  // Stitch the bundled-fonts count into the diagnostics object so the warn
  // pill collapses ("font fallback") when we successfully fetched the font.
  if (diagnostics) {
    diagnostics.bundledFontCount = fontFaces.filter(f => f.ok).length;
    diagnostics.failedFontCount = fontFaces.filter(f => f.ok === false).length;
  }
  renderDiagnostics(diagnostics);

  // Reveal the "Download fonts" button only when we actually have bundled
  // font binaries to ship. The label includes the count so the user knows
  // how many files will be inside the zip.
  const fontsBtn = document.getElementById('dl-fonts');
  const fontsLabel = document.getElementById('dl-fonts-label');
  const okFonts = fontFaces.filter(f => f.ok && f.base64);
  if (okFonts.length > 0) {
    fontsBtn.hidden = false;
    if (fontsLabel) {
      fontsLabel.textContent = `Download fonts (${okFonts.length})`;
    }
  }

  // Populate code views — show the *download* HTML (relative font paths)
  // so users copying the textarea get a portable file. Preview uses a
  // separate version with inline data: URIs since `<iframe srcdoc>` has no
  // base URL for relative paths to resolve against.
  const downloadHtml = htmlWithFontFaces(htmlContent, 'relative');
  const previewHtml = htmlWithFontFaces(htmlContent, 'inline');

  document.getElementById('html-code').textContent = downloadHtml;
  document.getElementById('toon-code').textContent = toonContent;

  // Detect primary font from the exported CSS
  const primaryFont = detectPrimaryFont(htmlContent);
  const fontLabel = primaryFont ? primaryFont : 'System default';

  // Size + font info
  setMeta('html-meta', downloadHtml.length, fontLabel);
  setMeta('toon-meta', toonContent.length, fontLabel);

  // Preview iframe — auto-resize to content height
  const iframe = document.getElementById('preview-iframe');
  iframe.addEventListener('load', () => {
    try {
      const body = iframe.contentDocument.body;
      const html = iframe.contentDocument.documentElement;
      const height = Math.max(
        body.scrollHeight, body.offsetHeight,
        html.scrollHeight, html.offsetHeight
      );
      iframe.style.height = Math.max(height + 32, 400) + 'px';
    } catch (e) {
      // cross-origin fallback — keep min-height
    }
  });
  iframe.srcdoc = previewHtml;

  // Clean up storage after loading
  chrome.storage.local.remove([
    'exportHTML', 'exportTOON', 'exportSourceURL', 'exportDiagnostics', 'exportFontFaces'
  ]);
});

// Build the CSS @font-face block. Mode `inline` embeds woff2 binaries as
// data: URIs (works in srcdoc preview, no external files needed). Mode
// `relative` references sibling files like `./preview-CentraNo2-400.woff2`
// (smaller HTML, but the user must keep the saved files together).
function buildFontFaceBlock(faces, mode, fileNameFor) {
  let css = '';
  for (const face of faces) {
    if (!face.ok || !face.base64) continue;
    let src;
    if (mode === 'inline') {
      const mime = `font/${face.format === 'truetype' ? 'ttf' : face.format === 'opentype' ? 'otf' : face.format}`;
      src = `url('data:${mime};base64,${face.base64}') format('${face.format}')`;
    } else {
      const filename = fileNameFor(face);
      src = `url('./${filename}') format('${face.format}')`;
    }
    css += `@font-face { font-family: '${face.family}'; src: ${src}; font-weight: ${face.weight}; font-style: ${face.style}; font-display: swap; }\n`;
  }
  return css;
}

// Inject the @font-face block into the export HTML right after its
// `<style>` opening tag so captured classes can resolve their `font-family`
// to the bundled font instead of the system fallback.
function htmlWithFontFaces(html, mode) {
  const block = buildFontFaceBlock(fontFaces, mode, fontFileName);
  if (!block) return html;
  return html.replace(/(<style\b[^>]*>)/, `$1\n${block}`);
}

function fontFileName(face) {
  const safeFam = face.family.replace(/[^A-Za-z0-9]/g, '');
  const styleSuffix = face.style && face.style !== 'normal' ? `-${face.style}` : '';
  return `preview-${safeFam}-${face.weight}${styleSuffix}.${face.format === 'truetype' ? 'ttf' : face.format === 'opentype' ? 'otf' : face.format}`;
}

function renderDiagnostics(d) {
  const wrap = document.getElementById('diag');
  if (!d) return;
  wrap.hidden = false;

  const summary = document.getElementById('diag-summary');
  summary.innerHTML = '';

  const label = document.createElement('span');
  label.textContent = 'Diagnostics';
  summary.appendChild(label);

  const sel = document.createElement('span');
  sel.className = 'diag-pill';
  sel.textContent = `${d.selectionCount} selection${d.selectionCount === 1 ? '' : 's'}`;
  summary.appendChild(sel);

  if (d.wrapperCount > 0) {
    const wr = document.createElement('span');
    wr.className = 'diag-pill';
    wr.textContent = `${d.wrapperCount} parent-wrap${d.wrapperCount === 1 ? '' : 's'}`;
    summary.appendChild(wr);
  }

  if (d.filteredCount > 0 || d.emptySpansSkipped > 0) {
    const flt = document.createElement('span');
    flt.className = 'diag-pill warn';
    flt.textContent = `${d.filteredCount + d.emptySpansSkipped} dropped`;
    summary.appendChild(flt);
  }

  const styles = document.createElement('span');
  styles.className = 'diag-pill';
  styles.textContent = `${d.styleCount} styles`;
  summary.appendChild(styles);

  if (d.pseudoStyleCount > 0) {
    const ps = document.createElement('span');
    ps.className = 'diag-pill';
    ps.textContent = `${d.pseudoStyleCount} pseudo`;
    summary.appendChild(ps);
  }

  // Font status pill: show "N bundled" when we successfully fetched font
  // binaries; otherwise fall back to the legacy "font fallback: <name>"
  // warning when the primary font isn't loadable.
  if (d.bundledFontCount > 0) {
    const fp = document.createElement('span');
    fp.className = 'diag-pill';
    fp.textContent = `${d.bundledFontCount} font${d.bundledFontCount === 1 ? '' : 's'} bundled`;
    summary.appendChild(fp);
  } else if (d.primaryFont && !d.primaryFontWillLoad) {
    const fp = document.createElement('span');
    fp.className = 'diag-pill warn';
    fp.textContent = `font fallback: ${d.primaryFont}`;
    summary.appendChild(fp);
  }
  if (d.failedFontCount > 0) {
    const fp = document.createElement('span');
    fp.className = 'diag-pill warn';
    fp.textContent = `${d.failedFontCount} font fetch failed`;
    summary.appendChild(fp);
  }

  // Body: list each selection
  const body = document.getElementById('diag-body');
  body.innerHTML = '';

  if (d.filteredCount > 0 || d.emptySpansSkipped > 0) {
    const note = document.createElement('div');
    note.className = 'diag-row';
    note.style.color = '#fbbf24';
    note.innerHTML = `<span class="meta">Filtered out ${d.filteredCount} hidden node${d.filteredCount === 1 ? '' : 's'} and ${d.emptySpansSkipped} empty span${d.emptySpansSkipped === 1 ? '' : 's'} from descendants. Use Alt+Click for exact targeting if you want them included.</span>`;
    body.appendChild(note);
  }

  if (d.bundledFontCount > 0) {
    const note = document.createElement('div');
    note.className = 'diag-row';
    note.style.color = '#a1a1aa';
    note.innerHTML = `<span class="meta">Detected and bundled <strong>${d.bundledFontCount}</strong> @font-face binar${d.bundledFontCount === 1 ? 'y' : 'ies'} from the page. Use the <strong>Download fonts</strong> button to grab them as one zip; unzip it next to the saved .html so the page can render with the original font when opened offline.</span>`;
    body.appendChild(note);
  } else if (d.primaryFont && !d.primaryFontWillLoad) {
    const note = document.createElement('div');
    note.className = 'diag-row';
    note.style.color = '#fbbf24';
    note.innerHTML = `<span class="meta">Primary font <strong>${d.primaryFont}</strong> is not on Google Fonts and isn't being auto-loaded — the export will fall back to the system stack and text widths may differ from the original. Add the font manually if precise metrics matter.</span>`;
    body.appendChild(note);
  }

  if (!d.selections || d.selections.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'diag-row';
    empty.innerHTML = `<span class="meta">No top-level selections recorded.</span>`;
    body.appendChild(empty);
    return;
  }

  for (const s of d.selections) {
    const row = document.createElement('div');
    row.className = 'diag-row';

    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = `<${s.tag}>`;
    row.appendChild(tag);

    const meta = document.createElement('span');
    meta.className = 'meta';
    const cls = s.className ? `.${s.className.replace(/\s+/g, '.')}` : '';
    meta.textContent = `${cls} — ${s.w}×${s.h} at (${s.x}, ${s.y})`;
    row.appendChild(meta);

    if (s.wrapped) {
      const b = document.createElement('span');
      b.className = 'badge';
      b.textContent = 'wrapped';
      row.appendChild(b);
    }
    if (!s.kept) {
      const b = document.createElement('span');
      b.className = 'badge dropped';
      b.textContent = 'dropped';
      row.appendChild(b);
    }

    body.appendChild(row);
  }
}

// ── Tabs ──
tabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    tabs.forEach((t) => t.classList.remove('active'));
    panels.forEach((p) => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('panel-' + tab.dataset.tab).classList.add('active');
  });
});

// ── Copy buttons (inside code panels) ──
document.querySelectorAll('.copy-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const text = btn.dataset.copy === 'html'
      ? htmlWithFontFaces(htmlContent, 'relative')
      : toonContent;
    navigator.clipboard.writeText(text).then(() => {
      btn.textContent = 'Copied';
      setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
    });
  });
});

// ── Downloads ──
document.getElementById('dl-html').addEventListener('click', () => downloadFile('html'));
document.getElementById('dl-toon').addEventListener('click', () => downloadFile('toon'));
document.getElementById('dl-fonts').addEventListener('click', () => downloadFontsZip());
document.getElementById('dl-both').addEventListener('click', () => {
  downloadFile('toon');
  // small delay so chrome doesn't swallow the second download
  setTimeout(() => downloadFile('html'), 120);
});

function downloadFile(type) {
  const isHTML = type === 'html';
  // For the saved HTML use the relative-path @font-face block; the woff2
  // files come down as one separate "Download fonts" zip the user can
  // unzip alongside this HTML so we don't fire N parallel font downloads.
  const content = isHTML ? htmlWithFontFaces(htmlContent, 'relative') : toonContent;
  const filename = isHTML ? 'preview.html' : 'component.toon';
  const mime = isHTML ? 'text/html' : 'application/octet-stream';

  // Use chrome downloads API so we can get the real file path
  const blob = new Blob([content], { type: mime });
  const reader = new FileReader();
  reader.onload = () => {
    chrome.downloads.download({
      url: reader.result,
      filename: filename,
      saveAs: false,
      conflictAction: 'uniquify'
    }, (downloadId) => {
      if (!downloadId) return;
      // Watch for completion, then copy path to clipboard
      const listener = (delta) => {
        if (delta.id === downloadId && delta.state && delta.state.current === 'complete') {
          chrome.downloads.onChanged.removeListener(listener);
          chrome.downloads.search({ id: downloadId }, (results) => {
            if (results && results[0] && results[0].filename) {
              const filePath = results[0].filename;
              copyToClipboard(filePath).then(() => {
                showToast('Saved — path copied to clipboard');
              }).catch(() => {
                showToast('Saved to ' + filePath);
              });
            }
          });
        }
      };
      chrome.downloads.onChanged.addListener(listener);
    });
  };
  reader.readAsDataURL(blob);
}

// Build a single .zip containing every fetched font binary and trigger
// one download for it. The zip's entries match the relative `./preview-…`
// paths in the saved HTML's @font-face block, so unzipping alongside the
// saved HTML makes the page render with the real font.
function downloadFontsZip() {
  const ok = fontFaces.filter(f => f.ok && f.base64);
  if (ok.length === 0) {
    showToast('No bundled fonts to download');
    return;
  }
  const entries = ok.map(face => ({
    name: fontFileName(face),
    data: base64ToBytes(face.base64),
  }));
  const zipBytes = buildZip(entries);
  const blob = new Blob([zipBytes], { type: 'application/zip' });
  const reader = new FileReader();
  reader.onload = () => {
    chrome.downloads.download({
      url: reader.result,
      filename: 'preview-fonts.zip',
      saveAs: false,
      conflictAction: 'overwrite'
    }, (downloadId) => {
      if (!downloadId) {
        showToast('Font zip download failed');
        return;
      }
      const listener = (delta) => {
        if (delta.id === downloadId && delta.state && delta.state.current === 'complete') {
          chrome.downloads.onChanged.removeListener(listener);
          chrome.downloads.search({ id: downloadId }, (results) => {
            const path = results && results[0] && results[0].filename;
            if (path) {
              copyToClipboard(path).then(
                () => showToast(`Saved ${ok.length} font${ok.length === 1 ? '' : 's'} — path copied`),
                () => showToast(`Saved ${ok.length} font${ok.length === 1 ? '' : 's'} to ${path}`)
              );
            } else {
              showToast(`Saved ${ok.length} font${ok.length === 1 ? '' : 's'}`);
            }
          });
        }
      };
      chrome.downloads.onChanged.addListener(listener);
    });
  };
  reader.readAsDataURL(blob);
}

function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Minimal in-browser ZIP encoder (STORED, no compression). Enough to bundle
// a handful of font binaries; saves us shipping a JSZip dependency.
function buildZip(entries) {
  const enc = new TextEncoder();
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = enc.encode(entry.name);
    const data = entry.data;
    const crc = crc32(data);
    const size = data.length;

    // Local file header (30 bytes + name)
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);          // version needed
    lv.setUint16(6, 0, true);           // flags
    lv.setUint16(8, 0, true);           // method (stored)
    lv.setUint16(10, 0, true);          // mtime
    lv.setUint16(12, 0, true);          // mdate
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);          // extra length
    local.set(nameBytes, 30);
    localChunks.push(local, data);

    // Central directory entry (46 bytes + name)
    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);          // version made by
    cv.setUint16(6, 20, true);          // version needed
    cv.setUint16(8, 0, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);     // local header offset
    central.set(nameBytes, 46);
    centralChunks.push(central);

    offset += local.length + size;
  }

  const centralStart = offset;
  let centralSize = 0;
  for (const c of centralChunks) centralSize += c.length;

  // End-of-central-directory record (22 bytes)
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, centralStart, true);
  ev.setUint16(20, 0, true);

  let total = offset + centralSize + eocd.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const chunk of localChunks) { out.set(chunk, pos); pos += chunk.length; }
  for (const chunk of centralChunks) { out.set(chunk, pos); pos += chunk.length; }
  out.set(eocd, pos);
  return out;
}

// Standard CRC32/PKZIP polynomial 0xedb88320, table-based.
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c;
  }
  return table;
})();
function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ bytes[i]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ── Toast ──
let toastTimer = null;
function showToast(msg) {
  if (toastTimer) clearTimeout(toastTimer);
  toastText.textContent = msg;
  toast.classList.add('visible');
  toastTimer = setTimeout(() => {
    toast.classList.remove('visible');
  }, 2800);
}

// ── Helpers ──
function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  return (bytes / 1024).toFixed(1) + ' KB';
}

function setMeta(id, size, font) {
  const el = document.getElementById(id);
  el.innerHTML = '';
  const sizeSpan = document.createElement('span');
  sizeSpan.textContent = formatSize(size);
  el.appendChild(sizeSpan);

  const dot = document.createTextNode(' · ');
  el.appendChild(dot);

  const label = document.createTextNode('Font: ');
  el.appendChild(label);

  const fontSpan = document.createElement('span');
  fontSpan.className = 'font-name';
  fontSpan.textContent = font;
  el.appendChild(fontSpan);
}

function copyToClipboard(text) {
  // Try the modern API first, fall back to execCommand
  return navigator.clipboard.writeText(text).catch(() => {
    return new Promise((resolve, reject) => {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      try {
        document.execCommand('copy');
        resolve();
      } catch (e) {
        reject(e);
      } finally {
        document.body.removeChild(ta);
      }
    });
  });
}

function detectPrimaryFont(html) {
  // Pull all font-family declarations from the CSS inside the HTML
  const fontRegex = /font-family:\s*([^;}"]+)/gi;
  const counts = {};
  let match;

  while ((match = fontRegex.exec(html)) !== null) {
    // Grab the first font in the stack (the primary one)
    const raw = match[1].trim();
    const first = raw.split(',')[0].trim().replace(/["']/g, '');

    // Skip generic keywords, icon fonts, and the body default
    const lower = first.toLowerCase();
    if (['sans-serif', 'serif', 'monospace', 'cursive', 'fantasy', 'inherit', 'initial',
         '-apple-system', 'blinkmacsystemfont', 'material icons', 'material symbols outlined',
         'google material icons', 'fontawesome'].includes(lower)) continue;
    if (lower.includes('material') || lower.includes('icon') || lower.includes('fontawesome')) continue;

    counts[first] = (counts[first] || 0) + 1;
  }

  // Return the most frequently used font
  let best = null;
  let bestCount = 0;
  for (const [font, count] of Object.entries(counts)) {
    if (count > bestCount) {
      best = font;
      bestCount = count;
    }
  }
  return best;
}
