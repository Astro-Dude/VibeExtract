// --- State ---
let pickMode = false;
let hoverElement = null;
let selectedElements = new Set();
// Store clones at selection time to freeze dynamic content (like rotating ProTips)
let selectionClones = new Map(); // original element -> clone (captured at selection time)

// --- Scroll-navigation state ---
let isScrollNavigating = false;   // true when user has scrolled to override the natural hover target
let scrollNavigatedElement = null; // the element currently reached via scroll navigation

// Debug: Log when script loads
console.log('[VibeExtract] Content script loaded in frame:', window.location.href.substring(0, 100));

// --- Style Registry for deduplication ---
let styleRegistry = new Map(); // styleString -> styleName (s1, s2, etc.)
let hoverStyleRegistry = new Map(); // Maps base styleName -> hover styles object
let styleCounter = 0;

function resetStyleRegistry() {
  styleRegistry.clear();
  hoverStyleRegistry.clear();
  styleCounter = 0;
  resetDetectedFonts();
}

function getOrCreateStyleName(styleObj) {
  const key = JSON.stringify(styleObj);
  if (styleRegistry.has(key)) {
    return styleRegistry.get(key);
  }
  const name = `s${++styleCounter}`;
  styleRegistry.set(key, name);
  return name;
}

function registerHoverStyle(styleName, hoverObj) {
  if (hoverObj && Object.keys(hoverObj).length > 0) {
    hoverStyleRegistry.set(styleName, hoverObj);
  }
}

// --- Shadow DOM helpers ---
// For closed shadow DOM, we can access elements via composedPath() during events
// but we can't traverse into them programmatically. However, we CAN select
// the elements inside and export them using the event path.

function getShadowRoot(el) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) return null;
  // Only open shadow roots are accessible
  if (el.shadowRoot) return el.shadowRoot;
  return null;
}

// Get the shadow root containing an element (if any) by walking up
function getContainingShadowRoot(el) {
  let node = el;
  while (node) {
    if (node.parentNode && node.parentNode.host) {
      // We're inside a shadow root
      return node.parentNode;
    }
    node = node.parentNode;
  }
  return null;
}

// Track shadow roots we've injected styles into
const injectedShadowRoots = new WeakSet();

// --- Inject helper styles (works for both document and shadow roots) ---
function injectHelperStyles(root = document) {
  const styleId = "web-replica-helper-style";

  // Check if already injected
  if (root === document) {
    if (document.getElementById(styleId)) return;
  } else {
    // For shadow roots, check via querySelector
    if (root.querySelector && root.querySelector(`#${styleId}`)) return;
  }

  const style = document.createElement("style");
  style.id = styleId;
  style.textContent = `
    .web-replica-hover {
      outline: 2px solid red !important;
      cursor: crosshair !important;
    }
    .web-replica-selected {
      cursor: crosshair !important;
    }
    .web-replica-selected:not(html):not(body) {
      outline: 3px solid rgba(59, 130, 246, 0.8) !important;
      outline-offset: -3px !important;
    }
    #web-replica-overlay {
      position: fixed !important;
      background-color: rgba(59, 130, 246, 0.12) !important;
      z-index: 2147483647 !important;
      pointer-events: none !important;
      border: 2px solid rgba(59, 130, 246, 0.4) !important;
      border-radius: 2px !important;
      transition: top 0.1s, left 0.1s, width 0.1s, height 0.1s !important;
    }
  `;

  if (root === document) {
    document.documentElement.appendChild(style);
  } else if (root.appendChild) {
    root.appendChild(style);
  }
}

function ensureStylesInShadow(el) {
  // Check if element has an open shadow root
  const shadowRoot = getShadowRoot(el);
  if (shadowRoot && !injectedShadowRoots.has(shadowRoot)) {
    injectHelperStyles(shadowRoot);
    injectedShadowRoots.add(shadowRoot);
  }
}

// Inject styles into shadow root found in event path
function ensureStylesInEventPath(path) {
  for (let i = 0; i < path.length; i++) {
    const node = path[i];
    // Check if this is a ShadowRoot (has host property)
    if (node && node.host && !injectedShadowRoots.has(node)) {
      injectHelperStyles(node);
      injectedShadowRoots.add(node);
    }
    // Also check for open shadow roots on elements
    if (node && node.nodeType === Node.ELEMENT_NODE) {
      ensureStylesInShadow(node);
    }
  }
}

// Inject styles into document on load
(function() {
  injectHelperStyles(document);
})();

// --- Hover handling (with Shadow DOM support) ---
document.addEventListener(
  "mouseover",
  (e) => {
    if (!pickMode) return;

    // Use composedPath to get actual target inside Shadow DOM
    const path = e.composedPath();
    const actualTarget = path[0];

    // Inject styles into any shadow roots along the path (including closed ones!)
    ensureStylesInEventPath(path);

    // During scroll navigation, don't let mouseover snap back to the deepest child.
    // Only break out when the mouse moves to a genuinely different area.
    if (isScrollNavigating) {
      if (actualTarget === scrollNavigatedElement) return;
      if (scrollNavigatedElement && scrollNavigatedElement.contains(actualTarget)) return;
      // Mouse moved to a different area — exit scroll navigation
      isScrollNavigating = false;
      scrollNavigatedElement = null;
    }

    if (hoverElement && hoverElement !== actualTarget) {
      if (hoverElement.classList) {
        hoverElement.classList.remove("web-replica-hover");
      }
    }
    hoverElement = actualTarget;
    if (hoverElement && hoverElement.classList) {
      hoverElement.classList.add("web-replica-hover");
    }
  },
  true
);

document.addEventListener(
  "mouseout",
  (e) => {
    if (!pickMode) return;

    // During scroll navigation, only clear if mouse fully leaves the navigated element
    if (isScrollNavigating && scrollNavigatedElement) {
      const relatedTarget = e.relatedTarget;
      if (relatedTarget && (relatedTarget === scrollNavigatedElement || scrollNavigatedElement.contains(relatedTarget))) {
        return;
      }
      // Mouse left the scroll-navigated element entirely
      if (hoverElement && hoverElement.classList) {
        hoverElement.classList.remove("web-replica-hover");
      }
      hoverElement = null;
      isScrollNavigating = false;
      scrollNavigatedElement = null;
      return;
    }

    const actualTarget = e.composedPath()[0];
    if (actualTarget === hoverElement) {
      if (hoverElement && hoverElement.classList) {
        hoverElement.classList.remove("web-replica-hover");
      }
      hoverElement = null;
    }
  },
  true
);

// --- Selection overlay ---
function getOrCreateOverlay() {
  let overlay = document.getElementById('web-replica-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'web-replica-overlay';
    document.documentElement.appendChild(overlay);
  }
  return overlay;
}

function updateOverlay() {
  const overlay = getOrCreateOverlay();
  if (selectedElements.size === 0) {
    overlay.style.display = 'none';
    return;
  }
  // Compute bounding box covering all selected elements
  let top = Infinity, left = Infinity, bottom = -Infinity, right = -Infinity;
  selectedElements.forEach((el) => {
    const rect = el.getBoundingClientRect();
    if (rect.top < top) top = rect.top;
    if (rect.left < left) left = rect.left;
    if (rect.bottom > bottom) bottom = rect.bottom;
    if (rect.right > right) right = rect.right;
  });
  overlay.style.display = 'block';
  overlay.style.top = top + 'px';
  overlay.style.left = left + 'px';
  overlay.style.width = (right - left) + 'px';
  overlay.style.height = (bottom - top) + 'px';
}

function removeOverlay() {
  const overlay = document.getElementById('web-replica-overlay');
  if (overlay) overlay.style.display = 'none';
}

// --- Utility: select/deselect element ---
function toggleElement(el, shouldSelect) {
  if (!el || !el.classList) {
    console.log('[VibeExtract] Cannot select element - no classList:', el);
    return;
  }
  if (shouldSelect) {
    el.classList.add("web-replica-selected");
    selectedElements.add(el);
    // IMPORTANT: Clone immediately at selection time to freeze dynamic content
    // This captures the exact DOM state the user sees when they click
    const clone = el.cloneNode(true);
    selectionClones.set(el, clone);
    const inShadow = getContainingShadowRoot(el) ? 'YES' : 'NO';
    console.log('[VibeExtract] Selected element:', el.tagName, 'In Shadow DOM:', inShadow, 'Total:', selectedElements.size);
  } else {
    el.classList.remove("web-replica-selected");
    selectedElements.delete(el);
    selectionClones.delete(el);
    console.log('[VibeExtract] Deselected element, remaining:', selectedElements.size);
  }
  updateOverlay();
}

