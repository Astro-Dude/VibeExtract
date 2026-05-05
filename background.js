// Background script for VibeExtract

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Content script requests to open the export tab
  if (message.type === 'OPEN_EXPORT_TAB') {
    const { toon, html, sourceURL, diagnostics, fontFaces } = message;

    // Pre-fetch any detected @font-face binaries here in the background
    // worker — content scripts can't reliably read cross-origin font URLs,
    // but the service worker has full host access via <all_urls>.
    fetchFontBinaries(fontFaces || []).then((fetchedFonts) => {
      chrome.storage.local.set({
        exportHTML: html,
        exportTOON: toon,
        exportSourceURL: sourceURL || '',
        exportDiagnostics: diagnostics || null,
        // Each entry: { family, weight, style, format, url, base64, ok, error? }
        exportFontFaces: fetchedFonts
      }, () => {
        chrome.tabs.create({ url: chrome.runtime.getURL('export.html') });
      });
    });

    sendResponse({ ok: true });
    return true;
  }

  // export.js asks the worker to fetch a single font URL — used as a
  // fallback if a font wasn't pre-fetched (e.g. tokenised CDN URL that
  // expired between OPEN_EXPORT_TAB and the user clicking Save).
  if (message.type === 'FETCH_FONT' && message.url) {
    fetchOneFont(message.url).then(sendResponse);
    return true;
  }

  // popup.js path: it gets the export response directly from the content
  // script and hands the font URLs over for the worker to fetch before
  // the export tab opens.
  if (message.type === 'PREFETCH_FONTS') {
    fetchFontBinaries(message.fontFaces || []).then((fontFaces) => {
      sendResponse({ fontFaces });
    });
    return true;
  }
});

async function fetchOneFont(url) {
  try {
    const res = await fetch(url, { credentials: 'omit' });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const buf = await res.arrayBuffer();
    return { ok: true, base64: arrayBufferToBase64(buf) };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

async function fetchFontBinaries(faces) {
  if (!faces.length) return [];
  // Fetch in parallel; one failed font shouldn't block the others.
  return Promise.all(faces.map(async (face) => {
    const result = await fetchOneFont(face.url);
    return { ...face, ...result };
  }));
}

function arrayBufferToBase64(buffer) {
  // Service workers don't have a one-liner; chunk to avoid stack overflows
  // on large fonts (>200 KB).
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}
