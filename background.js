/**
 * Cheater — service worker.
 *
 * Three jobs:
 *   1. Fan commands out to every frame of a tab, and collect capture payloads
 *      back from whichever frames actually hold a selection (webNavigation is
 *      in the permission set purely to enumerate those frames).
 *   2. Fetch @font-face binaries. A content script cannot read font files
 *      cross-origin reliably; the service worker can, because extension fetches
 *      carry the extension's host permissions.
 *   3. Hand the finished payload to a freshly opened export tab.
 *
 * The payload handoff deliberately uses an in-memory Map rather than
 * chrome.storage.local: the permission set has no "unlimitedStorage", and a
 * full-page capture with inlined bitmaps blows the 10 MB quota. A
 * chrome.storage.session mirror covers the case where the worker is torn down
 * between opening the tab and the tab asking for its payload.
 */

'use strict';

const PENDING = new Map(); // exportId -> payload
const MIRROR_LIMIT = 4 * 1024 * 1024; // don't even try to mirror above this
const FRAME_TIMEOUT_MS = 4000;
const FONT_TIMEOUT_MS = 10000;

let exportSeq = 0;

/* ========================================================================== *
 * SECTION: small utilities
 * ========================================================================== */

/**
 * ArrayBuffer -> base64, in 32 KB chunks.
 * String.fromCharCode(...bytes) on a whole font file overflows the argument
 * stack (RangeError) somewhere north of ~100 KB, and font files are routinely
 * 200 KB+, so chunking here is not premature.
 */
function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000;
  let out = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(out);
}

function withTimeout(promise, ms, onTimeout) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; resolve(onTimeout); }
    }, ms);
    promise.then(
      (value) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } },
      () => { if (!settled) { settled = true; clearTimeout(timer); resolve(onTimeout); } }
    );
  });
}

function sendToFrame(tabId, frameId, message) {
  return withTimeout(
    chrome.tabs.sendMessage(tabId, message, { frameId }).catch(() => null),
    FRAME_TIMEOUT_MS,
    null
  );
}

/* ========================================================================== *
 * SECTION: frame fan-out
 * ========================================================================== */

async function listFrames(tabId) {
  try {
    const frames = await chrome.webNavigation.getAllFrames({ tabId });
    if (frames && frames.length) return frames.map((f) => f.frameId);
  } catch (_) { /* fall through */ }
  return [0];
}

/**
 * Broadcast to every frame. Frames with no content script (cross-origin
 * restricted, about:blank, sandboxed) reject the message or never answer; both
 * resolve to null here and are skipped silently, which is the whole point.
 */
async function broadcast(tabId, message) {
  const frameIds = await listFrames(tabId);
  const replies = await Promise.all(
    frameIds.map((frameId) =>
      sendToFrame(tabId, frameId, message).then((reply) => ({ frameId, reply }))
    )
  );
  return replies.filter((r) => r.reply != null);
}

/* ========================================================================== *
 * SECTION: multi-frame merge
 * ========================================================================== */

/**
 * Two frames both name their first shared style ".s1". Merging their nodes into
 * one document would silently cross-wire the styles, so every frame after the
 * first gets its class table renamed (s1 -> f1s1) before the merge.
 */
function remapClasses(payload, prefix) {
  const map = new Map();
  const rename = (bag) => {
    if (!bag) return bag;
    const next = {};
    for (const key of Object.keys(bag)) {
      const fresh = prefix + key;
      map.set(key, fresh);
      next[fresh] = bag[key];
    }
    return next;
  };

  payload.styles = rename(payload.styles);
  payload.pseudos = rename(payload.pseudos);
  payload.wrappers = rename(payload.wrappers);

  const swap = (cls) => map.get(cls) || cls;

  // Hover selectors are strings like ".s2:hover .s7" — rewrite every token.
  if (Array.isArray(payload.hovers)) {
    for (const rule of payload.hovers) {
      rule.sel = rule.sel.replace(/\.([spw]\d+)\b/g, (m, name) => '.' + swap(name));
    }
  }

  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node.cls)) node.cls = node.cls.map(swap);
    if (Array.isArray(node.ch)) node.ch.forEach(walk);
  };
  (payload.nodes || []).forEach(walk);

  return payload;
}

