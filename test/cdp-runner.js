/**
 * Cheater — CDP test runner.
 *
 * The four browser harnesses (run-fixtures, run-fonts, run-stress, run-history)
 * are written as Playwright `async (page) => {}` functions. This runs them
 * against a plain headless Chrome over the DevTools protocol instead, so the
 * suites work without Playwright installed or an MCP server attached.
 *
 *   node test/cdp-runner.js                 # every suite
 *   node test/cdp-runner.js run-fixtures    # one suite
 *
 * It launches Chrome itself, serves the repo over HTTP (the harnesses inject
 * scripts by URL and the fixtures load fonts and images relatively), shims the
 * seven Playwright page methods the harnesses actually use, and exits non-zero
 * if any assertion failed.
 *
 * Zero dependencies, matching the rest of the repo: the WebSocket client below
 * is a minimal RFC 6455 text-frame implementation.
 */

'use strict';

const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8931;
// A second origin, so "cross-origin iframe" in the fixtures is real rather than
// simulated. Same content, different port — which is all the browser needs to
// apply the origin boundary.
const PORT2 = 8932;
const CDP_PORT = 9333;
const SUITES = ['run-fixtures', 'run-dropdowns', 'run-iframes', 'run-remote', 'run-animations', 'run-fonts', 'run-stress', 'run-history'];

const CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser'
];

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.ttf': 'font/ttf', '.otf': 'font/otf'
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ server */

function serve(port) {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
    const file = path.join(ROOT, rel);
    // Keep the server inside the repo even if a harness asks for '../'.
    if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    fs.readFile(file, (err, body) => {
      if (err) { res.writeHead(404).end('not found'); return; }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        // The fixtures deliberately exercise cross-origin-ish paths; allow reads
        // so canvas taint checks behave the way they do on a real site.
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store'
      });
      res.end(body);
    });
  });
  // No host: binds every interface, so the fixtures can reach this origin as both
  // 127.0.0.1 (cross-origin, same process — ports do not trigger site isolation)
  // and localhost (a different host, so a genuine out-of-process frame).
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

/* --------------------------------------------------------------- websocket */

