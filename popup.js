const startBtn = document.getElementById("start");
const clearBtn = document.getElementById("clear");
const exportBtn = document.getElementById("export");
const statusDiv = document.getElementById("status");
const statusDot = document.getElementById("status-dot");
const toggleSettings = document.getElementById("toggle-settings");
const settingsPanel = document.getElementById("settings-panel");
const saveShortcutsBtn = document.getElementById("save-shortcuts");
const resetShortcutsBtn = document.getElementById("reset-shortcuts");
const currentShortcutsDiv = document.getElementById("current-shortcuts");

// Detect Mac platform
const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0 || navigator.userAgent.includes('Mac');

// Add Mac class to body for CSS
if (isMac) {
  document.body.classList.add('is-mac');
  // Update Alt labels to Option on Mac
  document.querySelectorAll('.mod-alt-label').forEach(el => { el.textContent = 'Opt'; });
}

// Default shortcuts - use Cmd on Mac, Ctrl on other platforms
const DEFAULT_SHORTCUTS = {
  startSelect: { ctrl: !isMac, shift: true, alt: false, meta: isMac, key: 'S' },
  clearSelect: { ctrl: false, shift: false, alt: false, meta: false, key: 'Escape' },
  export: { ctrl: !isMac, shift: true, alt: false, meta: isMac, key: 'E' },
  extractPage: { ctrl: !isMac, shift: true, alt: false, meta: isMac, key: 'X' }
};

// Format shortcut for display
function formatShortcut(shortcut) {
  const parts = [];
  if (shortcut.meta) parts.push(isMac ? '\u2318' : 'Meta');
  if (shortcut.ctrl) parts.push(isMac ? '\u2303' : 'Ctrl');
  if (shortcut.shift) parts.push(isMac ? '\u21E7' : 'Shift');
  if (shortcut.alt) parts.push(isMac ? '\u2325' : 'Alt');
  parts.push(shortcut.key === 'Escape' ? 'ESC' : shortcut.key.toUpperCase());
  return parts.join(isMac ? '' : '+');
}

// Display current shortcuts as pills
function displayCurrentShortcuts(shortcuts) {
  const ep = shortcuts.extractPage || DEFAULT_SHORTCUTS.extractPage;
  const items = [
    { label: 'Select', shortcut: shortcuts.startSelect },
    { label: 'Clear', shortcut: shortcuts.clearSelect },
    { label: 'Export', shortcut: shortcuts.export },
    { label: 'Full Page', shortcut: ep }
  ];
  currentShortcutsDiv.innerHTML = items.map(item =>
    `<span class="shortcut-pill"><kbd>${formatShortcut(item.shortcut)}</kbd><span class="pill-label">${item.label}</span></span>`
  ).join('');
}

// Set status with dot state
function setStatus(text, active) {
  statusDiv.textContent = text;
  if (active) {
    statusDot.classList.add('active');
  } else {
    statusDot.classList.remove('active');
  }
}

// Load shortcuts into UI
function loadShortcutsToUI(shortcuts) {
  // Start Select
  document.getElementById('start-ctrl').checked = !!shortcuts.startSelect.ctrl;
  document.getElementById('start-meta').checked = !!shortcuts.startSelect.meta;
  document.getElementById('start-shift').checked = !!shortcuts.startSelect.shift;
  document.getElementById('start-alt').checked = !!shortcuts.startSelect.alt;
  document.getElementById('start-key').value = shortcuts.startSelect.key;

  // Clear Select
  document.getElementById('clear-ctrl').checked = !!shortcuts.clearSelect.ctrl;
  document.getElementById('clear-meta').checked = !!shortcuts.clearSelect.meta;
  document.getElementById('clear-shift').checked = !!shortcuts.clearSelect.shift;
  document.getElementById('clear-alt').checked = !!shortcuts.clearSelect.alt;
  document.getElementById('clear-key').value = shortcuts.clearSelect.key;

  // Export
  document.getElementById('export-ctrl').checked = !!shortcuts.export.ctrl;
  document.getElementById('export-meta').checked = !!shortcuts.export.meta;
  document.getElementById('export-shift').checked = !!shortcuts.export.shift;
  document.getElementById('export-alt').checked = !!shortcuts.export.alt;
  document.getElementById('export-key').value = shortcuts.export.key;

  // Extract Page
  const ep = shortcuts.extractPage || DEFAULT_SHORTCUTS.extractPage;
  document.getElementById('extract-ctrl').checked = !!ep.ctrl;
  document.getElementById('extract-meta').checked = !!ep.meta;
  document.getElementById('extract-shift').checked = !!ep.shift;
  document.getElementById('extract-alt').checked = !!ep.alt;
  document.getElementById('extract-key').value = ep.key;

  displayCurrentShortcuts(shortcuts);
}

// Get shortcuts from UI
function getShortcutsFromUI() {
  return {
    startSelect: {
      ctrl: document.getElementById('start-ctrl').checked,
      meta: document.getElementById('start-meta').checked,
      shift: document.getElementById('start-shift').checked,
      alt: document.getElementById('start-alt').checked,
      key: document.getElementById('start-key').value || 'S'
    },
    clearSelect: {
      ctrl: document.getElementById('clear-ctrl').checked,
      meta: document.getElementById('clear-meta').checked,
      shift: document.getElementById('clear-shift').checked,
      alt: document.getElementById('clear-alt').checked,
      key: document.getElementById('clear-key').value || 'Escape'
    },
    export: {
      ctrl: document.getElementById('export-ctrl').checked,
      meta: document.getElementById('export-meta').checked,
      shift: document.getElementById('export-shift').checked,
      alt: document.getElementById('export-alt').checked,
      key: document.getElementById('export-key').value || 'E'
    },
    extractPage: {
      ctrl: document.getElementById('extract-ctrl').checked,
      meta: document.getElementById('extract-meta').checked,
      shift: document.getElementById('extract-shift').checked,
      alt: document.getElementById('extract-alt').checked,
      key: document.getElementById('extract-key').value || 'X'
    }
  };
}

