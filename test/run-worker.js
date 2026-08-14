/**
 * Cheater — service worker harness. Plain Node, no browser.
 *
 *   node test/run-worker.js
 *
 * Loads background.js against a stubbed chrome.* and drives the export path
 * end to end. This exists because a failure in the worker surfaces on the page as
 * nothing but "Export failed": the worker has no console anyone looks at, and an
 * unhandled rejection inside a message handler simply closes the port with no
 * response at all. Exercising it here turns that into a named assertion.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const results = [];
const ok = (name, pass, detail) => results.push({ name, pass: !!pass, detail: pass ? '' : String(detail ?? '') });

/* ------------------------------------------------------------- chrome stub */

function makeChrome(opts) {
  const options = opts || {};
  const calls = { created: [], sessionSet: [], badge: [], fetched: [] };
  const listeners = [];

  const chrome = {
    runtime: {
      onMessage: { addListener: (fn) => listeners.push(fn) },
      getURL: (p) => 'chrome-extension://abc/' + p,
      lastError: null
    },
    tabs: {
      create: async (info) => {
        if (options.tabsCreateThrows) throw new Error('cannot create tab');
        calls.created.push(info);
        return { id: 99 };
      },
      sendMessage: async (tabId, message, opts2) => {
        if (options.frameReplies) {
          const frameId = (opts2 && opts2.frameId) || 0;
          const reply = options.frameReplies[frameId];
          if (reply === 'throw') throw new Error('Could not establish connection');
          return reply === undefined ? null : reply;
        }
        return null;
      },
      onUpdated: { addListener() {} },
      onRemoved: { addListener() {} }
    },
    webNavigation: {
      getAllFrames: async () => options.frames || [{ frameId: 0 }]
    },
    storage: {
      session: {
        set: async (obj) => {
          if (options.sessionSetThrows) throw new Error('QUOTA_BYTES quota exceeded');
          calls.sessionSet.push(Object.keys(obj)[0]);
        },
        get: async (key) => (options.sessionStore ? options.sessionStore : {}),
        remove: async () => {}
      }
    },
    action: {
      setBadgeText: async () => {},
      setBadgeBackgroundColor: async () => {}
    }
  };
  return { chrome, calls, listeners };
}

function loadWorker(stub) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
  const sandbox = {
    chrome: stub.chrome,
    console,
    setTimeout,
    clearTimeout,
    fetch: async (url) => {
      stub.calls.fetched.push(url);
      if (String(url).includes('fail')) return { ok: false, status: 403 };
      const bytes = new Uint8Array(2048).fill(65);
      return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer };
    },
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    Promise, JSON, Object, Array, String, Number, Math, Date, Map, Set, Uint8Array, Error, TextEncoder
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'background.js' });
  return sandbox;
}

/** Invoke the worker's message listener the way Chrome does. */
function send(stub, message, sender) {
  return new Promise((resolve) => {
    let settled = false;
    const sendResponse = (value) => { settled = true; resolve(value); };
    const kept = stub.listeners.some((fn) => fn(message, sender || { tab: { id: 7 } }, sendResponse) === true);
    // Chrome closes the port when the listener returns falsy, or when an async
    // handler never calls sendResponse. Model both as "undefined response",
    // which is exactly what the page sees.
    if (!kept) return resolve(undefined);
    setTimeout(() => { if (!settled) resolve(undefined); }, 600);
  });
}

function samplePayload(extra) {
  return Object.assign({
    url: 'https://example.com/',
    title: 'Example',
    styles: { s1: { color: '#fff' } },
    pseudos: {}, wrappers: {}, hovers: [],
    nodes: [{ k: 'e', tag: 'div', cls: ['s1'], attrs: {}, ch: [{ k: 't', v: 'hi' }] }],
    fonts: { google: [], icons: [], primary: 'Inter', primaryLoadable: true },
    fontFaces: [],
    diagnostics: { topLevel: 1, nodes: 2, selections: [{ tag: 'div' }] }
  }, extra || {});
}