function ws(url) {
  const u = new URL(url);
  const key = crypto.randomBytes(16).toString('base64');
  const sock = net.connect(Number(u.port), u.hostname);
  const pending = new Map();
  const listeners = [];
  let buf = Buffer.alloc(0);
  let handshook = false;
  let nextId = 0;

  sock.setNoDelay(true);
  sock.on('connect', () => {
    sock.write(`GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.host}\r\n` +
      'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  });

  const opened = new Promise((resolve) => {
    sock.on('data', function first() { sock.off('data', first); resolve(); });
  });

  sock.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    if (!handshook) {
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      handshook = true;
      buf = buf.slice(end + 4);
    }
    for (;;) {
      if (buf.length < 2) return;
      const short = buf[1] & 0x7f;
      let offset = 2;
      let length = short;
      if (short === 126) {
        if (buf.length < 4) return;
        length = buf.readUInt16BE(2); offset = 4;
      } else if (short === 127) {
        if (buf.length < 10) return;
        length = Number(buf.readBigUInt64BE(2)); offset = 10;
      }
      if (buf.length < offset + length) return;
      const text = buf.slice(offset, offset + length).toString('utf8');
      buf = buf.slice(offset + length);
      let msg;
      try { msg = JSON.parse(text); } catch (_) { continue; }
      if (msg.id != null && pending.has(msg.id)) {
        const { resolve } = pending.get(msg.id);
        pending.delete(msg.id);
        resolve(msg);
      } else if (msg.method) {
        listeners.forEach((fn) => fn(msg));
      }
    }
  });

  function send(method, params, sessionId) {
    const id = ++nextId;
    const frame = { id, method, params: params || {} };
    // Flat auto-attach multiplexes every target down one socket, addressed by
    // sessionId. A cross-origin iframe is its own process and its own target, so
    // this is the only way to reach inside one — which is exactly the position the
    // extension's service worker is in.
    if (sessionId) frame.sessionId = sessionId;
    const body = Buffer.from(JSON.stringify(frame), 'utf8');
    const mask = crypto.randomBytes(4);
    const masked = Buffer.alloc(body.length);
    for (let i = 0; i < body.length; i += 1) masked[i] = body[i] ^ mask[i % 4];

    let header;
    if (body.length < 126) {
      header = Buffer.from([0x81, 0x80 | body.length]);
    } else if (body.length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81; header[1] = 0x80 | 126;
      header.writeUInt16BE(body.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81; header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(body.length), 2);
    }
    sock.write(Buffer.concat([header, mask, masked]));
    return new Promise((resolve) => pending.set(id, { resolve }));
  }

  return { send, opened, on: (fn) => listeners.push(fn), close: () => sock.destroy() };
}

/* -------------------------------------------------------------- cdp target */

function httpJson(urlPath, method) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: CDP_PORT, path: urlPath, method: method || 'GET' },
      (res) => {
        let body = '';
        res.on('data', (d) => { body += d; });
        res.on('end', () => {
          try { resolve(JSON.parse(body || '{}')); } catch (e) { reject(new Error(body.slice(0, 120))); }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

/**
 * The Playwright surface the harnesses use, on top of one CDP session.
 */
async function newPage() {
  // Newer Chrome rejects GET on /json/new.
  const target = await httpJson('/json/new?about:blank', 'PUT');
  const conn = ws(target.webSocketDebuggerUrl);
  await conn.opened;
  await conn.send('Page.enable');
  await conn.send('Runtime.enable');
  await conn.send('Log.enable');

  const pageErrors = [];
  // Every out-of-process frame that attaches, and the init scripts to replay into
  // each one — a script added to the page target does not reach a separate process.
  const subtargets = [];
  const initScripts = [];
  // Same-process frames share the page target, so they are addressed by execution
  // context rather than by session. Cross-origin-but-same-site frames land here.
  const contexts = [];

  conn.on((msg) => {
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      pageErrors.push(msg.params.entry.text);
    }
    if (msg.method === 'Target.attachedToTarget') {
      const { sessionId, targetInfo } = msg.params;
      if (targetInfo.type !== 'iframe' && targetInfo.type !== 'page') return;
      const entry = { sessionId, url: targetInfo.url, type: targetInfo.type };
      subtargets.push(entry);
      // Bring the new session up to the same state, then replay the init scripts so
      // the content script exists there too — which is what all_frames does.
      conn.send('Runtime.enable', {}, sessionId).catch(() => {});
      conn.send('Page.enable', {}, sessionId).catch(() => {});
      for (const source of initScripts) {
        conn.send('Page.addScriptToEvaluateOnNewDocument', { source }, sessionId).catch(() => {});
      }
      conn.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
    }
    if (msg.method === 'Runtime.executionContextCreated') {
      const ctx = msg.params.context;
      const origin = ctx.origin || '';
      // Only real document contexts; skip our own isolated worlds and about:blank.
      if (ctx.auxData && ctx.auxData.frameId) {
        contexts.push({ id: ctx.id, frameId: ctx.auxData.frameId, origin, isDefault: !!ctx.auxData.isDefault });
      }
    }
    if (msg.method === 'Runtime.executionContextDestroyed') {
      const at = contexts.findIndex((c) => c.id === msg.params.executionContextId);
      if (at !== -1) contexts.splice(at, 1);
    }
    if (msg.method === 'Target.detachedFromTarget') {
      const at = subtargets.findIndex((t) => t.sessionId === msg.params.sessionId);
      if (at !== -1) subtargets.splice(at, 1);
    }
  });

  await conn.send('Target.setAutoAttach', {
    autoAttach: true, waitForDebuggerOnStart: true, flatten: true
  });

  async function evaluate(fn, arg) {
    // Playwright passes a single argument; JSON round-trips it the same way.
    const expression = '(' + String(fn) + ')(' + JSON.stringify(arg === undefined ? null : arg) + ')';
    const res = await conn.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true, userGesture: true
    });
    const details = res.result && res.result.exceptionDetails;
    if (details) {
      const ex = details.exception || {};
      throw new Error(ex.description || ex.value || details.text || 'evaluate threw');
    }
    return res.result.result.value;
  }

  const page = {
    _conn: conn,
    _errors: pageErrors,

    async addInitScript(fn) {
      const source = '(' + String(fn) + ')();';
      initScripts.push(source);
      await conn.send('Page.addScriptToEvaluateOnNewDocument', { source });
    },

    /**
     * Load a repo file into EVERY frame, including out-of-process ones.
     *
     * This is what `all_frames: true` does for the real extension, and without it a
     * cross-origin frame has no content script — so no test could ever show the
     * cross-origin path working.
     */
    async addAllFramesScript(relPath) {
      const source = fs.readFileSync(path.join(ROOT, relPath), 'utf8');
      initScripts.push(source);
      await conn.send('Page.addScriptToEvaluateOnNewDocument', { source });
      for (const target of subtargets) {
        await conn.send('Page.addScriptToEvaluateOnNewDocument', { source }, target.sessionId).catch(() => {});
      }
    },

    /**
     * The out-of-process frames, each with its own evaluate(). Standing in for the
     * service worker, which is the only thing that can address them for real.
     */
    /**
     * Every frame in the tab that is not the top document, each with its own
     * evaluate() — standing in for the service worker, the only thing that can
     * address a frame the parent page cannot touch.
     *
     * Two kinds, because Chrome has two: an out-of-process frame is a separate
     * target reached by sessionId, while a cross-origin-but-same-site frame shares
     * the page target and is reached by execution context id. Ports do not trigger
     * site isolation, so a different port gives you the second kind.
     */
    async subframes() {
      const run = async (expression, addressing) => {
        const res = await conn.send('Runtime.evaluate', Object.assign({
          expression, returnByValue: true, awaitPromise: true, userGesture: true
        }, addressing.contextId ? { contextId: addressing.contextId } : {}), addressing.sessionId);
        const details = res.result && res.result.exceptionDetails;
        if (details) {
          const ex = details.exception || {};
          throw new Error(ex.description || ex.value || details.text || 'evaluate threw');
        }
        return res.result.result.value;
      };
      const wrap = (addressing) => ({
        kind: addressing.sessionId ? 'out-of-process' : 'same-process',
        addressing,
        evaluate: (fn, arg) =>
          run('(' + String(fn) + ')(' + JSON.stringify(arg === undefined ? null : arg) + ')', addressing)
      });

      const out = [];
      for (const target of subtargets) {
        if (target.type !== 'iframe') continue;
        const frame = wrap({ sessionId: target.sessionId });
        try { frame.url = await frame.evaluate(() => location.href); } catch (_) { frame.url = target.url || ''; }
        out.push(frame);
      }
      for (const ctx of contexts) {
        if (!ctx.isDefault) continue;
        const frame = wrap({ contextId: ctx.id });
        try {
          const info = await frame.evaluate(() => ({ href: location.href, top: window.top === window }));
          if (info.top) continue;                    // the top document is not a subframe
          frame.url = info.href;
        } catch (_) { continue; }                    // a context that has already gone
        out.push(frame);
      }
      return out;
    },

    async goto(url) {
      await conn.send('Page.navigate', { url });
      // Wait for the load event rather than a fixed delay.
      const start = Date.now();
      for (;;) {
        const state = await evaluate(() => document.readyState);
        if (state === 'complete') break;
        if (Date.now() - start > 15000) break;
        await sleep(50);
      }
    },

    async addScriptTag({ url, content, type }) {
      return evaluate((opts) => new Promise((resolve, reject) => {
        const el = document.createElement('script');
        if (opts.type) el.type = opts.type;
        if (opts.url) {
          el.src = opts.url;
          el.onload = () => resolve(true);
          el.onerror = () => reject(new Error('failed to load ' + opts.url));
        } else {
          el.textContent = opts.content;
        }
        document.head.appendChild(el);
        if (!opts.url) resolve(true);
      }), { url, content, type });
    },

    evaluate,
    waitForTimeout: sleep,

    /**
     * A real mouse, which is the only way to test :hover.
     *
     * Synthetic pointer events do not move the cursor, so a CSS `:hover` rule never
     * matches and a hover-revealed menu can never be made to appear from inside the
     * page. Input.dispatchMouseEvent moves the actual pointer. Mirrors Playwright's
     * page.mouse, so the harnesses run unchanged under either driver.
     */
    mouse: {
      async move(x, y) {
        await conn.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved', x: Math.round(x), y: Math.round(y), buttons: 0
        });
      },
      async click(x, y) {
        const at = { x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, buttons: 1 };
        await conn.send('Input.dispatchMouseEvent', Object.assign({ type: 'mousePressed' }, at));
        await conn.send('Input.dispatchMouseEvent', Object.assign({ type: 'mouseReleased' }, at));
      }
    },

    /**
     * Playwright's setContent. Page.setDocumentContent is used rather than a
     * data: URL so relative font and image paths in the export still resolve
     * against the served origin — which is the whole point in the font suite.
     */
    async setContent(html) {
      const { result } = await conn.send('Page.getFrameTree');
      await conn.send('Page.setDocumentContent', {
        frameId: result.frameTree.frame.id, html
      });
      const start = Date.now();
      for (;;) {
        const state = await evaluate(() => document.readyState);
        if (state === 'complete') break;
        if (Date.now() - start > 10000) break;
        await sleep(50);
      }
    },

    async setViewportSize({ width, height }) {
      await conn.send('Emulation.setDeviceMetricsOverride', {
        width, height, deviceScaleFactor: 1, mobile: false
      });
    },

    // run-fonts needs a second page to prove a font really is absent in a fresh
    // context rather than merely cached.
    context: () => ({ newPage }),

    close: () => conn.close()
  };
  return page;
}