// Load saved shortcuts on popup open (migrate old shortcuts missing meta field)
chrome.storage.sync.get(['shortcuts'], (result) => {
  let shortcuts = result.shortcuts || DEFAULT_SHORTCUTS;
  // Migrate old shortcuts that don't have meta field
  for (const key of Object.keys(shortcuts)) {
    if (shortcuts[key] && shortcuts[key].meta === undefined) {
      shortcuts[key].meta = false;
    }
  }
  loadShortcutsToUI(shortcuts);
});

// Toggle settings panel
toggleSettings.addEventListener('click', () => {
  settingsPanel.classList.toggle('visible');
  toggleSettings.classList.toggle('open');
  const isOpen = settingsPanel.classList.contains('visible');
  toggleSettings.innerHTML = `<span class="arrow">&#9654;</span> ${isOpen ? 'Hide Shortcuts' : 'Customize Shortcuts'}`;
});

// Save shortcuts
saveShortcutsBtn.addEventListener('click', () => {
  const shortcuts = getShortcutsFromUI();
  chrome.storage.sync.set({ shortcuts }, () => {
    setStatus('Shortcuts saved!', true);
    displayCurrentShortcuts(shortcuts);
    setTimeout(() => {
      setStatus('Selection mode active', true);
    }, 1500);
  });
});

// Reset shortcuts to defaults
resetShortcutsBtn.addEventListener('click', () => {
  loadShortcutsToUI(DEFAULT_SHORTCUTS);
  chrome.storage.sync.set({ shortcuts: DEFAULT_SHORTCUTS }, () => {
    setStatus('Shortcuts reset to defaults!', false);
    setTimeout(() => {
      setStatus('Selection mode active', true);
    }, 1500);
  });
});

// Handle key input - capture actual key pressed
['start-key', 'clear-key', 'export-key', 'extract-key'].forEach(id => {
  const input = document.getElementById(id);
  input.addEventListener('keydown', (e) => {
    e.preventDefault();
    // Use the key name for special keys, otherwise the key character
    let keyName = e.key;
    if (keyName === ' ') keyName = 'Space';
    input.value = keyName;
  });
});

function getActiveTab(cb) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    cb(tabs[0]);
  });
}

function isTabCompatible(tab) {
  // Content scripts cannot run on certain pages
  if (!tab.url) return false;
  if (tab.url.startsWith("chrome://")) return false;
  if (tab.url.startsWith("chrome-extension://")) return false;
  if (tab.url.startsWith("about:")) return false;
  if (tab.url.startsWith("data:")) return false;
  return true;
}

async function sendMessageToTab(tab, message, callback) {
  if (!isTabCompatible(tab)) {
    setStatus("Can't run on this page type", false);
    callback(null);
    return;
  }

  // For export, we need to check all frames
  if (message.type === "EXPORT_SELECTION") {
    try {
      // Get all frames in the tab
      const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id });

      for (const frame of frames) {
        try {
          const response = await chrome.tabs.sendMessage(tab.id, message, { frameId: frame.frameId });
          if (response && response.toon) {
            callback(response);
            return;
          }
        } catch (e) {
          // Frame might not have content script, continue
        }
      }
      // No frame had selections
      callback(null);
    } catch (e) {
      // Fallback to main frame only
      chrome.tabs.sendMessage(tab.id, message, (response) => {
        if (chrome.runtime.lastError) {
          callback(null);
          return;
        }
        callback(response);
      });
    }
    return;
  }

  // For other messages, send to all frames
  try {
    const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
    for (const frame of frames) {
      try {
        await chrome.tabs.sendMessage(tab.id, message, { frameId: frame.frameId });
      } catch (e) {
        // Ignore frames without content script
      }
    }
    callback({ ok: true });
  } catch (e) {
    // Fallback
    chrome.tabs.sendMessage(tab.id, message, (response) => {
      if (chrome.runtime.lastError) {
        setStatus(`Error: ${chrome.runtime.lastError.message}`, false);
        callback(null);
        return;
      }
      callback(response);
    });
  }
}

function activateSelectionMode() {
  getActiveTab((tab) => {
    sendMessageToTab(tab, { type: "START_PICK_MODE" }, (response) => {
      if (!response) return;
      setStatus("Selection mode active", true);
    });
  });
}

startBtn.addEventListener("click", activateSelectionMode);

// Auto-activate selection mode when popup opens
activateSelectionMode();

clearBtn.addEventListener("click", () => {
  getActiveTab((tab) => {
    sendMessageToTab(tab, { type: "CLEAR_SELECTION" }, (response) => {
      if (response) {
        setStatus("Selection cleared", false);
      }
    });
  });
});

exportBtn.addEventListener("click", () => {
  getActiveTab((tab) => {
    sendMessageToTab(tab, { type: "EXPORT_SELECTION" }, (response) => {
      if (!response || !response.toon) {
        setStatus("No elements selected", false);
        return;
      }

      // Store export data and open the export page in a new tab
      chrome.storage.local.set({
        exportHTML: response.html,
        exportTOON: response.toon,
        exportSourceURL: tab.url || '',
        exportDiagnostics: response.diagnostics || null
      }, () => {
        chrome.tabs.create({ url: chrome.runtime.getURL('export.html') });
      });

      setStatus("Opening export page...", true);
    });
  });
});
