(() => {
  let lastSent = 0;
  const THROTTLE_MS = 2500;
  const MAX_CHARS = 8000;

  function harvest() {
    const text = (document.body && document.body.innerText ? document.body.innerText : "").trim();
    if (!text) return;
    const now = Date.now();
    if (now - lastSent < THROTTLE_MS) return;
    lastSent = now;
    chrome.runtime.sendMessage({
      type: "PAGE_TEXT",
      data: {
        url: window.location.href,
        title: document.title,
        text: text.slice(0, MAX_CHARS),
        timestamp: now,
      },
    }, () => void chrome.runtime.lastError);
  }

  if (document.readyState === "complete" || document.readyState === "interactive") {
    setTimeout(harvest, 400);
  } else {
    window.addEventListener("DOMContentLoaded", () => setTimeout(harvest, 400), { once: true });
  }
  window.addEventListener("load", () => setTimeout(harvest, 600), { once: true });
})();