function mergePayloads(entries) {
  const primary = entries[0].reply;
  if (entries.length === 1) return primary;

  const merged = primary;
  merged.diagnostics = merged.diagnostics || {};
  merged.diagnostics.frames = entries.length;

  for (let i = 1; i < entries.length; i += 1) {
    const extra = remapClasses(entries[i].reply, 'f' + i);
    Object.assign(merged.styles, extra.styles);
    Object.assign(merged.pseudos, extra.pseudos);
    Object.assign(merged.wrappers, extra.wrappers);
    merged.hovers = (merged.hovers || []).concat(extra.hovers || []);
    merged.nodes = (merged.nodes || []).concat(extra.nodes || []);
    merged.fontFaces = (merged.fontFaces || []).concat(extra.fontFaces || []);

    // Diagnostics are additive counters plus a per-selection list.
    const a = merged.diagnostics;
    const b = extra.diagnostics || {};
    for (const key of Object.keys(b)) {
      if (typeof b[key] === 'number') a[key] = (a[key] || 0) + b[key];
    }
    a.selections = (a.selections || []).concat(b.selections || []);

    // The icon report is a map, so the numeric merge above skips it.
    a.iconFamilies = a.iconFamilies || {};
    for (const key of Object.keys(b.iconFamilies || {})) {
      a.iconFamilies[key] = (a.iconFamilies[key] || 0) + b.iconFamilies[key];
    }

    // Font usage merges by family so the Google Fonts links stay deduplicated.
    mergeFontUsage(merged.fonts, extra.fonts);
  }

  return merged;
}

function mergeFontUsage(into, from) {
  if (!into || !from) return;
  into.google = into.google || [];
  for (const family of from.google || []) {
    const existing = into.google.find((f) => f.family === family.family);
    if (!existing) { into.google.push(family); continue; }
    existing.weights = Array.from(new Set(existing.weights.concat(family.weights))).sort((a, b) => a - b);
    existing.italics = Array.from(new Set(existing.italics.concat(family.italics)));
  }
  into.icons = Array.from(new Set((into.icons || []).concat(from.icons || [])));
}

/* ========================================================================== *
 * SECTION: font binaries
 * ========================================================================== */

async function fetchFontBinary(descriptor) {
  const result = { url: descriptor.url, path: descriptor.path, ok: false };
  try {
    const response = await withTimeout(
      fetch(descriptor.url, { credentials: 'omit', redirect: 'follow' }),
      FONT_TIMEOUT_MS,
      null
    );
    if (!response) { result.error = 'timeout'; return result; }
    if (!response.ok) { result.error = 'http ' + response.status; return result; }
    const buffer = await response.arrayBuffer();
    if (!buffer || !buffer.byteLength) { result.error = 'empty'; return result; }
    result.ok = true;
    result.bytes = buffer.byteLength;
    result.base64 = bufferToBase64(buffer);
    result.mime = descriptor.mime || 'font/woff2';
  } catch (error) {
    result.error = String((error && error.message) || error);
  }
  return result;
}

/**
 * One font failing must never block the others, hence per-descriptor try/catch
 * plus Promise.all over results that always resolve.
 */
async function fetchFontBinaries(descriptors) {
  const unique = [];
  const seen = new Set();
  for (const d of descriptors || []) {
    if (!d || !d.url || seen.has(d.url)) continue;
    seen.add(d.url);
    unique.push(d);
  }
  if (!unique.length) return [];
  return Promise.all(unique.map(fetchFontBinary));
}

/* ========================================================================== *
 * SECTION: export orchestration
 * ========================================================================== */

function describeError(error) {
  if (!error) return 'unknown error';
  if (typeof error === 'string') return error;
  return error.message || String(error);
}

/**
 * Every async message handler MUST go through this.
 *
 * A rejected promise in `handler().then(sendResponse)` never calls sendResponse,
 * so Chrome closes the port and the caller receives `undefined` — which the page
 * can only report as a bare "Export failed" with no cause, in a worker that has
 * no console anyone is watching. Answering with the reason instead is the
 * difference between a bug report and a diagnosis.
 */
function guard(promise, label) {
  return promise.catch((error) => {
    const reason = describeError(error);
    console.error('[Cheater] ' + label + ' failed:', error);
    return { ok: false, reason };
  });
}