// --- Click handling (with Shadow DOM support) ---
document.addEventListener(
  "mousedown",
  (e) => {
    if (!pickMode) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    // Use composedPath to get actual target inside Shadow DOM
    const path = e.composedPath();

    // Inject styles into any shadow roots along the path (including closed ones!)
    ensureStylesInEventPath(path);

    // If scroll-navigating, select the navigated element instead of deepest child
    const el = isScrollNavigating ? scrollNavigatedElement : path[0];

    // Reset scroll navigation after click
    isScrollNavigating = false;
    scrollNavigatedElement = null;

    if (!el || !el.classList) return;

    if (!e.shiftKey && !selectedElements.has(el)) {
      selectedElements.forEach((sel) =>
        sel.classList.remove("web-replica-selected")
      );
      selectedElements.clear();
      selectionClones.clear();
      removeOverlay();
    }

    if (selectedElements.has(el)) {
      toggleElement(el, false);
    } else {
      toggleElement(el, true);
    }
  },
  true
);

document.addEventListener(
  "click",
  (e) => {
    if (!pickMode) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  },
  true
);

// --- Scroll wheel navigation (parent/child traversal) ---
document.addEventListener(
  "wheel",
  (e) => {
    if (!pickMode) return;
    if (!hoverElement) return;

    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    let targetElement = null;

    if (e.deltaY < 0) {
      targetElement = getScrollParent(hoverElement);
    } else if (e.deltaY > 0) {
      targetElement = getFirstElementChild(hoverElement);
    }

    if (!targetElement || !targetElement.classList) return;

    // Update hover
    if (hoverElement && hoverElement.classList) {
      hoverElement.classList.remove("web-replica-hover");
    }
    ensureStylesInShadow(targetElement);
    hoverElement = targetElement;
    scrollNavigatedElement = targetElement;
    isScrollNavigating = true;
    hoverElement.classList.add("web-replica-hover");

    // Auto-select the navigated element
    selectedElements.forEach((sel) => sel.classList.remove("web-replica-selected"));
    selectedElements.clear();
    selectionClones.clear();
    toggleElement(targetElement, true);

    showModeIndicator(getElementDescriptor(hoverElement));
  },
  { capture: true, passive: false }
);

// --- Keyboard shortcuts (customizable) ---
// Detect Mac platform
const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0 || navigator.userAgent.includes('Mac');

// Default shortcuts - will be overridden by stored settings
// On Mac, use Cmd (meta) instead of Ctrl
let shortcuts = {
  startSelect: { ctrl: !isMac, shift: true, alt: false, meta: isMac, key: 'S' },
  clearSelect: { ctrl: false, shift: false, alt: false, meta: false, key: 'Escape' },
  export: { ctrl: !isMac, shift: true, alt: false, meta: isMac, key: 'E' },
  extractPage: { ctrl: !isMac, shift: true, alt: false, meta: isMac, key: 'X' }
};

// Load shortcuts from storage (with context check)
try {
  if (chrome.storage && chrome.storage.sync) {
    chrome.storage.sync.get(['shortcuts'], (result) => {
      if (chrome.runtime.lastError) return;
      if (result.shortcuts) {
        // Migrate old shortcuts missing meta field
        for (const key of Object.keys(result.shortcuts)) {
          if (result.shortcuts[key] && result.shortcuts[key].meta === undefined) {
            result.shortcuts[key].meta = false;
          }
        }
        shortcuts = result.shortcuts;
        console.log('[VibeExtract] Loaded custom shortcuts:', shortcuts);
      }
    });
  }
} catch (e) {
  console.log('[VibeExtract] Could not load shortcuts:', e.message);
}

// Listen for shortcut updates from popup (with context check)
try {
  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, namespace) => {
      if (namespace === 'sync' && changes.shortcuts) {
        shortcuts = changes.shortcuts.newValue;
        console.log('[VibeExtract] Shortcuts updated:', shortcuts);
      }
    });
  }
} catch (e) {
  console.log('[VibeExtract] Could not add storage listener:', e.message);
}

// Check if a keyboard event matches a shortcut
function matchesShortcut(e, shortcut) {
  if (!e || !e.key || !shortcut || !shortcut.key) return false;
  const keyMatch = e.key.toLowerCase() === shortcut.key.toLowerCase() ||
                   e.key === shortcut.key;
  return keyMatch &&
         e.ctrlKey === !!shortcut.ctrl &&
         e.shiftKey === !!shortcut.shift &&
         e.altKey === !!shortcut.alt &&
         e.metaKey === !!shortcut.meta;
}

// Check if extension context is still valid
function isExtensionContextValid() {
  try {
    return chrome.runtime && chrome.runtime.id;
  } catch (e) {
    return false;
  }
}

// Download files via background script (bypasses CSP restrictions)
function downloadFiles(toonContent, htmlContent) {
  if (!isExtensionContextValid()) {
    console.warn("[VibeExtract] Extension context invalidated. Please refresh the page.");
    alert("VibeExtract: Extension was reloaded. Please refresh this page to continue using the extension.");
    return;
  }

  chrome.runtime.sendMessage({
    type: 'OPEN_EXPORT_TAB',
    toon: toonContent,
    html: htmlContent,
    sourceURL: window.location.href
  }, (response) => {
    if (chrome.runtime.lastError) {
      console.error("[VibeExtract] Export error:", chrome.runtime.lastError);
    } else {
      console.log("[VibeExtract] Export tab opened");
    }
  });
}

// Perform export action
function performExport() {
  console.log("[VibeExtract] Export triggered, selected:", selectedElements.size);
  if (selectedElements.size > 0) {
    const result = buildExport();
    if (result && result.toon && result.html) {
      console.log("[VibeExtract] Export data generated, downloading...");

      // Download both files via background script
      downloadFiles(result.toon, result.html);

      console.log("[VibeExtract] Export complete");
      return true;
    } else {
      console.log("[VibeExtract] buildExport returned null or incomplete");
    }
  } else {
    console.log("[VibeExtract] No elements selected for export");
  }
  return false;
}

// Visual feedback for selection mode
function showModeIndicator(message) {
  let indicator = document.getElementById('VibeExtract-indicator');
  if (!indicator) {
    indicator = document.createElement('div');
    indicator.id = 'VibeExtract-indicator';
    indicator.style.cssText = `
      position: fixed;
      top: 10px;
      right: 10px;
      background: #4a90d9;
      color: white;
      padding: 8px 16px;
      border-radius: 4px;
      font-family: system-ui, sans-serif;
      font-size: 14px;
      z-index: 2147483647;
      pointer-events: none;
      box-shadow: 0 2px 8px rgba(0,0,0,0.3);
      transition: opacity 0.3s;
    `;
    document.body.appendChild(indicator);
  }
  indicator.textContent = message;
  indicator.style.opacity = '1';

  // Auto-hide after 2 seconds
  clearTimeout(indicator._timeout);
  indicator._timeout = setTimeout(() => {
    indicator.style.opacity = '0';
  }, 2000);
}

// --- Element descriptor for mode indicator ---
function getElementDescriptor(el) {
  if (!el) return '';
  const tag = el.tagName.toLowerCase();
  let descriptor = tag;
  if (el.id) {
    descriptor += '#' + el.id;
  } else if (el.classList && el.classList.length > 0) {
    for (const cls of el.classList) {
      if (cls !== 'web-replica-hover' && cls !== 'web-replica-selected') {
        descriptor += '.' + cls;
        break;
      }
    }
  }
  return descriptor;
}

