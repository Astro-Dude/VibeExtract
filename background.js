// Background script for handling downloads
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'DOWNLOAD_FILES') {
    const { toon, html } = message;

    // Download TOON file using application/octet-stream to preserve extension
    const toonBlob = new Blob([toon], { type: 'application/octet-stream' });
    const toonReader = new FileReader();
    toonReader.onload = () => {
      chrome.downloads.download({
        url: toonReader.result,
        filename: 'component.toon',
        saveAs: false,
        conflictAction: 'uniquify'
      }, () => {
        // Download HTML file after TOON
        const htmlBlob = new Blob([html], { type: 'text/html' });
        const htmlReader = new FileReader();
        htmlReader.onload = () => {
          chrome.downloads.download({
            url: htmlReader.result,
            filename: 'preview.html',
            saveAs: false,
            conflictAction: 'uniquify'
          });
        };
        htmlReader.readAsDataURL(htmlBlob);
      });
    };
    toonReader.readAsDataURL(toonBlob);

    sendResponse({ ok: true });
    return true;
  }
});
