const startBtn = document.getElementById("start");
const clearBtn = document.getElementById("clear");
const exportBtn = document.getElementById("export");
const statusDiv = document.getElementById("status");
const toggleSettings = document.getElementById("toggle-settings");
const settingsPanel = document.getElementById("settings-panel");
const saveShortcutsBtn = document.getElementById("save-shortcuts");
const resetShortcutsBtn = document.getElementById("reset-shortcuts");
const currentShortcutsDiv = document.getElementById("current-shortcuts");

// Default shortcuts
const DEFAULT_SHORTCUTS = {
  startSelect: { ctrl: true, shift: true, alt: false, key: 'S' },
  clearSelect: { ctrl: false, shift: false, alt: false, key: 'Escape' },
  export: { ctrl: true, shift: true, alt: false, key: 'E' }
};

// Format shortcut for display
function formatShortcut(shortcut) {
  const parts = [];
  if (shortcut.ctrl) parts.push('Ctrl');
  if (shortcut.shift) parts.push('Shift');
  if (shortcut.alt) parts.push('Alt');
  parts.push(shortcut.key === 'Escape' ? 'ESC' : shortcut.key.toUpperCase());
  return parts.join('+');
}

// Display current shortcuts
function displayCurrentShortcuts(shortcuts) {
  currentShortcutsDiv.textContent = `Shortcuts: ${formatShortcut(shortcuts.startSelect)} (select), ${formatShortcut(shortcuts.clearSelect)} (clear), ${formatShortcut(shortcuts.export)} (export)`;
}

// Load shortcuts into UI
function loadShortcutsToUI(shortcuts) {
  // Start Select
  document.getElementById('start-ctrl').checked = shortcuts.startSelect.ctrl;
  document.getElementById('start-shift').checked = shortcuts.startSelect.shift;
  document.getElementById('start-alt').checked = shortcuts.startSelect.alt;
  document.getElementById('start-key').value = shortcuts.startSelect.key;

  // Clear Select
  document.getElementById('clear-ctrl').checked = shortcuts.clearSelect.ctrl;
  document.getElementById('clear-shift').checked = shortcuts.clearSelect.shift;
  document.getElementById('clear-alt').checked = shortcuts.clearSelect.alt;
  document.getElementById('clear-key').value = shortcuts.clearSelect.key;

  // Export
  document.getElementById('export-ctrl').checked = shortcuts.export.ctrl;
  document.getElementById('export-shift').checked = shortcuts.export.shift;
  document.getElementById('export-alt').checked = shortcuts.export.alt;
  document.getElementById('export-key').value = shortcuts.export.key;

  displayCurrentShortcuts(shortcuts);
}

// Get shortcuts from UI
function getShortcutsFromUI() {
  return {
    startSelect: {
      ctrl: document.getElementById('start-ctrl').checked,
      shift: document.getElementById('start-shift').checked,
      alt: document.getElementById('start-alt').checked,
      key: document.getElementById('start-key').value || 'S'
    },
    clearSelect: {
      ctrl: document.getElementById('clear-ctrl').checked,
      shift: document.getElementById('clear-shift').checked,
      alt: document.getElementById('clear-alt').checked,
      key: document.getElementById('clear-key').value || 'Escape'
    },
    export: {
      ctrl: document.getElementById('export-ctrl').checked,
      shift: document.getElementById('export-shift').checked,
      alt: document.getElementById('export-alt').checked,
      key: document.getElementById('export-key').value || 'E'
    }
  };
}

// Load saved shortcuts on popup open
chrome.storage.sync.get(['shortcuts'], (result) => {
  const shortcuts = result.shortcuts || DEFAULT_SHORTCUTS;
  loadShortcutsToUI(shortcuts);
});

// Toggle settings panel
toggleSettings.addEventListener('click', () => {
  settingsPanel.classList.toggle('visible');
  toggleSettings.textContent = settingsPanel.classList.contains('visible')
    ? 'Hide Shortcuts'
    : 'Customize Shortcuts';
});

// Save shortcuts
saveShortcutsBtn.addEventListener('click', () => {
  const shortcuts = getShortcutsFromUI();
  chrome.storage.sync.set({ shortcuts }, () => {
    statusDiv.textContent = 'Shortcuts saved!';
    displayCurrentShortcuts(shortcuts);
    setTimeout(() => {
      statusDiv.textContent = 'Selection mode active. Click elements to select.';
    }, 1500);
  });
});

// Reset shortcuts to defaults
resetShortcutsBtn.addEventListener('click', () => {
  loadShortcutsToUI(DEFAULT_SHORTCUTS);
  chrome.storage.sync.set({ shortcuts: DEFAULT_SHORTCUTS }, () => {
    statusDiv.textContent = 'Shortcuts reset to defaults!';
    setTimeout(() => {
      statusDiv.textContent = 'Selection mode active. Click elements to select.';
    }, 1500);
  });
});

// Handle key input - capture actual key pressed
['start-key', 'clear-key', 'export-key'].forEach(id => {
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
    statusDiv.textContent = "Extension doesn't work on this page type.";
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
        statusDiv.textContent = `Error: ${chrome.runtime.lastError.message}`;
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
      statusDiv.textContent = "Selection mode active. Click elements to select.";
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
        statusDiv.textContent = "Selection cleared.";
      }
    });
  });
});

exportBtn.addEventListener("click", () => {
  getActiveTab((tab) => {
    sendMessageToTab(tab, { type: "EXPORT_SELECTION" }, (response) => {
      if (!response || !response.toon) {
        statusDiv.textContent = "No elements selected.";
        return;
      }

      // Download TOON (for Claude - token optimized)
      const toonBlob = new Blob([response.toon], { type: "text/plain" });
      const toonUrl = URL.createObjectURL(toonBlob);
      const toonLink = document.createElement("a");
      toonLink.href = toonUrl;
      toonLink.download = "component.toon";
      toonLink.click();
      URL.revokeObjectURL(toonUrl);

      // Download HTML (for preview)
      setTimeout(() => {
        const htmlBlob = new Blob([response.html], { type: "text/html" });
        const htmlUrl = URL.createObjectURL(htmlBlob);
        const htmlLink = document.createElement("a");
        htmlLink.href = htmlUrl;
        htmlLink.download = "preview.html";
        htmlLink.click();
        URL.revokeObjectURL(htmlUrl);
      }, 100);

      statusDiv.textContent = "Exported! TOON for Claude, HTML for preview.";
    });
  });
});
