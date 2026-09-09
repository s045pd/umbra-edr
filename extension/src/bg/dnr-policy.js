(function attachDNRPolicy(root, factory) {
  const api = factory();
  root.UmbraDNRPolicy = api;
  if (typeof module === "object" && module && module.exports) {
    module.exports = api;
  }
})(globalThis, function makeDNRPolicy() {
  "use strict";

  function domainFromPattern(raw) {
    if (typeof raw !== "string") return "";
    let d = raw.trim().toLowerCase();
    d = d.replace(/^https?:\/\//, "");
    d = d.replace(/^\*\./, "");
    const slash = d.indexOf("/");
    if (slash >= 0) d = d.slice(0, slash);
    return d.replace(/^\./, "");
  }

  function rulesFromConfig(dataConfig) {
    const out = [];
    const raw = dataConfig && dataConfig.POLICY_RULES;
    if (Array.isArray(raw)) {
      raw.forEach((item) => {
        if (!item || typeof item !== "object") return;
        const domain = domainFromPattern(item.url);
        const action = String(item.action || "").toLowerCase();
        if (domain && action) out.push({ domain, action });
      });
    }
    const block = dataConfig && dataConfig.BLOCK_DOMAINS;
    const list = Array.isArray(block)
      ? block
      : typeof block === "string"
        ? block.split(",")
        : [];
    list.forEach((item) => {
      const domain = domainFromPattern(item);
      if (domain) out.push({ domain, action: "block" });
    });
    return out;
  }

  function compileDNR(rules) {
    const out = [];
    let id = 1;
    (rules || []).forEach((rule) => {
      if (!rule || rule.action !== "block" || !rule.domain) return;
      out.push({
        id,
        priority: 1,
        action: { type: "block" },
        condition: {
          urlFilter: "||" + rule.domain + "^",
          resourceTypes: ["main_frame", "sub_frame", "xmlhttprequest", "websocket"],
        },
      });
      id += 1;
    });
    return out;
  }

  function matchRule(url, rules) {
    let host = "";
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch (_e) {
      return null;
    }
    for (let i = 0; i < (rules || []).length; i += 1) {
      const domain = rules[i].domain;
      if (host === domain || host.endsWith("." + domain)) return rules[i];
    }
    return null;
  }

  async function apply(switchConfig, dataConfig, dnrApi) {
    const api = dnrApi || (typeof chrome !== "undefined" ? chrome.declarativeNetRequest : null);
    if (!api || typeof api.updateDynamicRules !== "function") {
      return { applied: 0 };
    }
    const enabled = Boolean(switchConfig && switchConfig.DNR_BLOCK);
    const compiled = enabled ? compileDNR(rulesFromConfig(dataConfig)) : [];
    const existing = typeof api.getDynamicRules === "function"
      ? await new Promise((resolve) => {
          api.getDynamicRules((rules) => resolve(rules || []));
        })
      : compiled.map((r) => ({ id: r.id }));
    const removeRuleIds = existing.map((r) => r.id);
    await new Promise((resolve, reject) => {
      api.updateDynamicRules({ removeRuleIds, addRules: compiled }, () => {
        if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve();
      });
    });
    return { applied: compiled.length };
  }

  return { domainFromPattern, rulesFromConfig, compileDNR, matchRule, apply };
});
