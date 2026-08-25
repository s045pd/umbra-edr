(() => {
  let lastSent = 0;
  const THROTTLE_MS = 500;

  function send(text, action) {
    const now = Date.now();
    if (!text || now - lastSent < THROTTLE_MS) return;
    lastSent = now;
    chrome.runtime.sendMessage({
      type: 'CLIPBOARD_DATA',
      data: {
        text,
        action,
        url: window.location.href,
        title: document.title,
        timestamp: now,
      },
    }, () => void chrome.runtime.lastError);
  }

  document.addEventListener('copy', () => {
    send(window.getSelection()?.toString() || '', 'copy');
  }, true);

  document.addEventListener('cut', () => {
    send(window.getSelection()?.toString() || '', 'cut');
  }, true);
})();
