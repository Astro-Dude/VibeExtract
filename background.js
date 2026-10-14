/**
 * DOM Heist — service worker.
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

/**
 * Agent bridge (see installAgentBridge in contentScript.js). A page can only ask
 * for a capture of itself, but that still writes into Downloads, so the bridge
 * answers only on allowlisted origins: local development hosts by default, plus
 * any site the user allows from the popup. Stored as
 * chrome.storage.local { agentBridge: { enabled, origins, redactParams } };
 * stored values replace the defaults key by key. Captures are saved under
 * Downloads/domheist/<site>/, one folder per site, so a page on one allowed site
 * cannot overwrite a capture taken on another.
 */
const AGENT_DEFAULTS = {
  enabled: true,
  origins: ['http://localhost', 'http://127.0.0.1', 'http://[::1]', 'http://*.localhost'],
  // Query parameters whose values are replaced by REDACTED in saved files, so a
  // capture of a signed-in page does not carry its session into a repo.
  redactParams: [
    'token', 'access_token', 'id_token', 'refresh_token', 'auth', 'session', 'sessionid',
    'session_id', 'sid', 'jsessionid', 'phpsessid', 'sig', 'signature', 'api_key', 'apikey',
    'password', 'secret', 'x-amz-signature', 'x-amz-credential', 'x-amz-security-token'
  ]
};
const AGENT_TIMEOUT_MS = 170000;
const AGENT_WAITERS = new Map(); // exportId -> resolve
const AGENT_LOCAL_PATTERNS = new Set(AGENT_DEFAULTS.origins);

function originMatches(origin, pattern) {
  let o;
  let p;
  try { o = new URL(origin); p = new URL(pattern.replace('://*.', '://wildcard.')); } catch (_) { return false; }
  if (o.protocol !== p.protocol) return false;
  if (pattern.indexOf('://*.') !== -1) {
    const suffix = p.hostname.replace(/^wildcard\./, '');
    return o.hostname === suffix || o.hostname.endsWith('.' + suffix);
  }
  // The built-in local hosts match on any port (dev servers move between ports);
  // a site allowed from the popup matches only its exact origin, port included.
  if (AGENT_LOCAL_PATTERNS.has(pattern)) return o.hostname === p.hostname;
  return o.origin === p.origin;
}

async function agentConfig() {
  try {
    const stored = await chrome.storage.local.get('agentBridge');
    if (stored && stored.agentBridge) return Object.assign({}, AGENT_DEFAULTS, stored.agentBridge);
  } catch (_) { /* defaults */ }
  return Object.assign({}, AGENT_DEFAULTS);
}

function originAllowed(config, origin) {
  return (config.origins || []).some((pattern) => originMatches(origin || '', pattern));
}

/** `refused` tells the content script to stay silent, so a site that is not
 *  allowed cannot learn that DOM Heist is installed. */
async function agentAllowed(origin) {
  const config = await agentConfig();
  if (!config.enabled) return { ok: false, refused: true, reason: 'agent bridge is disabled' };
  return originAllowed(config, origin)
    ? { ok: true }
    : { ok: false, refused: true, reason: 'origin not in the agent bridge allowlist: ' + origin };
}

/** Adds or removes one exact origin (the popup's "Allow agent captures here"). */
async function setAgentOrigin(origin, allow) {
  let parsed;
  try { parsed = new URL(origin); } catch (_) { return { ok: false, reason: 'not an origin: ' + origin }; }
  if (!/^https?:$/.test(parsed.protocol)) return { ok: false, reason: 'only http(s) origins can be allowed' };
  const exact = parsed.origin;
  const config = await agentConfig();
  const origins = (config.origins || []).filter((o) => o !== exact);
  if (allow) origins.push(exact);
  const stored = (await chrome.storage.local.get('agentBridge')).agentBridge || {};
  await chrome.storage.local.set({ agentBridge: Object.assign({}, stored, { origins }) });
  return { ok: true, allowed: originAllowed(Object.assign({}, config, { origins }), exact) };
}

/** `https://s1.example.com:8443` → `s1.example.com-8443`: a safe folder name. */
function agentSite(origin) {
  let host = '';
  try { host = new URL(origin).host; } catch (_) { /* unknown */ }
  const cleaned = host.toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  return cleaned || 'unknown-site';
}

