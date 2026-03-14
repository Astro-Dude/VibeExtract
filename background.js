// Background script for VibeExtract

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Content script requests to open the export tab
  if (message.type === 'OPEN_EXPORT_TAB') {
    const { toon, html, sourceURL } = message;

    chrome.storage.local.set({
      exportHTML: html,
      exportTOON: toon,
      exportSourceURL: sourceURL || ''
    }, () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('export.html') });
    });

    sendResponse({ ok: true });
    return true;
  }
});
