const assert = require("node:assert/strict");
const test = require("node:test");
const policy = require("../src/bg/dnr-policy.js");

test("rulesFromConfig compiles block domains and playbook entries", () => {
  const rules = policy.rulesFromConfig({
    POLICY_RULES: [
      { url: "*.phish.test/*", action: "block" },
      { url: "https://bank.example/login", action: "notify" },
    ],
    BLOCK_DOMAINS: "evil.example, also-bad.test",
  });
  assert.equal(rules.some((r) => r.domain === "phish.test" && r.action === "block"), true);
  assert.equal(rules.some((r) => r.domain === "bank.example" && r.action === "notify"), true);
  assert.equal(rules.some((r) => r.domain === "evil.example" && r.action === "block"), true);
});

test("compileDNR only emits block rules", () => {
  const dnr = policy.compileDNR([
    { domain: "phish.test", action: "block" },
    { domain: "bank.example", action: "notify" },
  ]);
  assert.equal(dnr.length, 1);
  assert.equal(dnr[0].condition.urlFilter, "||phish.test^");
  assert.equal(dnr[0].action.type, "block");
});

test("matchRule uses DNS label boundaries", () => {
  const rules = [{ domain: "bank.example", action: "notify" }];
  assert.equal(policy.matchRule("https://login.bank.example/", rules).action, "notify");
  assert.equal(policy.matchRule("https://notbank.example/", rules), null);
});