function agentName(raw) {
  const cleaned = String(raw || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/\.{2,}/g, '.').replace(/^[-.]+|[-.]+$/g, '').slice(0, 80);
  return cleaned || 'capture-' + Date.now().toString(36);
}

/**
 * Moves the real pointer for an agent capture's `hover`. Only Chrome's own input
 * pipeline sets :hover and fires trusted mouse events, so a page cannot fake it;
 * the debugger is attached for this one event and detached straight away.
 */
async function agentHover(tabId, x, y) {
  if (!isFinite(x) || !isFinite(y)) return { ok: false, reason: 'hover point is not a number' };
  const target = { tabId };
  try {
    await chrome.debugger.attach(target, '1.3');
  } catch (error) {
    return { ok: false, reason: 'could not move the pointer: ' + describeError(error) };
  }
  try {
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    return { ok: true, x, y };
  } catch (error) {
    return { ok: false, reason: 'could not move the pointer: ' + describeError(error) };
  } finally {
    await chrome.debugger.detach(target).catch(() => {});
  }
}

function waitForAgent(id) {
  return new Promise((resolve) => {
    // The waiter lives only in this worker's memory, and Chrome stops an idle worker
    // after 30 s; an extension API call every 20 s keeps it alive until the export
    // page reports back.
    const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);
    const timer = setTimeout(() => {
      clearInterval(keepAlive);
      AGENT_WAITERS.delete(id);
      resolve({ ok: false, reason: 'the export page did not report back (timed out)' });
    }, AGENT_TIMEOUT_MS);
    AGENT_WAITERS.set(id, (result) => { clearTimeout(timer); clearInterval(keepAlive); resolve(result); });
  });
}

/** The origin of the tab a content script runs in, as Chrome reports it (never the page's word). */
function senderOrigin(sender) {
  try { return new URL(sender.tab.url).origin; } catch (_) { return sender.origin || ''; }
}

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
    console.error('[DOM Heist] ' + label + ' failed:', error);
    return { ok: false, reason };
  });
}

async function runExport(tabId, payloadFromSender, options) {
  let payload = payloadFromSender;
  const agent = options && options.agent;

  // Validate before touching it: `payload.fontFaces` on an undefined payload is a
  // TypeError, which used to disappear into the closed port described above.
  if (payload && (!payload.nodes || !payload.nodes.length)) {
    return { ok: false, reason: 'the capture contained no nodes' };
  }

  if (!payload) {
    // An agent capture selects in the top frame only, so it collects from there:
    // a selection left in another frame must not ride along in its files.
    const entries = agent
      ? [{ frameId: 0, reply: await sendToFrame(tabId, 0, { type: 'DOMHEIST_COLLECT' }) }].filter((e) => e.reply != null)
      : await broadcast(tabId, { type: 'DOMHEIST_COLLECT' });
    if (!entries.length) {
      await broadcast(tabId, { type: 'DOMHEIST_TOAST', text: 'Nothing selected' });
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

  let url = chrome.runtime.getURL('export.html') + '?id=' + encodeURIComponent(id);
  if (agent) {
    url += '&agent=1&name=' + encodeURIComponent(agentName(agent.name)) +
      '&site=' + encodeURIComponent(agent.site || 'unknown-site');
    if (agent.formats && agent.formats.length) url += '&formats=' + encodeURIComponent(agent.formats.join(','));
  }
  const waiting = agent ? waitForAgent(id) : null;

  try {
    // An agent export runs in a background tab that closes itself once saved, so
    // the page being captured keeps focus.
    await chrome.tabs.create({ url, active: !agent });
  } catch (error) {
    PENDING.delete(id);
    AGENT_WAITERS.delete(id);
    return { ok: false, reason: 'could not open the export tab: ' + describeError(error) };
  }

  if (waiting) return Object.assign({ id }, await waiting);
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

const HISTORY_DB = 'domheist-history';
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
    console.warn('[DOM Heist] could not record history:', error);
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
 * so it is called at most once per export. It also waits for a fresh frame, which
 * a window covered by another app may never produce, so it gets a deadline: past
 * it the capture keeps its placeholders instead of stalling.
 */
const TAB_SHOT_TIMEOUT_MS = 5000;

async function captureTab(tab) {
  if (!tab || tab.windowId == null) {
    return { ok: false, reason: 'no window to capture' };
  }
  try {
    let timer = null;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('the tab produced no frame to screenshot (timed out)')),
        TAB_SHOT_TIMEOUT_MS);
    });
    const dataUrl = await Promise.race([
      chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }),
      deadline
    ]).finally(() => clearTimeout(timer));
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

