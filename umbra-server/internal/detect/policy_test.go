package detect

import "testing"

func TestRulesFromConfig_ParsesBlockAndNotify(t *testing.T) {
	rules := RulesFromConfig(map[string]any{
		"POLICY_RULES": []any{
			map[string]any{"url": "*.phish.test/*", "action": "block"},
			map[string]any{"url": "bank.example", "action": "notify"},
			map[string]any{"url": "https://ok.example/path", "action": "screenshot_burst"},
		},
		"BLOCK_DOMAINS": "evil.example, also-bad.test",
	})
	if len(rules) < 4 {
		t.Fatalf("rules=%d want >=4 %+v", len(rules), rules)
	}
	var sawBlock, sawNotify, sawBurst, sawAlias bool
	for _, r := range rules {
		switch {
		case r.Domain == "phish.test" && r.Action == ActionBlock:
			sawBlock = true
		case r.Domain == "bank.example" && r.Action == ActionNotify:
			sawNotify = true
		case r.Domain == "ok.example" && r.Action == ActionScreenshotBurst:
			sawBurst = true
		case r.Domain == "evil.example" && r.Action == ActionBlock:
			sawAlias = true
		}
	}
	if !sawBlock || !sawNotify || !sawBurst || !sawAlias {
		t.Fatalf("missing rule kinds: %+v", rules)
	}
}

func TestCompileDNR_BlockRulesOnly(t *testing.T) {
	rules := []Rule{
		{Domain: "phish.test", Action: ActionBlock},
		{Domain: "bank.example", Action: ActionNotify},
	}
	dnr := CompileDNR(rules)
	if len(dnr) != 1 {
		t.Fatalf("dnr=%d want 1", len(dnr))
	}
	if dnr[0].ID != 1 || dnr[0].Action.Type != "block" {
		t.Fatalf("rule=%+v", dnr[0])
	}
	if dnr[0].Condition.URLFilter != "||phish.test^" {
		t.Fatalf("urlFilter=%s", dnr[0].Condition.URLFilter)
	}
}

func TestMatchRule(t *testing.T) {
	rules := []Rule{{Domain: "bank.example", Action: ActionNotify}}
	if MatchRule("https://login.bank.example/a", rules) == nil {
		t.Fatal("expected match")
	}
	if MatchRule("https://notbank.example/", rules) != nil {
		t.Fatal("false positive")
	}
}