async function runExport(tabId, payloadFromSender) {
  let payload = payloadFromSender;

  // Validate before touching it: `payload.fontFaces` on an undefined payload is a
  // TypeError, which used to disappear into the closed port described above.
  if (payload && (!payload.nodes || !payload.nodes.length)) {
    return { ok: false, reason: 'the capture contained no nodes' };
  }

  if (!payload) {
    const entries = await broadcast(tabId, { type: 'CHEATER_COLLECT' });
    if (!entries.length) {
      await broadcast(tabId, { type: 'CHEATER_TOAST', text: 'Nothing selected' });
      return { ok: false, reason: 'empty' };
    }
    payload = mergePayloads(entries);
  }

  const binaries = await fetchFontBinaries(payload.fontFaces);
  payload.fontBinaries = binaries;
  payload.diagnostics = payload.diagnostics || {};
  payload.diagnostics.fontsBundled = binaries.filter((b) => b.ok).length;
  payload.diagnostics.fontFailures = binaries.filter((b) => !b.ok).length;

  const id = 'cx' + Date.now().toString(36) + (exportSeq += 1).toString(36);
  PENDING.set(id, payload);

  // Recorded before the tab opens, and deliberately not awaited: history is a
  // convenience and must never be able to delay or fail an export.
  saveHistory(id, payload);

  // Best-effort mirror so a worker restart between tab-open and tab-read is
  // survivable. Deliberately silent: it is a fallback, not a requirement.
  try {
    const serialized = JSON.stringify(payload);
    if (serialized.length < MIRROR_LIMIT) {
      await chrome.storage.session.set({ ['payload:' + id]: serialized });
    }
  } catch (_) { /* over quota — in-memory copy still serves the common path */ }

  try {
    await chrome.tabs.create({
      url: chrome.runtime.getURL('export.html') + '?id=' + encodeURIComponent(id)
    });
  } catch (error) {
    PENDING.delete(id);
    return { ok: false, reason: 'could not open the export tab: ' + describeError(error) };
  }

  return { ok: true, id };
}

async function releasePayload(id) {
  PENDING.delete(id);
  try { await chrome.storage.session.remove('payload:' + id); } catch (_) { /* noop */ }
}

async function readPayload(id) {
  if (PENDING.has(id)) return PENDING.get(id);
  try {
    const stored = await chrome.storage.session.get('payload:' + id);
    const raw = stored['payload:' + id];
    if (raw) return JSON.parse(raw);
  } catch (_) { /* noop */ }
  return null;
}

/* ========================================================================== *
 * SECTION: capture history
 *
 * The last HISTORY_LIMIT exports, kept so a capture is never lost to a closed
 * tab. IndexedDB rather than chrome.storage.local: the permission set has no
 * "unlimitedStorage", so storage.local caps out at 10 MB, and a handful of
 * captures with inlined bitmaps clears that easily.
 *
 * Two stores on purpose. `meta` holds the small summary rows so the history list
 * can be drawn without deserializing megabytes of payload; `blob` holds the
 * payloads, read only when an entry is actually opened.
 * ========================================================================== */

const HISTORY_DB = 'cheater-history';
const HISTORY_LIMIT = 10;
const HISTORY_BYTE_BUDGET = 60 * 1024 * 1024;   // disk is cheap, but not free

function openHistoryDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(HISTORY_DB, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'id' }).createIndex('createdAt', 'createdAt');
      }
      if (!db.objectStoreNames.contains('blob')) {
        db.createObjectStore('blob', { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('could not open history'));
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('history write failed'));
    tx.onabort = () => reject(tx.error || new Error('history write aborted'));
  });
}