/* ========================================================================== *
 * SECTION: cross-origin frames
 *
 * A parent cannot read a cross-origin frame, but the content script runs in every
 * frame, so an instance inside that frame can read it. What the parent lacks is the
 * ADDRESS: it holds an <iframe> element and needs the frameId behind it, which no
 * DOM API exposes.
 *
 * The parent posts a token into the frame; the instance there echoes the token to
 * us, and we learn the frameId from the message sender — the browser's word, not the
 * page's. A page inside that frame can see the token but has no route here, so it
 * cannot answer on the frame's behalf.
 * ========================================================================== */

const REMOTE_TOKEN_TTL_MS = 30000;
const remoteFrames = new Map();          // token -> { tabId, frameId, stamp }

function rememberRemoteFrame(token, tabId, frameId) {
  const now = Date.now();
  for (const [key, entry] of remoteFrames) {
    if (now - entry.stamp > REMOTE_TOKEN_TTL_MS) remoteFrames.delete(key);
  }
  remoteFrames.set(token, { tabId, frameId, stamp: now });
}

/**
 * Wait briefly for a token to be claimed, then relay the capture request there.
 *
 * The wait exists because the parent posts the token and asks us in the same breath;
 * the frame's echo is a separate hop and can land after the request. Polling here
 * keeps that race out of the content script.
 */
