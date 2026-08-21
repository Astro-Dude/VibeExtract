/**
 * DOM Heist — capture history harness.
 *
 * Runs the worker's IndexedDB history code in a page context, where IndexedDB
 * behaves identically to the service worker's. background.js declares its
 * functions at top level, so injecting it exposes saveHistory/listHistory/etc.
 * directly.
 *
 * Run: browser_run_code_unsafe { filename: "test/run-history.js" }
 * (serve the repo first: python3 -m http.server 8931 --bind 127.0.0.1)
 */

async (page) => {
  const BASE = 'http://127.0.0.1:8931';

  await page.addInitScript(() => {
    // background.js registers listeners at load; these just need to exist.
    window.chrome = {
      runtime: { onMessage: { addListener() {} }, getURL: (p) => p, lastError: null },
      tabs: {
        create: async () => ({ id: 1 }),
        sendMessage: async () => null,
        captureVisibleTab: async () => null,
        onUpdated: { addListener() {} },
        onRemoved: { addListener() {} }
      },
      webNavigation: { getAllFrames: async () => [{ frameId: 0 }] },
      storage: { session: { set: async () => {}, get: async () => ({}), remove: async () => {} } },
      action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} }
    };
  });

  await page.goto(BASE + '/test/fixtures.html');
  await page.waitForTimeout(300);
  await page.addScriptTag({ url: BASE + '/background.js?v=' + Date.now() });

  return await page.evaluate(async () => {
    const out = [];
    const ok = (n, p, d) => out.push((p ? '  ok   ' : '  FAIL ') + n + (p ? '' : '  <<' + d + '>>'));

    // Start from a clean store so repeated runs are deterministic.
    await deleteHistory(null);

    const makePayload = (n, extraBytes) => ({
      url: 'https://example.com/page-' + n,
      title: 'Page ' + n,
      styles: { s1: { color: '#fff', filler: 'x'.repeat(extraBytes || 0) } },
      pseudos: {}, wrappers: {}, hovers: [],
      nodes: [{ k: 'e', tag: 'div', cls: ['s1'], attrs: {}, ch: [{ k: 't', v: 'node ' + n }] }],
      fonts: { google: [], icons: [], primary: 'Inter ' + n, primaryLoadable: true },
      fontFaces: [],
      diagnostics: {
        topLevel: 1, nodes: 10 + n,
        selections: [{ tag: 'div', classes: 'card-' + n, w: 100 + n, h: 40 }]
      }
    });

    /* ------------------------------------------------ save, list, read back */
    await saveHistory('h1', makePayload(1));
    await saveHistory('h2', makePayload(2));

    let listed = await listHistory();
    ok('history: entries are recorded and listed',
      listed.ok && listed.entries.length === 2, JSON.stringify(listed.ok && listed.entries.length));
    ok('history: newest first', listed.entries[0].id === 'h2', listed.entries.map((e) => e.id).join(','));

    const meta = listed.entries[0];
    ok('history: the row carries a usable summary',
      meta.url === 'https://example.com/page-2' && meta.label === 'div.card-2' &&
      meta.nodes === 12 && meta.bytes > 0 && meta.width === 102,
      JSON.stringify(meta));
    ok('history: the list does NOT carry payloads (that is what keeps it cheap)',
      meta.payload === undefined && meta.nodes !== undefined, JSON.stringify(Object.keys(meta)));

    const got = await getHistoryPayload('h1');
    ok('history: a payload round-trips intact',
      got.ok && got.payload.url === 'https://example.com/page-1' &&
      got.payload.nodes[0].ch[0].v === 'node 1',
      JSON.stringify(got.ok));

    const missing = await getHistoryPayload('nope');
    ok('history: a missing id reports a reason rather than throwing',
      !missing.ok && typeof missing.reason === 'string', JSON.stringify(missing));

    /* ------------------------------------------------------- pruning to ten */
    for (let i = 3; i <= 14; i += 1) await saveHistory('h' + i, makePayload(i));

    listed = await listHistory();
    ok('history: never keeps more than 10', listed.entries.length === 10, 'kept=' + listed.entries.length);
    ok('history: keeps the NEWEST ten, drops the oldest',
      listed.entries[0].id === 'h14' && !listed.entries.some((e) => e.id === 'h1' || e.id === 'h2'),
      listed.entries.map((e) => e.id).join(','));

    const dropped = await getHistoryPayload('h1');
    ok('history: a pruned entry payload is deleted too, not orphaned',
      !dropped.ok, JSON.stringify(dropped.ok));

    /* ---------------------------------------------------- delete and clear */
    await deleteHistory('h14');
    listed = await listHistory();
    ok('history: a single entry can be deleted',
      !listed.entries.some((e) => e.id === 'h14') && listed.entries.length === 9,
      listed.entries.map((e) => e.id).join(','));

    await deleteHistory(null);
    listed = await listHistory();
    ok('history: clear-all empties the store', listed.entries.length === 0, 'left=' + listed.entries.length);

    /* --------------------------------------------------------- byte budget */
    // 7 x 10 MB = 70 MB, which exceeds the 60 MB budget, so the budget must start
    // dropping entries while the count (7) is still under the limit of 10.
    for (let i = 1; i <= 7; i += 1) await saveHistory('big' + i, makePayload(i, 10 * 1024 * 1024));
    listed = await listHistory();
    const totalMb = listed.entries.reduce((n, e) => n + e.bytes, 0) / 1048576;
    ok('history: the byte budget caps total size even under the count limit',
      listed.entries.length < 7 && totalMb <= 61,
      'kept=' + listed.entries.length + ' total=' + totalMb.toFixed(1) + 'MB');
    ok('history: the newest big capture is always the one kept',
      listed.entries[0].id === 'big7', listed.entries.map((e) => e.id).join(','));

    await deleteHistory(null);
    return out.join('\n');
  });
}