function reqValue(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Strictly increasing timestamp.
 *
 * Date.now() alone is not enough: two exports in the same millisecond (easy with
 * the full-page shortcut, or any rapid pair) get identical values, ordering then
 * falls back to IndexedDB's key order — which is lexicographic, so "h10" sorts
 * before "h2" — and pruning "the oldest" starts discarding the wrong entries,
 * including ones just created. Staying anchored to the wall clock keeps the
 * ordering meaningful across worker restarts.
 */
let lastStamp = 0;
function nextStamp() {
  lastStamp = Math.max(Date.now(), lastStamp + 1);
  return lastStamp;
}

/** Summary row for the history list — small enough to read many of at once. */
function historyMeta(id, payload, bytes) {
  const diag = payload.diagnostics || {};
  const first = (diag.selections || [])[0] || {};
  return {
    id,
    createdAt: nextStamp(),
    url: payload.url || '',
    title: payload.title || '',
    bytes: bytes,
    topLevel: diag.topLevel || 0,
    nodes: diag.nodes || 0,
    label: (first.tag || 'selection') + (first.classes ? '.' + first.classes : ''),
    width: first.w || 0,
    height: first.h || 0,
    primaryFont: (payload.fonts && payload.fonts.primary) || ''
  };
}

async function saveHistory(id, payload) {
  let db;
  try { db = await openHistoryDb(); } catch (_) { return; }   // history is a luxury
  try {
    const serialized = JSON.stringify(payload);
    const meta = historyMeta(id, payload, serialized.length);

    const write = db.transaction(['meta', 'blob'], 'readwrite');
    write.objectStore('meta').put(meta);
    write.objectStore('blob').put({ id, payload: serialized });
    await txDone(write);

    await pruneHistory(db);
  } catch (error) {
    console.warn('[Cheater] could not record history:', error);
  } finally {
    db.close();
  }
}

/** Keep the newest HISTORY_LIMIT entries, and stay under the byte budget. */
async function pruneHistory(db) {
  const read = db.transaction('meta', 'readonly');
  const all = await reqValue(read.objectStore('meta').getAll());
  all.sort((a, b) => (b.createdAt - a.createdAt) || (a.id < b.id ? 1 : -1));

  const doomed = all.slice(HISTORY_LIMIT).map((m) => m.id);
  let running = 0;
  for (const meta of all.slice(0, HISTORY_LIMIT)) {
    running += meta.bytes || 0;
    if (running > HISTORY_BYTE_BUDGET) doomed.push(meta.id);
  }
  if (!doomed.length) return;

  const write = db.transaction(['meta', 'blob'], 'readwrite');
  for (const id of doomed) {
    write.objectStore('meta').delete(id);
    write.objectStore('blob').delete(id);
  }
  await txDone(write);
}

async function listHistory() {
  let db;
  try { db = await openHistoryDb(); } catch (error) { return { ok: false, reason: describeError(error) }; }
  try {
    const read = db.transaction('meta', 'readonly');
    const all = await reqValue(read.objectStore('meta').getAll());
    all.sort((a, b) => (b.createdAt - a.createdAt) || (a.id < b.id ? 1 : -1));
    return { ok: true, entries: all.slice(0, HISTORY_LIMIT) };
  } catch (error) {
    return { ok: false, reason: describeError(error) };
  } finally {
    db.close();
  }
}

async function getHistoryPayload(id) {
  let db;
  try { db = await openHistoryDb(); } catch (error) { return { ok: false, reason: describeError(error) }; }
  try {
    const read = db.transaction('blob', 'readonly');
    const record = await reqValue(read.objectStore('blob').get(id));
    if (!record) return { ok: false, reason: 'that capture is no longer in history' };
    return { ok: true, payload: JSON.parse(record.payload) };
  } catch (error) {
    return { ok: false, reason: describeError(error) };
  } finally {
    db.close();
  }
}

async function openHistoryTab(id) {
  const target = chrome.runtime.getURL('export.html') +
    '?history=' + encodeURIComponent(id || 'list');
  try {
    await chrome.tabs.create({ url: target });
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: describeError(error) };
  }
}

async function deleteHistory(id) {
  let db;
  try { db = await openHistoryDb(); } catch (error) { return { ok: false, reason: describeError(error) }; }
  try {
    const write = db.transaction(['meta', 'blob'], 'readwrite');
    if (id) {
      write.objectStore('meta').delete(id);
      write.objectStore('blob').delete(id);
    } else {
      write.objectStore('meta').clear();
      write.objectStore('blob').clear();
    }
    await txDone(write);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: describeError(error) };
  } finally {
    db.close();
  }
}

/* ========================================================================== *
 * SECTION: tab screenshot (pixel recovery)
 * ========================================================================== */

/**
 * Screenshot the visible viewport so the content script can crop out the parts of
 * a capture it could not reproduce any other way.
 *
 * This is the universal fallback behind everything that is structurally
 * unreadable: a cross-origin-tainted canvas, a closed shadow root, a cross-origin
 * iframe, an icon whose font cannot travel, an external SVG sprite reference. In
 * every one of those the browser can see the pixels and we cannot see the source,
 * so the pixels are the only honest answer.
 *
 * captureVisibleTab needs the tab to be active and visible, and is rate-limited,
 * so it is called at most once per export.
 */
async function captureTab(tab) {
  if (!tab || tab.windowId == null) {
    return { ok: false, reason: 'no window to capture' };
  }
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    if (!dataUrl) return { ok: false, reason: 'screenshot came back empty' };
    return { ok: true, dataUrl };
  } catch (error) {
    // Most commonly "Cannot access contents of the page" on a restricted tab, or
    // the rate limit. Either way the caller keeps its placeholders.
    return { ok: false, reason: describeError(error) };
  }
}

/* ========================================================================== *
 * SECTION: badge
 * ========================================================================== */

async function setActiveBadge(tabId, active, paused) {
  try {
    // Paused is visually distinct on purpose: the page is live in that state, and
    // mistaking it for selection mode means clicking things for real.
    await chrome.action.setBadgeText({ tabId, text: active ? (paused ? '❙❙' : '●') : '' });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: paused ? '#8AB4F8' : '#FFB224' });
  } catch (_) { /* tab may be gone */ }
}