// Use capturing phase to intercept before page handlers
document.addEventListener("keydown", (e) => {
  // Start selection mode
  if (matchesShortcut(e, shortcuts.startSelect)) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    pickMode = true;
    showModeIndicator('Selection mode ON');
    console.log("[VibeExtract] Selection mode started");
    return false;
  }

  // Clear selection - only capture ESC when extension is active (pickMode or has selections)
  if (matchesShortcut(e, shortcuts.clearSelect)) {
    // Only intercept if extension is actively being used
    if (pickMode || selectedElements.size > 0) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      selectedElements.forEach((el) => el.classList.remove("web-replica-selected"));
      selectedElements.clear();
      selectionClones.clear();
      removeOverlay();
      pickMode = false;
      isScrollNavigating = false;
      scrollNavigatedElement = null;
      showModeIndicator('Selection cleared');
      console.log("[VibeExtract] Selection cleared");
      return false;
    }
    // Otherwise let ESC do its normal Chrome job
  }

  // Export selection
  if (matchesShortcut(e, shortcuts.export)) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    if (selectedElements.size > 0) {
      showModeIndicator('Exporting...');
      const success = performExport();
      if (success) {
        setTimeout(() => showModeIndicator('Exported!'), 100);
      } else {
        showModeIndicator('Export failed');
      }
    } else {
      showModeIndicator('No elements selected');
    }
    return false;
  }

  // Extract whole page (select body + export)
  if (matchesShortcut(e, shortcuts.extractPage)) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    // Clear any existing selection
    selectedElements.forEach((sel) => sel.classList.remove("web-replica-selected"));
    selectedElements.clear();
    selectionClones.clear();
    // Select the body element
    const body = document.body;
    if (body) {
      toggleElement(body, true);
      showModeIndicator('Exporting full page...');
      const success = performExport();
      if (success) {
        setTimeout(() => showModeIndicator('Full page exported!'), 100);
      } else {
        showModeIndicator('Export failed');
      }
    } else {
      showModeIndicator('No body element found');
    }
    return false;
  }

  // Alt+Arrow: navigate parent/child and auto-select
  if (pickMode && e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    if (!hoverElement) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    let targetElement = null;
    if (e.key === 'ArrowUp') {
      targetElement = getScrollParent(hoverElement);
    } else {
      targetElement = getFirstElementChild(hoverElement);
    }

    if (!targetElement || !targetElement.classList) return false;

    // Update hover highlight
    if (hoverElement && hoverElement.classList) {
      hoverElement.classList.remove("web-replica-hover");
    }
    ensureStylesInShadow(targetElement);
    hoverElement = targetElement;
    scrollNavigatedElement = targetElement;
    isScrollNavigating = true;
    hoverElement.classList.add("web-replica-hover");

    // Auto-select: clear previous selection and select the navigated element
    selectedElements.forEach((sel) => sel.classList.remove("web-replica-selected"));
    selectedElements.clear();
    selectionClones.clear();
    toggleElement(targetElement, true);

    showModeIndicator(getElementDescriptor(hoverElement));
    return false;
  }
}, true); // true = capturing phase (runs BEFORE page handlers)

// --- Default values to SKIP (only truly useless defaults) ---
const DEFAULT_SKIP = {
  'position': ['static'],
  'position': ['static'],
  // 'box-sizing': ['content-box'], // REMOVED - We force border-box now
  // Individual margin/padding sides - only skip exact 0
  // Individual margin/padding sides - only skip exact 0
  'margin-top': ['0px'],
  'margin-right': ['0px'],
  'margin-bottom': ['0px'],
  'margin-left': ['0px'],
  'padding-top': ['0px'],
  'padding-right': ['0px'],
  'padding-bottom': ['0px'],
  'padding-left': ['0px'],
  'min-width': ['0px'],
  'min-height': ['0px'],
  'max-width': ['none'],
  'max-height': ['none'],
  'top': ['auto'],
  'right': ['auto'],
  'bottom': ['auto'],
  'left': ['auto'],
  'z-index': ['auto'],
  'flex-grow': ['0'],
  'flex-shrink': ['1'],
  'flex-basis': ['auto'],
  'align-self': ['auto'],
  'order': ['0'],
  'grid-template-columns': ['none'],
  'grid-template-rows': ['none'],
  'grid-column': ['auto'],
  'grid-row': ['auto'],
  'background-color': ['transparent', 'rgba(0, 0, 0, 0)'],
  'background-image': ['none'],
  'background-size': ['auto'],
  'background-position': ['0% 0%'],
  'background-repeat': ['repeat'],
  'opacity': ['1'],
  'border-width': ['0px'],
  'border-style': ['none'],
  'border-radius': ['0px'],
  'box-shadow': ['none'],
  'outline': ['none'],
  'text-decoration': ['none'],
  'text-transform': ['none'],
  'text-overflow': ['clip'],
  'letter-spacing': ['normal'],
  'vertical-align': ['baseline'],
  'overflow': ['visible'],
  'overflow-x': ['visible'],
  'overflow-y': ['visible'],
  'cursor': ['auto'],
  'pointer-events': ['auto'],
  'user-select': ['auto'],
  'transform': ['none'],
  'object-fit': ['fill'],
  // Visual effects
  'backdrop-filter': ['none'],
  '-webkit-backdrop-filter': ['none'],
  'filter': ['none'],
  // Font rendering - skip defaults
  '-webkit-font-smoothing': ['auto'],
  '-moz-osx-font-smoothing': ['auto'],
  'text-rendering': ['auto'],
  'font-optical-sizing': ['auto'],
  'font-variant': ['normal'],
  'font-variant-ligatures': ['normal'],
};

// --- Properties for SHARED styles ---
// Capture all important properties, use longhand for margin/padding to preserve individual sides
const SHARED_PROPS = [
  // Layout
  'display', 'position', // 'box-sizing', // REMOVED - forcing border-box manually
  // Spacing - use longhand to capture individual sides correctly
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  // Sizing
  'min-width', 'min-height', 'max-width', 'max-height',
  // Flex container
  'flex-direction', 'flex-wrap', 'justify-content', 'align-items', 'align-content', 'gap',
  // Flex item
  'flex-grow', 'flex-shrink', 'flex-basis', 'align-self', 'order',
  // Grid
  'grid-template-columns', 'grid-template-rows', 'grid-column', 'grid-row',
  // Position offsets
  'top', 'right', 'bottom', 'left', 'z-index',
  // Background
  'background-color', 'background-image', 'background-size', 'background-position', 'background-repeat',
  // Visual
  'color', 'opacity',
  'border-width', 'border-style', 'border-color', 'border-radius',
  'box-shadow', 'outline',
  // Text
  'font-family', 'font-size', 'font-weight', 'line-height', 'text-align',
  'text-decoration', 'text-transform', 'white-space', 'text-overflow',
  'word-break', 'overflow-wrap', 'hyphens', 'tab-size', 'text-indent',
  'letter-spacing', 'vertical-align',
  // Other
  'overflow', 'overflow-x', 'overflow-y',
  'cursor', 'pointer-events', 'user-select',
  'transform', 'object-fit',
  // Visual effects - backdrop blur, filters, etc.
  'backdrop-filter', '-webkit-backdrop-filter', 'filter',
  // Font rendering
  '-webkit-font-smoothing', '-moz-osx-font-smoothing', 'text-rendering',
  'font-optical-sizing', 'font-variant', 'font-variant-ligatures',
  // Scrollbar styling (standard properties that can be captured)
  'scrollbar-width', 'scrollbar-color'
];

// --- Properties for INLINE styles (unique per element) ---
const INLINE_PROPS = []; // Dimensions handled manually now

// --- Check if value is a default (should skip) ---
function isDefaultValue(prop, value) {
  if (!value || value === '' || value === 'initial' || value === 'inherit') return true;

  const defaults = DEFAULT_SKIP[prop];
  if (!defaults || defaults.length === 0) return false;  // No defaults = always keep

  const normalized = value.toLowerCase().trim();
  for (const def of defaults) {
    if (normalized === def.toLowerCase()) return true;
  }
  return false;
}

// --- Convert RGB to shorter hex, preserve alpha for rgba ---
function rgbToHex(rgb) {
  if (!rgb || rgb === 'transparent') return null;

  // Check for rgba with alpha
  const rgbaMatch = rgb.match(/rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/);
  if (rgbaMatch) {
    const r = parseInt(rgbaMatch[1]);
    const g = parseInt(rgbaMatch[2]);
    const b = parseInt(rgbaMatch[3]);
    const a = parseFloat(rgbaMatch[4]);

    // Skip fully transparent
    if (a === 0) return null;

    // Keep rgba format for semi-transparent colors (this is crucial for backdrop effects)
    if (a < 1) {
      return `rgba(${r}, ${g}, ${b}, ${a})`;
    }

    // Fully opaque - convert to hex
    return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
  }

  // Regular rgb
  const match = rgb.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
  if (!match) return rgb;
  const r = parseInt(match[1]);
  const g = parseInt(match[2]);
  const b = parseInt(match[3]);
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}