/* ------------------------------------------------------------------- chrome */

function launchChrome(profileDir) {
  const bin = CHROME_PATHS.find((p) => fs.existsSync(p));
  if (!bin) throw new Error('no Chrome/Chromium found; looked in:\n  ' + CHROME_PATHS.join('\n  '));
  const child = spawn(bin, [
    '--headless=new',
    '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + profileDir,
    '--no-first-run', '--no-default-browser-check',
    '--disable-backgrounding-occluded-windows',
    '--allow-file-access-from-files',
    '--force-device-scale-factor=1',
    'about:blank'
  ], { stdio: 'ignore', detached: false });
  return child;
}

async function waitForChrome() {
  for (let i = 0; i < 80; i += 1) {
    try { await httpJson('/json/version'); return true; } catch (_) { await sleep(150); }
  }
  throw new Error('Chrome did not expose a debugging port on ' + CDP_PORT);
}

/* --------------------------------------------------------------------- main */

(async () => {
  const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const suites = only.length ? only.map((s) => s.replace(/\.js$/, '')) : SUITES;

  for (const suite of suites) {
    if (!fs.existsSync(path.join(__dirname, suite + '.js'))) {
      console.error('no such suite: ' + suite);
      process.exit(2);
    }
  }

  const profileDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'cheater-cdp-'));
  const server = await serve(PORT);
  const server2 = await serve(PORT2);
  const chrome = launchChrome(profileDir);
  let failed = 0;
  const totals = { passed: 0, total: 0 };

  try {
    await waitForChrome();

    for (const suite of suites) {
      console.log('\n=== ' + suite + ' ' + '='.repeat(Math.max(0, 56 - suite.length)));
      // The harnesses are bare `async (page) => {…}` expressions, not modules,
      // so they are evaluated rather than required.
      const source = fs.readFileSync(path.join(__dirname, suite + '.js'), 'utf8');
      // eslint-disable-next-line no-eval
      const harness = eval('(' + source + ')');
      const page = await newPage();
      const started = Date.now();
      try {
        const result = await harness(page);
        // Harnesses print their own pass/fail lines and return a summary string.
        if (result) console.log(String(result).trim());
        // Harnesses lead with "<passed>/<total> passed"; run-history just prints
        // ok/FAIL lines, so fall back to counting those.
        const summary = String(result || '');
        const score = summary.match(/^(\d+)\/(\d+)\s+passed/m);
        if (score) {
          const missed = Number(score[2]) - Number(score[1]);
          failed += missed;
          totals.passed += Number(score[1]);
          totals.total += Number(score[2]);
        } else {
          const fails = (summary.match(/^\s*FAIL/gm) || []).length;
          const oks = (summary.match(/^\s*ok\b/gm) || []).length;
          failed += fails;
          totals.passed += oks;
          totals.total += oks + fails;
        }
      } catch (err) {
        failed += 1;
        console.log('  SUITE ERROR  ' + err.message);
      }
      if (page._errors.length) {
        console.log('  page console errors (' + page._errors.length + '):');
        page._errors.slice(0, 5).forEach((e) => console.log('    ' + e.split('\n')[0].slice(0, 160)));
      }
      console.log('  (' + ((Date.now() - started) / 1000).toFixed(1) + 's)');
      page.close();
    }
  } finally {
    chrome.kill();
    server.close();
    server2.close();
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (_) {}
  }

  console.log('\n' + '='.repeat(60));
  console.log(totals.passed + '/' + totals.total + ' assertions passed across ' +
    suites.length + ' suite(s)');
  if (failed) console.log(failed + ' FAILING');
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error('runner error: ' + err.stack);
  process.exit(2);
});