/* ========================================================================== *
 * SECTION: message router
 * ========================================================================== */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return false;

  switch (message.type) {
    // Popup asks us to drive a tab; content script asks us to drive its own tab.
    case 'CHEATER_CMD': {
      const tabId = message.tabId || (sender.tab && sender.tab.id);
      if (!tabId) { sendResponse({ ok: false, reason: 'no-tab' }); return true; }

      if (message.cmd === 'export') {
        guard(runExport(tabId, null), 'collect+export').then(sendResponse);
        return true;
      }
      if (message.cmd === 'grab') {
        // Every frame is asked; the one whose pointer is over something answers with
        // grabbed:true. Needed because the keystroke lands in the focused frame and
        // the hover lives in the frame under the cursor — different frames whenever
        // the target is inside an iframe.
        guard(
          broadcast(tabId, { type: 'CHEATER_GRAB', exact: !!message.exact }).then((replies) => {
            // broadcast() hands back { frameId, reply } wrappers, not bare replies.
            const hit = (replies || []).find((entry) => entry.reply && entry.reply.grabbed);
            return {
              ok: true,
              grabbed: !!hit,
              frameId: hit ? hit.frameId : null,
              frame: hit ? hit.reply.frame : null
            };
          }),
          'grab'
        ).then(sendResponse);
        return true;
      }
      if (message.cmd === 'fullpage') {
        // Select <body> everywhere, then collect. Frames without a body reply null.
        guard(
          broadcast(tabId, { type: 'CHEATER_SELECT_BODY' }).then(() => runExport(tabId, null)),
          'full-page export'
        ).then(sendResponse);
        return true;
      }
      guard(
        broadcast(tabId, { type: 'CHEATER_' + String(message.cmd).toUpperCase() })
          .then((replies) => {
            if (message.cmd === 'start') setActiveBadge(tabId, true);
            if (message.cmd === 'clear') setActiveBadge(tabId, false);
            return { ok: true, frames: replies.length };
          }),
        message.cmd
      ).then(sendResponse);
      return true;
    }

    // A frame already has a payload in hand (export triggered locally).
    case 'CHEATER_EXPORT': {
      const tabId = sender.tab && sender.tab.id;
      guard(runExport(tabId, message.payload), 'export').then(sendResponse);
      return true;
    }

    case 'CHEATER_GET_PAYLOAD':
      guard(
        readPayload(message.id).then((payload) => ({ ok: !!payload, payload })),
        'payload read'
      ).then(sendResponse);
      return true;

    case 'CHEATER_RELEASE_PAYLOAD':
      guard(releasePayload(message.id).then(() => ({ ok: true })), 'payload release')
        .then(sendResponse);
      return true;

    // Fallback for the export tab: tokenized CDN font URLs can expire between
    // capture and "Download fonts", so allow a late single re-fetch.
    case 'CHEATER_FETCH_FONT':
      guard(
        fetchFontBinary({ url: message.url, path: message.path, mime: message.mime }),
        'font fetch'
      ).then(sendResponse);
      return true;

    case 'CHEATER_ACTIVE':
      setActiveBadge(sender.tab && sender.tab.id, !!message.active, !!message.paused);
      sendResponse({ ok: true });
      return true;

    // Open the export tab straight onto history — either a specific capture, or
    // the list itself. Reachable from the popup and from a shortcut, so past
    // captures are not stranded behind "do another export first".
    case 'CHEATER_OPEN_HISTORY':
      guard(openHistoryTab(message.id), 'open history').then(sendResponse);
      return true;

    case 'CHEATER_HISTORY_LIST':
      guard(listHistory(), 'history list').then(sendResponse);
      return true;

    case 'CHEATER_HISTORY_GET':
      guard(getHistoryPayload(message.id), 'history read').then(sendResponse);
      return true;

    case 'CHEATER_HISTORY_DELETE':
      guard(deleteHistory(message.id || null), 'history delete').then(sendResponse);
      return true;

    // Last-resort fidelity: a screenshot of the visible tab, which the content
    // script crops per element. Only the worker can call this.
    case 'CHEATER_CAPTURE_TAB':
      guard(captureTab(sender.tab), 'tab screenshot').then(sendResponse);
      return true;

    default:
      return false;
  }
});

// A navigation invalidates any selection, so drop the badge.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading') setActiveBadge(tabId, false);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  setActiveBadge(tabId, false);
});
