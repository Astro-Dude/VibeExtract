/**
 * Cheater — toolbar popup.
 *
 * Opening the popup is itself the "start selecting" gesture: selection mode
 * auto-activates on load, so the common case needs no click at all.
 */

'use strict';

(function () {
  var el = function (id) { return document.getElementById(id); };

  var isMac = /mac/i.test((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '');
  var PRIMARY_LABEL = isMac ? '⌘' : 'Ctrl';
  var ALT_LABEL = isMac ? 'Opt' : 'Alt';

  var DEFAULT_SHORTCUTS = {
    start: { primary: true, shift: true, alt: false, key: 'S' },
    export: { primary: true, shift: true, alt: false, key: 'E' },
    fullpage: { primary: true, shift: true, alt: false, key: 'X' },
    history: { primary: true, shift: true, alt: false, key: 'H' },
    pause: { primary: true, shift: true, alt: false, key: 'P' },
    grab: { primary: true, shift: true, alt: false, key: 'G' },
    diagnose: { primary: true, shift: true, alt: false, key: 'D' }
  };

  // Pages where no extension content script can run. Saying so plainly beats
  // three dead buttons and no explanation.
  var BLOCKED_SCHEMES = ['chrome:', 'chrome-extension:', 'about:', 'data:', 'edge:', 'devtools:', 'view-source:'];
  var BLOCKED_HOSTS = ['chrome.google.com', 'chromewebstore.google.com'];

  var state = { tab: null, shortcuts: DEFAULT_SHORTCUTS, blocked: false, history: [], status: null };

  /* ---------------------------------------------------------------- helpers */

  function comboLabel(config) {
    if (!config || !config.key) return '—';
    var parts = [];
    if (config.primary) parts.push(PRIMARY_LABEL);
    if (config.shift) parts.push('Shift');
    if (config.alt) parts.push(ALT_LABEL);
    parts.push(String(config.key).toUpperCase());
    return parts.join('+');
  }

  function sendToTab(message) {
    return new Promise(function (resolve) {
      if (!state.tab) { resolve(null); return; }
      try {
        chrome.tabs.sendMessage(state.tab.id, message, function (response) {
          if (chrome.runtime.lastError) resolve(null);
          else resolve(response);
        });
      } catch (_) { resolve(null); }
    });
  }

  function sendToWorker(message) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage(message, function (response) {
          if (chrome.runtime.lastError) resolve(null);
          else resolve(response);
        });
      } catch (_) { resolve(null); }
    });
  }

  function isBlocked(url) {
    if (!url) return true;
    for (var i = 0; i < BLOCKED_SCHEMES.length; i += 1) {
      if (url.indexOf(BLOCKED_SCHEMES[i]) === 0) return true;
    }
    try {
      var host = new URL(url).hostname;
      if (BLOCKED_HOSTS.indexOf(host) !== -1) return true;
    } catch (_) { return true; }
    return false;
  }

  /* ------------------------------------------------------------------ render */

  function renderShortcuts() {
    var rows = [
      ['Start selection', comboLabel(state.shortcuts.start)],
      ['Export selection', comboLabel(state.shortcuts.export)],
      ['Extract full page', comboLabel(state.shortcuts.fullpage)],
      ['Recent captures', comboLabel(state.shortcuts.history)],
      ['Select / interact mode', comboLabel(state.shortcuts.pause)],
      ['Grab what you hover', comboLabel(state.shortcuts.grab)],
      ['Diagnose what is visible', comboLabel(state.shortcuts.diagnose)],
      ['Clear / exit', 'Esc'],
      ['Exact target', ALT_LABEL + '+Click'],
      ['Multi-select', 'Shift+Click'],
      ['Parent / child', ALT_LABEL + '+↑ / ' + ALT_LABEL + '+↓'],
      ['Walk the tree', ALT_LABEL + '+Scroll']
    ];
    el('keys').innerHTML = rows.map(function (row) {
      return '<div class="keyrow"><span class="name">' + row[0] +
        '</span><span class="kbd">' + row[1] + '</span></div>';
    }).join('');
  }

  function renderStatus(status) {
    var dot = el('dot');
    var text = el('status');

    if (state.blocked) {
      dot.className = 'dot bad';
      text.innerHTML = 'inactive';
      return;
    }
    if (!status) {
      dot.className = 'dot bad';
      text.innerHTML = 'content script not loaded — <b>reload the page</b>';
      return;
    }
    var held = status.count
      ? ' · <b>' + status.count + '</b> element' + (status.count === 1 ? '' : 's') + ' held'
      : '';

    if (status.paused) {
      dot.className = 'dot paused';
      text.innerHTML = 'interact · <b>the page has your clicks</b>' + held;
      el('start').textContent = 'Select mode';
      el('start').classList.add('pri');
    } else if (status.active) {
      dot.className = 'dot on';
      text.innerHTML = status.count ? 'selecting' + held : 'selecting · <b>click an element</b>';
      el('start').textContent = 'Interact mode';
      el('start').classList.remove('pri');
    } else {
      dot.className = 'dot';
      text.innerHTML = 'idle';
      el('start').textContent = 'Start';
      el('start').classList.add('pri');
    }
    state.status = status;
    el('export').disabled = !status.count;
  }

  function renderEditor() {
    document.querySelectorAll('.mod-label').forEach(function (node) { node.textContent = PRIMARY_LABEL; });
    document.querySelectorAll('.alt-label').forEach(function (node) { node.textContent = ALT_LABEL; });

    document.querySelectorAll('.edrow').forEach(function (row) {
      var config = state.shortcuts[row.dataset.action] || {};
      row.querySelectorAll('input[data-mod]').forEach(function (input) {
        input.checked = !!config[input.dataset.mod];
        input.closest('.chk').classList.toggle('on', input.checked);
      });
      row.querySelector('[data-key]').value = String(config.key || '').toUpperCase();
    });
  }

  function renderNote() {
    el('note').innerHTML = state.blocked
      ? ''
      : 'Click a small element and Cheater expands to the surrounding component. ' +
        '<b>' + ALT_LABEL + '+Click</b> takes the exact element. ' +
        '<b>' + ALT_LABEL + '+↑/↓</b> moves the selection to its parent or child.';
  }

  /* ---------------------------------------------------------------- history */

  function timeAgo(ms) {
    var seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (seconds < 60) return seconds + 's';
    if (seconds < 3600) return Math.round(seconds / 60) + 'm';
    if (seconds < 86400) return Math.round(seconds / 3600) + 'h';
    return Math.round(seconds / 86400) + 'd';
  }

  function hostOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch (_) { return url || ''; }
  }

  /**
   * The popup is the only surface always one click away, so past captures live
   * here too — not just in an export tab you may not have open. Rows are read from
   * the same worker store the export tab uses; clicking one opens it there.
   */
  async function renderHistory() {
    var response = await sendToWorker({ type: 'CHEATER_HISTORY_LIST' });
    var list = el('hist-list');

    if (!response || !response.ok) {
      el('hist-count').textContent = '';
      list.innerHTML = '<div class="hist-empty">History unavailable' +
        (response && response.reason ? ': ' + response.reason : '') + '</div>';
      return;
    }

    state.history = response.entries || [];
    el('hist-count').textContent = state.history.length
      ? state.history.length + (state.history.length === 10 ? ' (max)' : '')
      : '0';

    if (!state.history.length) {
      list.innerHTML = '<div class="hist-empty">Nothing captured yet. ' +
        'The last 10 exports appear here.</div>';
      return;
    }

    list.innerHTML = state.history.map(function (entry) {
      return '<button class="hitem" data-id="' + entry.id + '" title="' +
        (entry.url || '').replace(/"/g, '&quot;') + '">' +
        '<span class="hi-when">' + timeAgo(entry.createdAt) + '</span>' +
        '<span class="hi-what">' + (entry.label || 'selection') + '</span>' +
        '<span class="hi-where">' + hostOf(entry.url) + '</span>' +
        '</button>';
    }).join('');
  }

  /* -------------------------------------------------------------------- boot */

  async function boot() {
    el('ver').textContent = 'v' + chrome.runtime.getManifest().version;

    var tabs = await new Promise(function (resolve) {
      chrome.tabs.query({ active: true, currentWindow: true }, resolve);
    });
    state.tab = tabs && tabs[0];

    var stored = await new Promise(function (resolve) {
      chrome.storage.sync.get({ shortcuts: null }, resolve);
    });
    state.shortcuts = (stored && stored.shortcuts) || DEFAULT_SHORTCUTS;

    renderShortcuts();
    renderEditor();

    if (!state.tab || isBlocked(state.tab.url)) {
      state.blocked = true;
      var scheme = '';
      try { scheme = new URL(state.tab.url).protocol; } catch (_) { scheme = 'this'; }
      el('blocked').textContent =
        'Cheater can\'t run on this page type (' + scheme + '). Chrome blocks extension ' +
        'content scripts on browser-internal pages, the Web Store, and view-source. ' +
        'Open a normal http(s) page and try again.';
      el('blocked').classList.remove('hidden');
      el('main').classList.add('hidden');
      renderStatus(null);
      renderNote();
      return;
    }

    renderNote();

    // Opening the popup IS the start gesture.
    await sendToWorker({ type: 'CHEATER_CMD', cmd: 'start', tabId: state.tab.id });
    var status = await sendToTab({ type: 'CHEATER_STATUS' });
    renderStatus(status);

    // The count is worth knowing without expanding the section.
    renderHistory();

    // The popup stays open while you click on the page in some window setups, so
    // keep the count live rather than stale.
    setInterval(async function () {
      if (state.blocked) return;
      renderStatus(await sendToTab({ type: 'CHEATER_STATUS' }));
    }, 700);
  }

  /* ------------------------------------------------------------------ wiring */

  el('start').addEventListener('click', async function () {
    var status = state.status || {};
    if (status.active) {
      // Toggling pause from here is convenient, but note the caveat in the hint:
      // closing the popup is a mouse action and can dismiss the very menu you are
      // trying to capture, so the keyboard shortcut is the reliable route.
      await sendToTab({ type: 'CHEATER_PAUSE', paused: !status.paused });
    } else {
      await sendToWorker({ type: 'CHEATER_CMD', cmd: 'start', tabId: state.tab.id });
    }
    renderStatus(await sendToTab({ type: 'CHEATER_STATUS' }));
  });

  el('clear').addEventListener('click', async function () {
    await sendToWorker({ type: 'CHEATER_CMD', cmd: 'clear', tabId: state.tab.id });
    renderStatus(await sendToTab({ type: 'CHEATER_STATUS' }));
  });

  el('export').addEventListener('click', async function () {
    var result = await sendToWorker({ type: 'CHEATER_CMD', cmd: 'export', tabId: state.tab.id });
    if (result && result.ok) window.close();
    else renderStatus(await sendToTab({ type: 'CHEATER_STATUS' }));
  });

  el('hist-toggle').addEventListener('click', async function () {
    var open = !el('histbox').classList.contains('open');
    el('histbox').classList.toggle('open', open);
    el('hist-toggle').classList.toggle('open', open);
    if (open) await renderHistory();
  });

  el('hist-list').addEventListener('click', async function (event) {
    var row = event.target.closest('.hitem');
    if (!row) return;
    var result = await sendToWorker({ type: 'CHEATER_OPEN_HISTORY', id: row.dataset.id });
    if (result && result.ok) window.close();
    else el('status').innerHTML = 'could not open that capture';
  });

  el('hist-clear').addEventListener('click', async function () {
    await sendToWorker({ type: 'CHEATER_HISTORY_DELETE' });
    await renderHistory();
  });

  el('customize-toggle').addEventListener('click', function () {
    el('customize-toggle').classList.toggle('open');
    el('editor').classList.toggle('open');
  });

  document.querySelectorAll('input[data-mod]').forEach(function (input) {
    input.addEventListener('change', function () {
      input.closest('.chk').classList.toggle('on', input.checked);
    });
  });

  // Key capture: read the physical key, ignoring the modifiers (those are the
  // checkboxes' job) so pressing ⌘⇧S while focused records just "S".
  document.querySelectorAll('[data-key]').forEach(function (input) {
    input.addEventListener('focus', function () { input.classList.add('capturing'); input.value = '…'; });
    input.addEventListener('blur', function () {
      input.classList.remove('capturing');
      if (input.value === '…') {
        var action = input.closest('.edrow').dataset.action;
        input.value = String((state.shortcuts[action] || {}).key || '').toUpperCase();
      }
    });
    input.addEventListener('keydown', function (event) {
      event.preventDefault();
      event.stopPropagation();
      var key = event.key;
      if (key === 'Tab' || key === 'Escape') { input.blur(); return; }
      if (key.length !== 1 && !/^F\d+$/.test(key) && key !== 'ArrowUp' && key !== 'ArrowDown') return;
      input.value = key.length === 1 ? key.toUpperCase() : key;
      input.blur();
    });
  });

  el('save-keys').addEventListener('click', async function () {
    // Start from the defaults rather than an empty object: the editor is built from
    // the rows present in the markup, so an action whose row is missing would be
    // deleted from the saved config and its key would silently stop working.
    var next = Object.assign({}, DEFAULT_SHORTCUTS, state.shortcuts);
    var valid = true;
    document.querySelectorAll('.edrow').forEach(function (row) {
      var config = { primary: false, shift: false, alt: false, key: '' };
      row.querySelectorAll('input[data-mod]').forEach(function (input) {
        config[input.dataset.mod] = input.checked;
      });
      config.key = row.querySelector('[data-key]').value.trim();
      if (!config.key || config.key === '…') valid = false;
      next[row.dataset.action] = config;
    });

    if (!valid) {
      el('status').innerHTML = '<b style="color:#FF4A3D">every shortcut needs a key</b>';
      return;
    }

    await new Promise(function (resolve) { chrome.storage.sync.set({ shortcuts: next }, resolve); });
    state.shortcuts = next;
    renderShortcuts();
    // Push to every frame so the change takes effect without a page reload.
    chrome.tabs.sendMessage(state.tab.id, { type: 'CHEATER_SHORTCUTS', shortcuts: next }, function () {
      void chrome.runtime.lastError;
    });
    el('status').innerHTML = 'shortcuts <b>saved</b>';
  });

  el('reset-keys').addEventListener('click', async function () {
    state.shortcuts = JSON.parse(JSON.stringify(DEFAULT_SHORTCUTS));
    await new Promise(function (resolve) { chrome.storage.sync.set({ shortcuts: state.shortcuts }, resolve); });
    renderShortcuts();
    renderEditor();
    chrome.tabs.sendMessage(state.tab.id, { type: 'CHEATER_SHORTCUTS', shortcuts: state.shortcuts }, function () {
      void chrome.runtime.lastError;
    });
    el('status').innerHTML = 'shortcuts <b>reset</b>';
  });

  boot();
})();