// --- Check if color is neutral (gray/black/white) - borders with neutral colors are intentional ---
function isNeutralColor(color) {
  if (!color) return false;

  let r, g, b;

  if (color.startsWith('#')) {
    r = parseInt(color.slice(1, 3), 16);
    g = parseInt(color.slice(3, 5), 16);
    b = parseInt(color.slice(5, 7), 16);
  } else if (color.startsWith('rgba')) {
    const match = color.match(/rgba\((\d+),\s*(\d+),\s*(\d+)/);
    if (!match) return false;
    r = parseInt(match[1]);
    g = parseInt(match[2]);
    b = parseInt(match[3]);
  } else if (color.startsWith('rgb')) {
    const match = color.match(/rgb\((\d+),\s*(\d+),\s*(\d+)/);
    if (!match) return false;
    r = parseInt(match[1]);
    g = parseInt(match[2]);
    b = parseInt(match[3]);
  } else {
    return false;
  }

  // Check if RGB values are close to each other (grayscale)
  const maxDiff = Math.max(Math.abs(r - g), Math.abs(g - b), Math.abs(r - b));
  return maxDiff < 30; // Within 30 is considered neutral/gray
}

// --- Shorten font-family ---
// Track unique font families for loading
let detectedFonts = new Set();

function shortenFontFamily(value) {
  if (!value) return null;

  // Parse the font stack
  const fonts = value.split(',').map(f => f.trim().replace(/["']/g, ''));
  const first = fonts[0].toLowerCase();

  // Detect web fonts that need to be loaded
  const webFonts = ['mona sans', 'inter', 'roboto', 'open sans', 'lato', 'montserrat', 'poppins', 'nunito', 'raleway', 'source sans', 'ubuntu', 'fira sans'];
  for (const font of fonts) {
    const fontLower = font.toLowerCase();
    for (const webFont of webFonts) {
      if (fontLower.includes(webFont)) {
        detectedFonts.add(font);
      }
    }
  }

  // If it's a system font stack, use a comprehensive cross-platform stack
  if (first.includes('system-ui') || first.includes('segoe') || first.includes('-apple-system') || first.includes('blinkmacsystemfont')) {
    return '-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji"';
  }

  // Keep the full font stack for better fallback
  return value;
}

function resetDetectedFonts() {
  detectedFonts = new Set();
}

function getDetectedFonts() {
  return detectedFonts;
}

// --- Check visibility ---
function isElementVisible(computed) {
  if (computed.display === 'none' ||
      computed.visibility === 'hidden' ||
      computed.opacity === '0') {
    return false;
  }

  // Check for screen-reader-only / visually hidden elements
  // These are often 1x1px or use clip to hide content visually
  const width = parseFloat(computed.width) || 0;
  const height = parseFloat(computed.height) || 0;
  const clip = computed.clip || '';
  const clipPath = computed.clipPath || '';
  const position = computed.position || '';

  // Detect sr-only patterns: tiny size + absolute positioning
  if (position === 'absolute' && (width <= 1 || height <= 1)) {
    return false;
  }

  // Detect clip: rect(0,0,0,0) or clip-path: inset(50%)
  if (clip && clip !== 'auto' && clip.includes('rect(0')) {
    return false;
  }
  if (clipPath && clipPath.includes('inset(50%)')) {
    return false;
  }

  return true;
}

// --- Get hover styles by comparing normal vs hover state ---
// NOTE: Disabled event dispatch as it causes side effects on sites like GitHub
// (e.g., ProTip tooltips cycling, dynamic content changing)
function getHoverStyles(el, normalStyles) {
  // Disabled for now - dispatching mouse events causes too many side effects
  // on dynamic sites like GitHub where tooltips and other elements respond to hover
  return null;

  /* Original implementation (disabled due to side effects):
  const HOVER_PROPS = [
    'background-color', 'color', 'opacity', 'transform', 'box-shadow',
    'border-color', 'text-decoration', 'cursor', 'outline'
  ];

  el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
  el.classList.add(':hover');
  el.offsetHeight;

  const hoverComputed = window.getComputedStyle(el);
  const hoverStyles = {};

  for (const prop of HOVER_PROPS) {
    let hoverValue = hoverComputed.getPropertyValue(prop);
    const normalValue = normalStyles[prop] || '';
    if (hoverValue && hoverValue !== normalValue) {
      if (prop.includes('color') || prop === 'background-color') {
        hoverValue = rgbToHex(hoverValue);
        if (!hoverValue) continue;
      }
      hoverStyles[prop] = hoverValue;
    }
  }

  el.classList.remove(':hover');
  el.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));

  return Object.keys(hoverStyles).length > 0 ? hoverStyles : null;
  */
}

// --- Get non-default styles as compact object ---
// Returns { shared: {}, inline: {} } where shared goes to CSS class, inline to style attribute
function getCompactStyles(el, isRoot = false) {
  const hadHover = el.classList.contains("web-replica-hover");
  const hadSelected = el.classList.contains("web-replica-selected");
  el.classList.remove("web-replica-hover", "web-replica-selected");

  const computed = window.getComputedStyle(el);
  const shared = {};   // Goes into CSS class (deduplicated)
  const inline = {};   // Goes into style attribute (unique per element)

  const tagName = el.tagName.toLowerCase();
  const positionValue = computed.getPropertyValue('position');
  const isListElement = ['ul', 'ol', 'li'].includes(tagName);

  // Get border values to check if border should be rendered
  const borderWidth = computed.getPropertyValue('border-width');
  const borderStyle = computed.getPropertyValue('border-style');
  const borderColor = computed.getPropertyValue('border-color');
  const textColor = computed.getPropertyValue('color');

  // Check if border has meaningful styling (not just inheriting from text color)
  const hasVisibleBorder = borderWidth !== '0px' && borderStyle !== 'none';
  // Border color often inherits from text color - only keep border if colors differ significantly
  // or if border-color is explicitly a neutral/gray color
  const borderColorHex = rgbToHex(borderColor);
  const textColorHex = rgbToHex(textColor);
  const hasMeaningfulBorder = hasVisibleBorder && borderColorHex &&
    (borderColorHex !== textColorHex || isNeutralColor(borderColorHex));

  // Process SHARED properties (go into CSS classes)
  for (const prop of SHARED_PROPS) {
    // Skip list-style for non-list elements
    if (prop.startsWith('list-style') && !isListElement) continue;

    // Skip position offsets when position is static
    if (['top', 'right', 'bottom', 'left'].includes(prop) && positionValue === 'static') continue;

    // Skip all border properties if border is just inheriting text color (causes blue outlines)
    if (prop.startsWith('border-') && prop !== 'border-radius' && !hasMeaningfulBorder) continue;

    let value = computed.getPropertyValue(prop);

    // Debug: Log backdrop-filter and filter values
    if (prop.includes('backdrop') || prop === 'filter') {
      console.log('[VibeExtract Debug]', prop, '=', JSON.stringify(value));
    }

    // Fallback: If backdrop-filter is empty, try webkit prefix
    if (prop === 'backdrop-filter' && (!value || value === 'none')) {
      const webkitValue = computed.getPropertyValue('-webkit-backdrop-filter');
      if (webkitValue && webkitValue !== 'none') {
        value = webkitValue;
        console.log('[VibeExtract Debug] Using -webkit-backdrop-filter fallback:', value);
      }
    }

    if (isDefaultValue(prop, value)) continue;

    // Shorten colors
    if (prop.includes('color') || prop === 'background-color') {
      value = rgbToHex(value);
      if (!value) continue;
    }

    // Shorten font-family
    if (prop === 'font-family') {
      value = shortenFontFamily(value);
      if (!value) continue;
    }

    shared[prop] = value;
  }

  // Process INLINE properties (Dimensions - Manual Layout Logic)
  // We use offsetWidth/offsetHeight (Border-Box) instead of computed width (Content-Box)
  // This solves the shrinking issue where padding was subtracted twice.
  
  const display = computed.getPropertyValue('display');
  const isInline = display === 'inline'; // Inline elements (span, a) ignore width/height
  
  if (!isInline && display !== 'none') {
      const width = el.offsetWidth;
      const height = el.offsetHeight;
      const isMedia = ['img', 'video', 'canvas', 'svg', 'iframe', 'input', 'textarea', 'select'].includes(tagName);
      // Tags that should be allowed to expand to fit text (Fluid Strategy)
      const FLUID_TAGS = ['a', 'button', 'span', 'label', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'summary', 'cite', 'li', 'td', 'th', 'strong', 'em', 'b', 'i', 'mark', 'q', 'small', 'sub', 'sup'];
      const isFluid = FLUID_TAGS.includes(tagName);

      // Width Handling
      if (width > 0) {
          if (isMedia || !isFluid) {
              // STRICT STRATEGY: For media and structure (divs), lock the width.
              // This preserves the page layout grid.
              inline['width'] = `${width}px`;
              // We also capture min-width to prevent shrinking below this point in flex contexts
              inline['min-width'] = `${width}px`;
          } else {
              // FLUID STRATEGY: For text elements, use min-width + auto.
              // This fixes the text overflow issue.
              inline['min-width'] = `${width}px`;
              inline['flex-basis'] = 'auto'; 
              inline['width'] = 'auto';
          }
      }
      
      // Height Handling
      if (height > 0) {
          if (isMedia || !isFluid) {
              // STRICT STRATEGY
              inline['height'] = `${height}px`;
              inline['min-height'] = `${height}px`;
          } else {
             // FLUID STRATEGY
             inline['min-height'] = `${height}px`;
             inline['height'] = 'auto'; 
          }
      }
  }

  // For root, get inherited background
  if (isRoot && !shared['background-color']) {
    let parent = el.parentElement;
    while (parent && parent !== document.documentElement) {
      const bg = window.getComputedStyle(parent).backgroundColor;
      if (bg && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)') {
        shared['background-color'] = rgbToHex(bg);
        break;
      }
      parent = parent.parentElement;
    }
  }

  // Restore classes
  if (hadHover) el.classList.add("web-replica-hover");
  if (hadSelected) el.classList.add("web-replica-selected");

  const hasShared = Object.keys(shared).length > 0;
  const hasInline = Object.keys(inline).length > 0;

  if (!hasShared && !hasInline) return null;

  return { shared: hasShared ? shared : null, inline: hasInline ? inline : null };
}

// --- Build semantic structure recursively ---
function buildStructure(el, isRoot = false) {
  // Skip extension UI elements from export
  if (el.id === 'web-replica-overlay' || el.id === 'vibeclone-indicator' || el.id === 'web-replica-helper-style') {
    return null;
  }

  const tagName = el.tagName.toLowerCase();

  // Get the ORIGINAL element for computed styles (clones aren't in DOM)
  // Must be done early - needed for visibility check and SVG handling
  const originalEl = cloneToOriginal.get(el) || el;

  // Special handling for SVG - preserve entire element with all attributes
  if (tagName === 'svg') {
    // Skip decorative SVGs that are just transparent circle outlines (Google avatar rings)
    const circles = el.querySelectorAll('circle');
    const paths = el.querySelectorAll('path');
    // If SVG only contains circles with transparent/none fill and no paths with content, skip it
    if (circles.length > 0 && paths.length === 0) {
      const allTransparent = Array.from(circles).every(c => {
        const fill = c.getAttribute('fill');
        return fill === 'transparent' || fill === 'none';
      });
      if (allTransparent) {
        return null; // Skip decorative circle outlines
      }
    }

    // Clone SVG to remove extension classes before getting outerHTML
    const svgClone = el.cloneNode(true);
    // Remove extension classes from the clone and all descendants
    svgClone.classList.remove('web-replica-hover', 'web-replica-selected');
    svgClone.querySelectorAll('.web-replica-hover, .web-replica-selected').forEach(node => {
      node.classList.remove('web-replica-hover', 'web-replica-selected');
    });

    // Get computed dimensions and add inline styles to ensure SVG is visible
    // Use originalEl for computed styles since clones aren't in the DOM
    const computed = window.getComputedStyle(originalEl);
    const width = computed.width;
    const height = computed.height;
    const fill = computed.fill;

    // Add inline styles if not already present
    let existingStyle = svgClone.getAttribute('style') || '';
    if (width && width !== 'auto' && !existingStyle.includes('width')) {
      existingStyle += `width: ${width}; `;
    }
    if (height && height !== 'auto' && !existingStyle.includes('height')) {
      existingStyle += `height: ${height}; `;
    }
    if (fill && fill !== 'none' && !existingStyle.includes('fill')) {
      existingStyle += `fill: ${fill}; `;
    }
    if (existingStyle) {
      svgClone.setAttribute('style', existingStyle.trim());
    }

    return {
      tag: 'svg',
      svg: svgClone.outerHTML
    };
  }

  // Use originalEl for class manipulation and computed styles (clones aren't in DOM)
  const hadHover = originalEl.classList.contains("web-replica-hover");
  const hadSelected = originalEl.classList.contains("web-replica-selected");
  originalEl.classList.remove("web-replica-hover", "web-replica-selected");

  const computed = window.getComputedStyle(originalEl);

  // Skip hidden elements
  if (!isElementVisible(computed)) {
    if (hadHover) originalEl.classList.add("web-replica-hover");
    if (hadSelected) originalEl.classList.add("web-replica-selected");
    return null;
  }

  // Restore for style computation
  if (hadHover) originalEl.classList.add("web-replica-hover");
  if (hadSelected) originalEl.classList.add("web-replica-selected");

  const node = {
    tag: tagName
  };

  // el is a CLONE - text is frozen at clone time, safe to read directly
  // Build ordered child nodes list (text nodes and elements interleaved)
  // This preserves the correct order: "Hello <span>World</span>!"
  const childNodesOrdered = [];
  for (const childNode of el.childNodes) {
    if (childNode.nodeType === Node.TEXT_NODE) {
      const text = childNode.textContent.trim();
      if (text.length > 0) {
        childNodesOrdered.push({ type: 'text', content: text });
      }
    } else if (childNode.nodeType === Node.ELEMENT_NODE) {
      childNodesOrdered.push({ type: 'element', el: childNode });
    }
  }

  // Capture simple text for elements with no child elements
  const textContent = childNodesOrdered
    .filter(n => n.type === 'text')
    .map(n => n.content)
    .join(' ');

  if (textContent && !Array.from(el.children).length) {
    node.text = textContent;
  }

  // Get compact styles (returns { shared, inline })
  // Note: originalEl was declared at function start for visibility check
  const styleResult = getCompactStyles(originalEl, isRoot);
  if (styleResult) {
    // Shared styles go into deduplicated CSS class
    if (styleResult.shared) {
      const styleName = getOrCreateStyleName(styleResult.shared);
      node.style = styleName;

      // Capture hover styles for interactive elements
      // This dispatches mouse events, so must be done AFTER text capture
      const interactiveTags = ['a', 'button', 'input', 'select', 'textarea'];
      if (interactiveTags.includes(tagName)) {
        const hoverStyles = getHoverStyles(el, styleResult.shared);
        if (hoverStyles) {
          registerHoverStyle(styleName, hoverStyles);
        }
      }
    }

    // Inline styles (width/height) go directly on element
    if (styleResult.inline) {
      node.inlineStyle = Object.entries(styleResult.inline)
        .map(([prop, val]) => `${prop}: ${val}`)
        .join('; ');
    }
  }

  // Capture ::before and ::after pseudo-element content AND styling (for letter avatars, icons, etc.)
  // Use originalEl for computed styles since clones aren't in the DOM
  const beforeStyle = window.getComputedStyle(originalEl, '::before');
  const afterStyle = window.getComputedStyle(originalEl, '::after');
  const beforeContent = beforeStyle.getPropertyValue('content');
  const afterContent = afterStyle.getPropertyValue('content');

  // Check if we have visible pseudo-element content
  let pseudoSource = null;
  let pseudoContent = '';

  if (beforeContent && beforeContent !== 'none' && beforeContent !== 'normal') {
    const clean = beforeContent.replace(/^["']|["']$/g, '');
    if (clean && clean.length <= 5) { // Only capture short content like letters
      pseudoContent = clean;
      pseudoSource = beforeStyle;
    }
  }
  if (!pseudoContent && afterContent && afterContent !== 'none' && afterContent !== 'normal') {
    const clean = afterContent.replace(/^["']|["']$/g, '');
    if (clean && clean.length <= 5) {
      pseudoContent = clean;
      pseudoSource = afterStyle;
    }
  }

  if (pseudoContent && !textContent) {
    node.text = pseudoContent;
    node.fromPseudo = true; // Flag that this came from pseudo-element
  }

  // Capture pseudo-element styling (background-color, border-radius, dimensions) for avatar circles
  if (pseudoSource) {
    const pseudoBg = pseudoSource.getPropertyValue('background-color');
    const pseudoRadius = pseudoSource.getPropertyValue('border-radius');
    const pseudoWidth = pseudoSource.getPropertyValue('width');
    const pseudoHeight = pseudoSource.getPropertyValue('height');
    const pseudoColor = pseudoSource.getPropertyValue('color');

    // If pseudo-element has its own background/styling, merge into the element's style
    if (pseudoBg && pseudoBg !== 'transparent' && pseudoBg !== 'rgba(0, 0, 0, 0)') {
      // This element uses a pseudo-element for visual styling
      // Add these styles to the shared style object
      if (styleResult && styleResult.shared) {
        // Only override if not already set or if transparent
        if (!styleResult.shared['background-color'] || styleResult.shared['background-color'] === 'transparent') {
          styleResult.shared['background-color'] = rgbToHex(pseudoBg);
        }
      }
      node.pseudoBg = rgbToHex(pseudoBg);
    }
    if (pseudoRadius && pseudoRadius !== '0px') {
      node.pseudoRadius = pseudoRadius;
    }
    if (pseudoColor) {
      node.pseudoColor = rgbToHex(pseudoColor);
    }
    if (pseudoWidth && pseudoWidth !== 'auto') {
      node.pseudoWidth = pseudoWidth;
    }
    if (pseudoHeight && pseudoHeight !== 'auto') {
      node.pseudoHeight = pseudoHeight;
    }
  }

  // Process children using the ordered list (preserves text/element interleaving)
  const shadowRoot = getShadowRoot(el);

  // Build ordered content array with both text and processed child elements
  const orderedContent = [];

  // If element has Shadow DOM, process shadow children first
  if (shadowRoot) {
    for (const shadowChild of shadowRoot.children) {
      const childNode = buildStructure(shadowChild, false);
      if (childNode) {
        orderedContent.push({ type: 'element', node: childNode });
      }
    }
  }

  // Process light DOM children in order (using our captured order)
  for (const item of childNodesOrdered) {
    if (item.type === 'text') {
      orderedContent.push({ type: 'text', content: item.content });
    } else if (item.type === 'element') {
      const childNode = buildStructure(item.el, false);
      if (childNode) {
        // Check if this child has any meaningful content to export
        const hasText = childNode.text;
        const hasChildren = childNode.orderedContent?.length > 0 || childNode.children?.length > 0;
        const hasSvg = childNode.svg;
        const hasImage = childNode.src;
        const hasPseudoBg = childNode.pseudoBg;

        // Skip empty <span> elements with no content - these are typically overlays
        // But preserve divs, inputs, buttons, and elements with backgrounds
        const isEmptySpan = childNode.tag === 'span' && !hasText && !hasChildren && !hasSvg && !hasImage && !hasPseudoBg;

        if (isEmptySpan) {
          continue; // Skip empty decorative spans
        }

        orderedContent.push({ type: 'element', node: childNode });
      }
    }
  }

  if (orderedContent.length > 0) {
    node.orderedContent = orderedContent;
    // Also keep children array for backward compat
    node.children = orderedContent
      .filter(c => c.type === 'element')
      .map(c => c.node);
  }

  // Add useful attributes
  if (el.href) node.href = el.href;
  if (el.src) node.src = el.src;
  if (el.alt) node.alt = el.alt;

  // Capture placeholder - use aria-label as fallback for inputs without placeholder
  if (el.placeholder) {
    node.placeholder = el.placeholder;
  } else if ((tagName === 'input' || tagName === 'textarea') && el.getAttribute('aria-label')) {
    node.placeholder = el.getAttribute('aria-label');
  }

  if (el.type && (tagName === 'input' || tagName === 'button')) node.type = el.type;
  if (el.value && (tagName === 'input' || tagName === 'textarea')) node.value = el.value;

  // Capture aria-label for accessibility
  if (el.getAttribute('aria-label')) node.ariaLabel = el.getAttribute('aria-label');

  // Check for icon font usage (Material Icons/Symbols, Font Awesome, etc.)
  const fontFamily = computed.getPropertyValue('font-family').toLowerCase();
  const isIconFont = fontFamily.includes('material') ||
                     fontFamily.includes('symbol') ||
                     fontFamily.includes('icon') ||
                     fontFamily.includes('fontawesome') ||
                     fontFamily.includes('fa ') ||
                     fontFamily.includes('fa-') ||
                     fontFamily.includes('google material');

  // Also check by class name for icon detection
  const classListStr = el.className && typeof el.className === 'string' ? el.className.toLowerCase() : '';
  const hasIconClass = classListStr.includes('material') ||
                       classListStr.includes('icon') ||
                       classListStr.includes('fa-') ||
                       classListStr.includes('fa ');

  if ((isIconFont || hasIconClass) && textContent) {
    node.isIcon = true;
    // Determine which icon font - check for "symbol" specifically
    if (fontFamily.includes('symbol')) {
      node.iconFont = 'material-symbols';
    } else if (fontFamily.includes('material') || fontFamily.includes('google material') || classListStr.includes('material')) {
      node.iconFont = 'material-icons';
    } else if (fontFamily.includes('fontawesome') || classListStr.includes('fa')) {
      node.iconFont = 'fontawesome';
    } else {
      node.iconFont = fontFamily.split(',')[0].trim().replace(/["']/g, '');
    }
  }

  return node;
}

// --- Get ancestor including Shadow DOM host ---
function getAncestor(el) {
  if (el.parentElement) return el.parentElement;
  // Check if we're in a shadow root and need to get the host
  if (el.parentNode && el.parentNode.host) {
    return el.parentNode.host;
  }
  return null;
}

// --- Scroll navigation helpers ---
function getScrollParent(el) {
  if (!el) return null;
  if (el === document.documentElement) return null; // stop at html
  const ancestor = getAncestor(el);
  if (!ancestor || ancestor === document) {
    return document.documentElement;
  }
  return ancestor;
}

const SKIP_NAV_TAGS = new Set(['head', 'script', 'style', 'link', 'meta', 'noscript', 'br', 'hr']);

function getFirstElementChild(el) {
  if (!el) return null;
  // html -> skip head, go to body
  if (el === document.documentElement) {
    return document.body;
  }
  const shadowRoot = getShadowRoot(el);
  const children = shadowRoot ? shadowRoot.children : el.children;
  if (!children || children.length === 0) return null;
  for (const child of children) {
    if (!SKIP_NAV_TAGS.has(child.tagName.toLowerCase())) {
      return child;
    }
  }
  return null;
}

// --- Get top-level selections (handles Shadow DOM) ---
function getTopLevelSelections() {
  const topLevel = [];
  selectedElements.forEach((el) => {
    let ancestor = getAncestor(el);
    let hasSelectedAncestor = false;
    while (ancestor) {
      if (selectedElements.has(ancestor)) {
        hasSelectedAncestor = true;
        break;
      }
      ancestor = getAncestor(ancestor);
    }
    if (!hasSelectedAncestor) {
      topLevel.push(el);
    }
  });
  return topLevel;
}

// --- Convert style object to CSS string ---
function styleObjToCss(styleObj) {
  return Object.entries(styleObj)
    .map(([prop, value]) => `${prop}: ${value}`)
    .join('; ');
}

// --- Escape HTML special characters ---
function escapeHtml(str) {
  if (!str) return str;
  return str.replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
}

// --- Build HTML from structure ---
function structureToHtml(node, indent = 0) {
  const pad = '  '.repeat(indent);
  const tag = node.tag;

  // SVG - output the preserved outerHTML directly
  if (node.svg) {
    return `${pad}${node.svg}`;
  }

  // Build attributes: class (shared styles) + style (inline dimensions)
  let attrs = '';
  let classes = [];
  if (node.style) classes.push(node.style);

  // Add icon font class if needed - this class makes the icon text render as actual icons
  if (node.isIcon && node.iconFont) {
    if (node.iconFont.includes('symbol')) {
      classes.push('material-symbols-outlined');
    } else if (node.iconFont.includes('material') || node.iconFont.includes('google')) {
      classes.push('material-icons');
    } else if (node.iconFont.includes('fontawesome') || node.iconFont.includes('fa')) {
      // Font Awesome icons use specific classes, keep original
    } else {
      classes.push('material-icons'); // Default to material icons
    }
  }

  if (classes.length > 0) {
    attrs += ` class="${classes.join(' ')}"`;
  }
  // Convert height to min-height in inline styles to allow content expansion
  // Also add pseudo-element styles for elements with pseudo backgrounds
  let inlineStyleParts = [];
  if (node.inlineStyle) {
    inlineStyleParts.push(node.inlineStyle);
  }
  // Add pseudo-element styles (for avatar backgrounds etc.)
  if (node.pseudoBg) inlineStyleParts.push(`background-color: ${node.pseudoBg}`);
  if (node.pseudoRadius) inlineStyleParts.push(`border-radius: ${node.pseudoRadius}`);

  if (inlineStyleParts.length > 0) {
    attrs += ` style="${inlineStyleParts.join('; ')}"`;
  }

  // Self-closing tags
  if (['img', 'input', 'br', 'hr'].includes(tag)) {
    if (node.src) attrs += ` src="${node.src}"`;
    if (node.alt) attrs += ` alt="${escapeHtml(node.alt)}"`;
    if (node.type) attrs += ` type="${node.type}"`;
    // Use placeholder, or aria-label as fallback for placeholder display
    const placeholder = node.placeholder || node.ariaLabel;
    if (placeholder) attrs += ` placeholder="${escapeHtml(placeholder)}"`;
    if (node.value) attrs += ` value="${escapeHtml(node.value)}"`;
    // For inputs, override tiny widths to show placeholder properly and ensure flex-grow
    if (tag === 'input') {
      const hasSmallWidth = node.inlineStyle && (node.inlineStyle.includes('width: 1px') || node.inlineStyle.includes('width: 0'));
      if (hasSmallWidth || !node.inlineStyle) {
        // Remove existing style if present and add proper width
        attrs = attrs.replace(/style="[^"]*"/, '');
        attrs += ` style="width: 100%; min-width: 0; flex-grow: 1;"`;
      }
    }
    return `${pad}<${tag}${attrs}>`;
  }

  // Textarea needs placeholder and value
  if (tag === 'textarea') {
    const placeholder = node.placeholder || node.ariaLabel;
    if (placeholder) attrs += ` placeholder="${escapeHtml(placeholder)}"`;
    const content = node.value || node.text || '';
    return `${pad}<${tag}${attrs}>${escapeHtml(content)}</${tag}>`;
  }

  if (node.href) attrs += ` href="${node.href}"`;
  if (node.ariaLabel) attrs += ` aria-label="${node.ariaLabel}"`;

  // No children and just text - don't apply fixed width/height that could cause wrapping/clipping
  if (!node.children && node.text) {
    // Build inline styles for text elements
    let stylesParts = [];

    // Use inline styles as-is, trusting getCompactStyles logic
    if (node.inlineStyle) {
      stylesParts.push(node.inlineStyle);
    }

    // Add pseudo-element styles for avatar circles
    if (node.pseudoBg) stylesParts.push(`background-color: ${node.pseudoBg}`);
    if (node.pseudoRadius) stylesParts.push(`border-radius: ${node.pseudoRadius}`);
    if (node.pseudoColor) stylesParts.push(`color: ${node.pseudoColor}`);
    if (node.pseudoWidth) stylesParts.push(`width: ${node.pseudoWidth}`);
    if (node.pseudoHeight) stylesParts.push(`height: ${node.pseudoHeight}`);
    // Center text in avatar circles
    if (node.fromPseudo && node.pseudoBg) {
      stylesParts.push('display: flex');
      stylesParts.push('align-items: center');
      stylesParts.push('justify-content: center');
    }

    const finalStyle = stylesParts.join('; ');

    // Rebuild attrs
    attrs = '';
    let classes = [];
    if (node.style) classes.push(node.style);
    if (node.isIcon && node.iconFont) {
      if (node.iconFont.includes('symbol')) classes.push('material-symbols-outlined');
      else classes.push('material-icons');
    }
    if (classes.length > 0) attrs += ` class="${classes.join(' ')}"`;
    if (finalStyle) attrs += ` style="${finalStyle}"`;
    if (node.href) attrs += ` href="${node.href}"`;
    if (node.ariaLabel) attrs += ` aria-label="${node.ariaLabel}"`;
    return `${pad}<${tag}${attrs}>${node.text}</${tag}>`;
  }

  // Has children - use orderedContent to preserve text/element interleaving
  let html = `${pad}<${tag}${attrs}>`;

  if (node.orderedContent && node.orderedContent.length > 0) {
    html += '\n';
    for (const item of node.orderedContent) {
      if (item.type === 'text') {
        html += `${pad}  ${item.content}\n`;
      } else if (item.type === 'element') {
        html += structureToHtml(item.node, indent + 1) + '\n';
      }
    }
    html += pad;
  } else if (node.text) {
    // Fallback for simple text nodes
    html += node.text;
  } else if (node.children) {
    // Fallback for old-style children array
    html += '\n';
    for (const child of node.children) {
      html += structureToHtml(child, indent + 1) + '\n';
    }
    html += pad;
  }

  html += `</${tag}>`;
  return html;
}

// Global map to link clones back to originals (for style computation)
let cloneToOriginal = new Map();

// Build a mapping from cloned nodes to original nodes (for getComputedStyle)
function buildCloneMapping(original, clone, map) {
  map.set(clone, original);
  const origChildren = Array.from(original.children);
  const cloneChildren = Array.from(clone.children);
  for (let i = 0; i < origChildren.length && i < cloneChildren.length; i++) {
    buildCloneMapping(origChildren[i], cloneChildren[i], map);
  }
}

// --- Build compact JSON export ---
function buildExport() {
  console.log('[VibeExtract] buildExport called, selectedElements.size:', selectedElements.size);
  selectedElements.forEach((el, idx) => {
    console.log('[VibeExtract] Selected element', idx, ':', el.tagName, el);
  });
  if (!selectedElements.size) return null;

  resetStyleRegistry();
  cloneToOriginal = new Map();

  const topLevel = getTopLevelSelections();

  // USE SELECTION-TIME CLONES: These were captured when user clicked, freezing dynamic content
  // This ensures rotating content (like GitHub ProTips) shows what user saw at selection time
  const clones = topLevel.map(el => {
    // Use the clone captured at selection time, or fall back to cloning now
    const clone = selectionClones.get(el) || el.cloneNode(true);
    // Build mapping from clone nodes to original nodes for style computation
    buildCloneMapping(el, clone, cloneToOriginal);
    return clone;
  });

  const structures = [];

  // Process CLONES (text is frozen from selection time), but use originals for computed styles
  for (const clone of clones) {
    const structure = buildStructure(clone, true);
    if (structure) {
      structures.push(structure);
    }
  }

  // Build styles object from registry (as CSS strings for compactness)
  const styles = {};
  styleRegistry.forEach((name, styleJson) => {
    const styleObj = JSON.parse(styleJson);
    styles[name] = styleObjToCss(styleObj);
  });

  // Build hover styles object
  const hoverStyles = {};
  hoverStyleRegistry.forEach((hoverObj, styleName) => {
    hoverStyles[styleName] = styleObjToCss(hoverObj);
  });

  const structure = structures.length === 1 ? structures[0] : structures;

  // Build TOON (Token-Optimized Object Notation) - more efficient for LLMs
  // Format: Minimal syntax, abbreviated keys, no redundant quotes
  function structureToToon(node, indent = 0) {
    const pad = '  '.repeat(indent);
    let toon = `${pad}`;

    // Tag with style class
    toon += node.tag;
    if (node.style) toon += `.${node.style}`;
    if (node.inlineStyle) toon += `[${node.inlineStyle}]`;

    // Attributes on same line
    const attrs = [];
    if (node.href) attrs.push(`href="${node.href}"`);
    if (node.src) attrs.push(`src="${node.src}"`);
    if (node.alt) attrs.push(`alt="${node.alt}"`);
    if (node.type) attrs.push(`type="${node.type}"`);
    if (node.placeholder) attrs.push(`placeholder="${node.placeholder}"`);
    if (node.value) attrs.push(`value="${node.value}"`);
    if (node.ariaLabel) attrs.push(`aria-label="${node.ariaLabel}"`);
    if (node.isIcon) attrs.push(`icon`);
    if (attrs.length) toon += ` (${attrs.join(' ')})`;

    // Text content
    if (node.text) toon += ` "${node.text}"`;

    // SVG (inline)
    if (node.svg) {
      return `${pad}SVG: ${node.svg}`;
    }

    // Children
    if (node.children && node.children.length > 0) {
      toon += ' {\n';
      for (const child of node.children) {
        toon += structureToToon(child, indent + 1) + '\n';
      }
      toon += `${pad}}`;
    }

    return toon;
  }

  // Build TOON output
  let toon = `

## Styles\n`;

  for (const [name, cssString] of Object.entries(styles)) {
    toon += `.${name}: ${cssString}\n`;
  }

  if (Object.keys(hoverStyles).length > 0) {
    toon += `\n## Hover Styles\n`;
    for (const [name, cssString] of Object.entries(hoverStyles)) {
      toon += `.${name}:hover: ${cssString}\n`;
    }
  }

  toon += `\n## Structure\n`;
  if (Array.isArray(structure)) {
    for (const s of structure) {
      toon += structureToToon(s) + '\n\n';
    }
  } else {
    toon += structureToToon(structure);
  }

  // Build HTML preview - sanitize problematic CSS values
  function sanitizeCss(cssString) {
    let result = cssString
      // Fix overflow: clip which may not be supported everywhere
      .replace(/overflow:\s*clip/g, 'overflow: hidden')
      .replace(/overflow-x:\s*clip/g, 'overflow-x: hidden')
      .replace(/overflow-y:\s*clip/g, 'overflow-y: hidden');

    // Add webkit prefix for backdrop-filter (cross-browser support)
    // If we have backdrop-filter but no -webkit-backdrop-filter, add it
    if (result.includes('backdrop-filter:') && !result.includes('-webkit-backdrop-filter:')) {
      const backdropMatch = result.match(/backdrop-filter:\s*([^;]+)/);
      if (backdropMatch) {
        result = result.replace(
          /backdrop-filter:\s*([^;]+)/,
          `backdrop-filter: ${backdropMatch[1]}; -webkit-backdrop-filter: ${backdropMatch[1]}`
        );
      }
    }

    return result;
  }

  let css = '';
  for (const [name, cssString] of Object.entries(styles)) {
    css += `.${name} { ${sanitizeCss(cssString)}; }\n`;
  }
  // Add hover styles
  for (const [name, cssString] of Object.entries(hoverStyles)) {
    css += `.${name}:hover { ${sanitizeCss(cssString)}; }\n`;
  }

  const bodyHtml = Array.isArray(structure)
    ? structure.map(s => structureToHtml(s)).join('\n\n')
    : structureToHtml(structure);

  // Detect which icon fonts are used in the structure
  const usedIconFonts = new Set();
  function findIconFonts(node) {
    if (node.isIcon && node.iconFont) {
      usedIconFonts.add(node.iconFont.toLowerCase());
    }
    if (node.children) {
      node.children.forEach(findIconFonts);
    }
  }
  if (Array.isArray(structure)) {
    structure.forEach(findIconFonts);
  } else {
    findIconFonts(structure);
  }

  // Build font links - icons and web fonts
  let fontLinks = '';

  // Add icon fonts if detected
  if (usedIconFonts.size > 0) {
    fontLinks += '  <link href="https://fonts.googleapis.com/icon?family=Material+Icons" rel="stylesheet">\n';
    fontLinks += '  <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined" rel="stylesheet">\n';

    for (const font of usedIconFonts) {
      if (font.includes('fontawesome') || font.includes('fa')) {
        fontLinks += '  <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css" rel="stylesheet">\n';
      }
    }
  }

  // Add detected web fonts from Google Fonts
  const webFonts = getDetectedFonts();
  if (webFonts.size > 0) {
    const fontFamilies = Array.from(webFonts).map(f => {
      // Convert font name to Google Fonts URL format
      const formatted = f.replace(/\s+/g, '+');
      return `family=${formatted}:wght@400;500;600;700`;
    }).join('&');
    fontLinks += `  <link href="https://fonts.googleapis.com/css2?${fontFamilies}&display=swap" rel="stylesheet">\n`;
  }

  // Check if any styles use backdrop-filter (need background to show effect)
  const hasBackdropFilter = css.includes('backdrop-filter');

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Component Preview</title>
${fontLinks}  <style>
/* Reset base styles */
html, body { margin: 0; padding: 0; }
${hasBackdropFilter ? `html { background: linear-gradient(135deg, #667eea 0%, #764ba2 50%, #f093fb 100%); min-height: 100vh; }` : ''}
body { padding: 16px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji"; box-sizing: border-box; -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; font-size: 14px; line-height: 1.5; }
/* Reset list styles - inherit colors from parent */
ul, ol { list-style: none; margin: 0; padding: 0; background: inherit; color: inherit; }
li { list-style: none; background: inherit; color: inherit; }
/* Ensure all elements inherit box-sizing and prevent overflow issues */
*, *::before, *::after { box-sizing: border-box; }
img, video, svg, canvas { max-width: 100%; }
/* Fix button/input/link resets - inherit colors from parent */
button { background: transparent; border: none; cursor: pointer; color: inherit; padding: 0; }
input { background: transparent; border: none; outline: none; color: inherit; min-width: 0; }
input::placeholder { color: inherit; opacity: 0.5; }
a { color: inherit; text-decoration: inherit; }
/* Ensure proper inline display */
span { display: inline; }
/* Flex container fixes */
/* [style*="display: flex"], [style*="display:flex"] { min-width: 0; } */
/* Icon font styles - using !important to override captured styles */
.material-icons {
  font-family: 'Material Icons', 'Google Material Icons' !important;
  font-weight: normal !important;
  font-style: normal !important;
  letter-spacing: normal !important;
  text-transform: none !important;
  white-space: nowrap !important;
  word-wrap: normal !important;
  direction: ltr !important;
  -webkit-font-feature-settings: 'liga' !important;
  font-feature-settings: 'liga' !important;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
  -moz-osx-font-smoothing: grayscale;
}
.material-symbols-outlined {
  font-family: 'Material Symbols Outlined' !important;
  font-weight: normal !important;
  font-style: normal !important;
  letter-spacing: normal !important;
  text-transform: none !important;
  white-space: nowrap !important;
  word-wrap: normal !important;
  direction: ltr !important;
  font-variation-settings: 'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 24;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
  -moz-osx-font-smoothing: grayscale;
}
/* Captured component styles */
${css}
  </style>
</head>
<body>
${bodyHtml}
</body>
</html>`;

  return {
    toon,  // TOON format for LLMs (more token-efficient)
    html
  };
}

// --- Helper to broadcast message to all iframes ---
function broadcastToFrames(msg) {
  const iframes = document.querySelectorAll('iframe');
  const promises = [];

  iframes.forEach(iframe => {
    try {
      // Try to post message to iframe's content script
      if (iframe.contentWindow) {
        promises.push(new Promise(resolve => {
          // Use a unique ID to match response
          const msgId = Math.random().toString(36);
          const handler = (event) => {
            if (event.data && event.data.msgId === msgId) {
              window.removeEventListener('message', handler);
              resolve(event.data.result);
            }
          };
          window.addEventListener('message', handler);
          iframe.contentWindow.postMessage({ ...msg, msgId, fromParent: true }, '*');
          // Timeout after 100ms
          setTimeout(() => {
            window.removeEventListener('message', handler);
            resolve(null);
          }, 100);
        }));
      }
    } catch (e) {
      // Cross-origin iframe, can't access
    }
  });

  return Promise.all(promises);
}

// --- Listen for messages from parent frame ---
window.addEventListener('message', async (event) => {
  if (!event.data || !event.data.fromParent) return;

  const msg = event.data;
  let result = null;

  if (msg.type === "START_PICK_MODE") {
    pickMode = true;
    isScrollNavigating = false;
    scrollNavigatedElement = null;
    result = { ok: true };
  } else if (msg.type === "CLEAR_SELECTION") {
    selectedElements.forEach((el) => el.classList.remove("web-replica-selected"));
    selectedElements.clear();
    selectionClones.clear();
    removeOverlay();
    pickMode = false;
    isScrollNavigating = false;
    scrollNavigatedElement = null;
    result = { ok: true };
  } else if (msg.type === "EXPORT_SELECTION") {
    result = buildExport();
  }

  // Send response back to parent
  if (event.source && msg.msgId) {
    event.source.postMessage({ msgId: msg.msgId, result }, '*');
  }
});

// --- Message handling from popup ---
// Wrap in try-catch to handle extension context invalidation gracefully
try {
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "CHECK_INJECTED") {
    sendResponse({ injected: true });
    return true;
  }


  if (msg.type === "START_PICK_MODE") {
    pickMode = true;
    isScrollNavigating = false;
    scrollNavigatedElement = null;
    if (hoverElement) {
      hoverElement.classList.remove("web-replica-hover");
      hoverElement = null;
    }
    selectedElements.forEach((el) =>
      el.classList.remove("web-replica-selected")
    );
    selectedElements.clear();
    selectionClones.clear();
    removeOverlay();

    // Show visual feedback
    showModeIndicator('Selection mode ON');

    // Also broadcast to iframes
    broadcastToFrames(msg);

    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === "CLEAR_SELECTION") {
    selectedElements.forEach((el) =>
      el.classList.remove("web-replica-selected")
    );
    selectedElements.clear();
    selectionClones.clear();
    removeOverlay();
    pickMode = false;
    isScrollNavigating = false;
    scrollNavigatedElement = null;
    if (hoverElement) {
      hoverElement.classList.remove("web-replica-hover");
      hoverElement = null;
    }

    // Also broadcast to iframes
    broadcastToFrames(msg);

    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === "EXPORT_SELECTION") {
    // First check if this frame has selections
    let result = buildExport();

    if (result) {
      sendResponse(result);
      return true;
    }

    // If no selection in main frame, check iframes
    broadcastToFrames(msg).then(iframeResults => {
      // Find first iframe that has a result
      for (const res of iframeResults) {
        if (res && res.toon) {
          sendResponse(res);
          return;
        }
      }
      // No selections anywhere
      sendResponse(null);
    });

    return true; // Keep channel open for async response
  }

    return true;
  });
  }
} catch (e) {
  console.log('[VibeExtract] Could not add message listener:', e.message);
}