/* --------------------------------------------------------------- the tests */

(async () => {
  /* 1. the happy path */
  {
    const stub = makeChrome({});
    loadWorker(stub);
    const res = await send(stub, { type: 'CHEATER_EXPORT', payload: samplePayload() });
    ok('export: responds ok and opens the export tab',
      res && res.ok === true && stub.calls.created.length === 1,
      JSON.stringify({ res, created: stub.calls.created.length }));
    ok('export: tab url carries the payload id',
      stub.calls.created[0] && /export\.html\?id=cx/.test(stub.calls.created[0].url),
      stub.calls.created[0] && stub.calls.created[0].url);
  }

  /* 2. fonts: one failing binary must not sink the export */
  {
    const stub = makeChrome({});
    loadWorker(stub);
    const payload = samplePayload({
      fontFaces: [
        { family: 'A', url: 'https://x.test/a.woff2', path: 'fonts/a.woff2', mime: 'font/woff2' },
        { family: 'B', url: 'https://x.test/fail.woff2', path: 'fonts/b.woff2', mime: 'font/woff2' }
      ]
    });
    const res = await send(stub, { type: 'CHEATER_EXPORT', payload });
    ok('fonts: export still succeeds when one binary fails',
      res && res.ok === true, JSON.stringify(res));
  }

  /* 3. session mirror over quota must not sink the export */
  {
    const stub = makeChrome({ sessionSetThrows: true });
    loadWorker(stub);
    const res = await send(stub, { type: 'CHEATER_EXPORT', payload: samplePayload() });
    ok('storage: an over-quota session mirror is survivable',
      res && res.ok === true && stub.calls.created.length === 1, JSON.stringify(res));
  }

  /* 4. THE SILENT FAILURE: anything that throws inside the handler */
  {
    const stub = makeChrome({ tabsCreateThrows: true });
    loadWorker(stub);
    const res = await send(stub, { type: 'CHEATER_EXPORT', payload: samplePayload() });
    ok('error: a throwing handler still answers, with a reason',
      res && res.ok === false && typeof res.reason === 'string' && res.reason.length > 0,
      'got ' + JSON.stringify(res) + ' — the page can only show "Export failed" for this');
  }

  /* 5. a malformed payload must not hang the port */
  {
    const stub = makeChrome({});
    loadWorker(stub);
    const res = await send(stub, { type: 'CHEATER_EXPORT', payload: undefined });
    ok('error: a missing payload answers with a reason',
      res && res.ok === false && typeof res.reason === 'string',
      'got ' + JSON.stringify(res));
  }

  /* 6. collect path: no frame holds a selection */
  {
    const stub = makeChrome({ frames: [{ frameId: 0 }, { frameId: 12 }], frameReplies: {} });
    loadWorker(stub);
    const res = await send(stub, { type: 'CHEATER_CMD', cmd: 'export', tabId: 7 });
    ok('collect: an empty selection reports "empty", not a generic failure',
      res && res.ok === false && res.reason === 'empty', JSON.stringify(res));
  }

  /* 7. collect path: one frame answers, another has no content script */
  {
    const stub = makeChrome({
      frames: [{ frameId: 0 }, { frameId: 12 }],
      frameReplies: { 0: 'throw', 12: samplePayload() }
    });
    loadWorker(stub);
    const res = await send(stub, { type: 'CHEATER_CMD', cmd: 'export', tabId: 7 });
    ok('collect: a frame without the content script is skipped, export proceeds',
      res && res.ok === true, JSON.stringify(res));
  }

  /* 8. payload handoff to the export tab, then cleanup */
  {
    const stub = makeChrome({});
    loadWorker(stub);
    const created = await send(stub, { type: 'CHEATER_EXPORT', payload: samplePayload() });
    const id = created.id;
    const got = await send(stub, { type: 'CHEATER_GET_PAYLOAD', id });
    ok('handoff: the export tab can read its payload',
      got && got.ok === true && got.payload && got.payload.url === 'https://example.com/',
      JSON.stringify(got && got.ok));
    await send(stub, { type: 'CHEATER_RELEASE_PAYLOAD', id });
    const after = await send(stub, { type: 'CHEATER_GET_PAYLOAD', id });
    ok('handoff: payload is released after the tab reads it',
      after && after.ok === false, JSON.stringify(after && after.ok));
  }

  /* 9. late single font re-fetch */
  {
    const stub = makeChrome({});
    loadWorker(stub);
    const res = await send(stub, { type: 'CHEATER_FETCH_FONT', url: 'https://x.test/late.woff2' });
    ok('refetch: a late single font fetch returns base64 bytes',
      res && res.ok === true && typeof res.base64 === 'string' && res.bytes === 2048,
      JSON.stringify(res && { ok: res.ok, bytes: res.bytes }));
  }

  /* 10. grab must reach EVERY frame, not just the focused one */
  {
    // The keystroke lands in whichever frame has keyboard focus; the hover lives in
    // whichever frame contains the cursor. For a chart embedded in an iframe those
    // are different frames, and the frame that can see the hover never gets asked
    // unless the worker fans the request out.
    const stub = makeChrome({
      frames: [{ frameId: 0 }, { frameId: 3 }, { frameId: 8 }],
      // Only frame 3 is hovering something, which is the whole point.
      frameReplies: {
        0: { ok: false, grabbed: false },
        3: { ok: true, grabbed: true, frame: 'https://example.com/chart' },
        8: null
      }
    });
    loadWorker(stub);
    const res = await send(stub, { type: 'CHEATER_CMD', cmd: 'grab', tabId: 7 });
    ok('grab: fanned out to every frame, and the hovering frame wins',
      res && res.ok === true && res.grabbed === true, JSON.stringify(res));
    ok('grab: names which frame answered',
      res && res.frame === 'https://example.com/chart', JSON.stringify(res));
  }
  {
    // Nothing hovered anywhere: report it rather than claiming success, so the page
    // can say so instead of appearing to do nothing.
    const stub = makeChrome({
      frames: [{ frameId: 0 }, { frameId: 3 }],
      frameReplies: { 0: { ok: false, grabbed: false }, 3: { ok: false, grabbed: false } }
    });
    loadWorker(stub);
    const res = await send(stub, { type: 'CHEATER_CMD', cmd: 'grab', tabId: 7 });
    ok('grab: reports honestly when no frame is hovering',
      res && res.ok === true && res.grabbed === false, JSON.stringify(res));
  }
  {
    // A frame with no content script throws on sendMessage. That must not sink the
    // whole grab — the frame that IS hovering still has to win.
    const stub = makeChrome({
      frames: [{ frameId: 0 }, { frameId: 5 }],
      frameReplies: { 0: 'throw', 5: { ok: true, grabbed: true, frame: 'f5' } }
    });
    loadWorker(stub);
    const res = await send(stub, { type: 'CHEATER_CMD', cmd: 'grab', tabId: 7 });
    ok('grab: a dead frame does not sink the request',
      res && res.grabbed === true, JSON.stringify(res));
  }

  /* 11. unknown message types must not claim the port */
  {
    const stub = makeChrome({});
    loadWorker(stub);
    const res = await send(stub, { type: 'SOMETHING_ELSE' });
    ok('router: an unknown message does not hold the port open', res === undefined, JSON.stringify(res));
  }

  const failed = results.filter((r) => !r.pass);
  const lines = [
    `${results.length - failed.length}/${results.length} passed`,
    ...results.map((r) => `${r.pass ? '  ok   ' : '  FAIL '}${r.name}`)
  ];
  if (failed.length) {
    lines.push('', 'FAILURE DETAIL:');
    for (const f of failed) lines.push(`  ${f.name}\n    ${f.detail}`);
  }
  process.stdout.write(lines.join('\n') + '\n');
  process.exit(failed.length ? 1 : 0);
})();
