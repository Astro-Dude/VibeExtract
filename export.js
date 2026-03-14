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
chrome.storage.local.get(['exportHTML', 'exportTOON', 'exportSourceURL'], (data) => {
  htmlContent = data.exportHTML || '';
  toonContent = data.exportTOON || '';
  sourceUrl = data.exportSourceURL || '';

  // Show source url
  if (sourceUrl) {
    document.getElementById('source-url').textContent = sourceUrl;
  }

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
  chrome.storage.local.remove(['exportHTML', 'exportTOON', 'exportSourceURL']);
});

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
