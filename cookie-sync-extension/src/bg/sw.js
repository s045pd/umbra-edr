import { installJobRunnerWakePaths } from "./job-runner.js";

// ShadowLink background service worker.
//
// Two responsibilities:
//
// 1. Silent proxy auth.
//    chrome.proxy.settings.set() applies a proxy config but has no
//    field for username/password. When the upstream proxy requires
//    basic auth, Chrome itself prompts the user with the native
//    "代理 (...) 要求提供用户名和密码" dialog. The MV3 supported way
//    to inject creds is chrome.webRequest.onAuthRequired with
//    "asyncBlocking" mode, gated by webRequest +
//    webRequestAuthProvider permissions. We read the credentials the
//    popup stashed in chrome.storage.local and hand them back. If
//    nothing is configured, we stay silent and Chrome falls back to
//    its native dialog (same as before this file existed).
//
// 2. Visible badge.
//    The popup is hidden most of the time, so the operator needs an
//    at-a-glance indicator of whether their browser is currently
//    being routed through a bot's proxy. We paint a green "ON" pill
//    on the toolbar icon whenever a proxy is active, with the bot
//    name in the action title for hover. When proxy is off the badge
//    is cleared and the title falls back to the manifest default.

const CREDS_KEY = "shadowlink_proxy_creds";
const STATUS_KEY = "shadowlink_proxy_status";

let cachedCreds = null; // { username, password } | null

async function loadCreds() {
  return new Promise((resolve) => {
    chrome.storage.local.get([CREDS_KEY], (out) => {
      const v = out && out[CREDS_KEY];
      cachedCreds =
        v && typeof v.username === "string" && typeof v.password === "string"
          ? { username: v.username, password: v.password }
          : null;
      resolve(cachedCreds);
    });
  });
}

function paintBadge(status) {
  // status: { active: boolean, botName?: string, host?: string }
  const action = chrome.action;
  if (!action) return;
  if (status && status.active) {
    action.setBadgeText({ text: "ON" });
    action.setBadgeBackgroundColor({ color: "#238636" });
    if (action.setBadgeTextColor) {
      action.setBadgeTextColor({ color: "#ffffff" });
    }
    const tip = status.botName
      ? `ShadowLink — proxying via ${status.botName}${
          status.host ? ` (${status.host})` : ""
        }`
      : "ShadowLink — proxy active";
    action.setTitle({ title: tip });
  } else {
    action.setBadgeText({ text: "" });
    action.setTitle({ title: "ShadowLink" });
  }
}

async function loadStatusAndPaint() {
  return new Promise((resolve) => {
    chrome.storage.local.get([STATUS_KEY], (out) => {
      paintBadge(out && out[STATUS_KEY]);
      resolve();
    });
  });
}

// Re-paint badge whenever the popup updates status. Also keep cached
// creds in sync.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[CREDS_KEY]) {
    const v = changes[CREDS_KEY].newValue;
    cachedCreds =
      v && typeof v.username === "string" && typeof v.password === "string"
        ? { username: v.username, password: v.password }
        : null;
  }
  if (changes[STATUS_KEY]) {
    paintBadge(changes[STATUS_KEY].newValue);
  }
});

// Re-paint on every SW wake-up so the badge stays correct after
// browser restart. (Without this the badge would reset to empty.)
chrome.runtime.onInstalled.addListener(() => {
  void loadStatusAndPaint();
});
chrome.runtime.onStartup.addListener(() => {
  void loadStatusAndPaint();
});
// Initial prime when the SW first evaluates.
void loadStatusAndPaint();
void loadCreds();

// Auth interceptor — only handle proxy challenges, leave site auth
// alone so users can still log into actual websites.
chrome.webRequest.onAuthRequired.addListener(
  (details, asyncCallback) => {
    // Diagnostic — keeps showing up in the SW console so we can tell
    // from the inspector which branch fired and why credentials were
    // (or weren't) supplied.
    console.log("[ShadowLink] onAuthRequired fired", {
      url: details.url,
      isProxy: details.isProxy,
      challenger: details.challenger,
      hasCachedCreds: !!cachedCreds,
    });
    if (!details.isProxy) {
      console.log("[ShadowLink] not a proxy challenge, falling back to native dialog");
      asyncCallback({});
      return;
    }
    const supply = (creds) => {
      if (!creds) {
        console.warn(
          "[ShadowLink] proxy challenge but NO credentials in storage — " +
          "make sure you opened the popup and clicked Proxy on a bot first."
        );
        asyncCallback({});
        return;
      }
      console.log("[ShadowLink] supplying creds for proxy", { user: creds.username });
      asyncCallback({
        authCredentials: {
          username: creds.username,
          password: creds.password,
        },
      });
    };
    if (cachedCreds) {
      supply(cachedCreds);
    } else {
      console.log("[ShadowLink] cache cold, loading creds from storage");
      loadCreds().then(supply);
    }
  },
  { urls: ["<all_urls>"] },
  ["asyncBlocking"]
);

// Durable Sync/Clone recovery is initialized alongside the existing proxy
// listener and badge lifecycle. It never replaces either responsibility.
installJobRunnerWakePaths(chrome);
