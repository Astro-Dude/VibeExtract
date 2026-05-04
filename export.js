// ── State ──
let htmlContent = '';
let toonContent = '';
let sourceUrl = '';

// ── Elements ──
const tabs = document.querySelectorAll('.tab');
const panels = document.querySelectorAll('.panel');
const toast = document.getElementById('toast');
const toastText = document.getElementById('toast-text');

// ── Load data from storage ──
chrome.storage.local.get(['exportHTML', 'exportTOON', 'exportSourceURL', 'exportDiagnostics'], (data) => {
  htmlContent = data.exportHTML || '';
  toonContent = data.exportTOON || '';
  sourceUrl = data.exportSourceURL || '';
  const diagnostics = data.exportDiagnostics || null;

  // Show source url
  if (sourceUrl) {
    document.getElementById('source-url').textContent = sourceUrl;
  }

  renderDiagnostics(diagnostics);

  // Populate code views
  document.getElementById('html-code').textContent = htmlContent;
  document.getElementById('toon-code').textContent = toonContent;

  // Detect primary font from the exported CSS
  const primaryFont = detectPrimaryFont(htmlContent);
  const fontLabel = primaryFont ? primaryFont : 'System default';

  // Size + font info
  setMeta('html-meta', htmlContent.length, fontLabel);
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
  iframe.srcdoc = htmlContent;

  // Clean up storage after loading
  chrome.storage.local.remove(['exportHTML', 'exportTOON', 'exportSourceURL', 'exportDiagnostics']);
});

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

  if (d.primaryFont && !d.primaryFontWillLoad) {
    const fp = document.createElement('span');
    fp.className = 'diag-pill warn';
    fp.textContent = `font fallback: ${d.primaryFont}`;
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

  if (d.primaryFont && !d.primaryFontWillLoad) {
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
    const text = btn.dataset.copy === 'html' ? htmlContent : toonContent;
    navigator.clipboard.writeText(text).then(() => {
      btn.textContent = 'Copied';
      setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
    });
  });
});

// ── Downloads ──
document.getElementById('dl-html').addEventListener('click', () => downloadFile('html'));
document.getElementById('dl-toon').addEventListener('click', () => downloadFile('toon'));
document.getElementById('dl-both').addEventListener('click', () => {
  downloadFile('toon');
  // small delay so chrome doesn't swallow the second download
  setTimeout(() => downloadFile('html'), 120);
});

function downloadFile(type) {
  const isHTML = type === 'html';
  const content = isHTML ? htmlContent : toonContent;
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