async function captureRemoteFrame(token, tabId, timeoutMs) {
  const deadline = Date.now() + Math.min(Math.max(timeoutMs || 4000, 500), 10000);
  let entry = remoteFrames.get(token);
  while (!entry && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 40));
    entry = remoteFrames.get(token);
  }
  if (!entry) return { ok: false, reason: 'no frame claimed the token' };
  // A token is only ever valid for the tab that minted it.
  if (tabId && entry.tabId && entry.tabId !== tabId) {
    return { ok: false, reason: 'token belongs to another tab' };
  }

  remoteFrames.delete(token);              // single use
  const reply = await sendToFrame(entry.tabId, entry.frameId, { type: 'DOMHEIST_CAPTURE_FRAME' });
  if (!reply || !reply.payload) return { ok: false, reason: 'the frame could not capture itself' };
  return { ok: true, payload: reply.payload, url: reply.url || null };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return false;

  switch (message.type) {
    // Popup asks us to drive a tab; content script asks us to drive its own tab.
    case 'DOMHEIST_CMD': {
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
          broadcast(tabId, { type: 'DOMHEIST_GRAB', exact: !!message.exact }).then((replies) => {
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
          broadcast(tabId, { type: 'DOMHEIST_SELECT_BODY' }).then(() => runExport(tabId, null)),
          'full-page export'
        ).then(sendResponse);
        return true;
      }
      guard(
        broadcast(tabId, { type: 'DOMHEIST_' + String(message.cmd).toUpperCase() })
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
    case 'DOMHEIST_EXPORT': {
      const tabId = sender.tab && sender.tab.id;
      guard(runExport(tabId, message.payload), 'export').then(sendResponse);
      return true;
    }

    case 'DOMHEIST_AGENT_ALLOWED': {
      guard(agentAllowed(senderOrigin(sender)), 'agent gate').then(sendResponse);
      return true;
    }

    // Read by the popup (to show the allow toggle) and by the export page
    // (redaction). `origin` is optional.
    case 'DOMHEIST_AGENT_CONFIG': {
      guard(agentConfig().then((config) => ({
        ok: true,
        enabled: !!config.enabled,
        redactParams: Array.isArray(config.redactParams) ? config.redactParams : [],
        allowed: message.origin ? originAllowed(config, message.origin) : null,
        // Allowed by a pattern rather than an exact entry (the local-host
        // defaults), so the popup cannot switch it off for this one site.
        byPattern: message.origin
          ? originAllowed(Object.assign({}, config, {
            origins: (config.origins || []).filter((o) => o !== message.origin)
          }), message.origin)
          : null
      })), 'agent config').then(sendResponse);
      return true;
    }

    // Only an extension page (the popup) may change the allowlist; a content
    // script always has sender.tab, so a page cannot allow itself.
    case 'DOMHEIST_AGENT_SET_ORIGIN': {
      if (sender.tab || sender.id !== chrome.runtime.id) {
        sendResponse({ ok: false, reason: 'not allowed from a page' });
        return true;
      }
      guard(setAgentOrigin(message.origin, !!message.allow), 'agent allowlist').then(sendResponse);
      return true;
    }

    case 'DOMHEIST_AGENT_HOVER': {
      const tabId = sender.tab && sender.tab.id;
      if (!tabId || sender.frameId !== 0) { sendResponse({ ok: false, reason: 'hover is top-frame only' }); return true; }
      guard(
        agentAllowed(senderOrigin(sender)).then((gate) => (gate.ok
          ? agentHover(tabId, Number(message.x), Number(message.y))
          : gate)),
        'agent hover'
      ).then(sendResponse);
      return true;
    }

    case 'DOMHEIST_AGENT_EXPORT': {
      const tabId = sender.tab && sender.tab.id;
      if (!tabId) { sendResponse({ ok: false, reason: 'no-tab' }); return true; }
      const origin = senderOrigin(sender);
      guard(
        agentAllowed(origin).then((gate) => (gate.ok
          ? runExport(tabId, null, {
            agent: { name: message.name, formats: message.formats, site: agentSite(origin) }
          })
          : gate)),
        'agent export'
      ).then(sendResponse);
      return true;
    }

    // The export page finished an agent save: hand the paths to whoever is
    // waiting and close the background tab it ran in.
    case 'DOMHEIST_AGENT_DONE': {
      const resolve = AGENT_WAITERS.get(message.id);
      AGENT_WAITERS.delete(message.id);
      if (resolve) {
        resolve({
          ok: !!message.ok,
          reason: message.reason || null,
          paths: message.paths || {},
          bytes: message.bytes || {},
          diagnostics: message.diagnostics || {}
        });
      }
      if (sender.tab && sender.tab.id) chrome.tabs.remove(sender.tab.id).catch(() => {});
      sendResponse({ ok: true });
      return true;
    }

    case 'DOMHEIST_GET_PAYLOAD':
      guard(
        readPayload(message.id).then((payload) => ({ ok: !!payload, payload })),
        'payload read'
      ).then(sendResponse);
      return true;

    case 'DOMHEIST_RELEASE_PAYLOAD':
      guard(releasePayload(message.id).then(() => ({ ok: true })), 'payload release')
        .then(sendResponse);
      return true;

    // Fallback for the export tab: tokenized CDN font URLs can expire between
    // capture and "Download fonts", so allow a late single re-fetch.
    case 'DOMHEIST_FETCH_FONT':
      guard(
        fetchFontBinary({ url: message.url, path: message.path, mime: message.mime }),
        'font fetch'
      ).then(sendResponse);
      return true;

    case 'DOMHEIST_FRAME_HELLO': {
      // The frameId comes from the sender, so a page cannot claim to be a frame it
      // is not. Anonymous senders (no tab) are ignored.
      const tabId = sender.tab && sender.tab.id;
      if (tabId != null && typeof message.token === 'string' && message.token) {
        rememberRemoteFrame(message.token, tabId, sender.frameId || 0);
      }
      sendResponse({ ok: true });
      return true;
    }

    case 'DOMHEIST_CAPTURE_REMOTE':
      guard(
        captureRemoteFrame(message.token, sender.tab && sender.tab.id, message.timeout),
        'remote frame capture'
      ).then(sendResponse);
      return true;

    case 'DOMHEIST_ACTIVE':
      setActiveBadge(sender.tab && sender.tab.id, !!message.active, !!message.paused);
      sendResponse({ ok: true });
      return true;

    // Open the export tab straight onto history — either a specific capture, or
    // the list itself. Reachable from the popup and from a shortcut, so past
    // captures are not stranded behind "do another export first".
    case 'DOMHEIST_OPEN_HISTORY':
      guard(openHistoryTab(message.id), 'open history').then(sendResponse);
      return true;

    case 'DOMHEIST_HISTORY_LIST':
      guard(listHistory(), 'history list').then(sendResponse);
      return true;

    case 'DOMHEIST_HISTORY_GET':
      guard(getHistoryPayload(message.id), 'history read').then(sendResponse);
      return true;

    case 'DOMHEIST_HISTORY_DELETE':
      guard(deleteHistory(message.id || null), 'history delete').then(sendResponse);
      return true;

    // Last-resort fidelity: a screenshot of the visible tab, which the content
    // script crops per element. Only the worker can call this.
    case 'DOMHEIST_CAPTURE_TAB':
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
