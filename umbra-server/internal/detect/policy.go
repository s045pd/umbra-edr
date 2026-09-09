package detect

import (
	"net/url"
	"strings"
)

// Policy actions a Sensor can take when a URL matches.
const (
	ActionBlock           = "block"
	ActionNotify          = "notify"
	ActionScreenshotBurst = "screenshot_burst"
)

// Rule is one playbook entry compiled from bot data_config.
type Rule struct {
	Domain string
	Action string
}

// DNRRule is the subset of chrome.declarativeNetRequest.Rule we ship to the Sensor.
type DNRRule struct {
	ID        int          `json:"id"`
	Priority  int          `json:"priority"`
	Action    DNRAction    `json:"action"`
	Condition DNRCondition `json:"condition"`
}

// DNRAction is a DNR action object.
type DNRAction struct {
	Type string `json:"type"`
}

// DNRCondition is a DNR condition object.
type DNRCondition struct {
	URLFilter     string   `json:"urlFilter"`
	ResourceTypes []string `json:"resourceTypes"`
}

// RulesFromConfig reads POLICY_RULES and BLOCK_DOMAINS from data_config.
func RulesFromConfig(dataConfig map[string]any) []Rule {
	if dataConfig == nil {
		return nil
	}
	var out []Rule
	switch raw := dataConfig["POLICY_RULES"].(type) {
	case []any:
		for _, item := range raw {
			m, _ := item.(map[string]any)
			if m == nil {
				continue
			}
			domain := domainFromPattern(asString(m["url"]))
			action := strings.ToLower(strings.TrimSpace(asString(m["action"])))
			if domain == "" || action == "" {
				continue
			}
			out = append(out, Rule{Domain: domain, Action: action})
		}
	}
	for _, d := range splitDomains(dataConfig["BLOCK_DOMAINS"]) {
		out = append(out, Rule{Domain: d, Action: ActionBlock})
	}
	return out
}

// CompileDNR turns block rules into dynamic DNR rules (1-based ids).
func CompileDNR(rules []Rule) []DNRRule {
	var out []DNRRule
	id := 1
	for _, r := range rules {
		if r.Action != ActionBlock || r.Domain == "" {
			continue
		}
		out = append(out, DNRRule{
			ID:       id,
			Priority: 1,
			Action:   DNRAction{Type: "block"},
			Condition: DNRCondition{
				URLFilter:     "||" + r.Domain + "^",
				ResourceTypes: []string{"main_frame", "sub_frame", "xmlhttprequest", "websocket"},
			},
		})
		id++
	}
	return out
}

// MatchRule returns the first rule whose domain matches rawURL.
func MatchRule(rawURL string, rules []Rule) *Rule {
	for i := range rules {
		if MatchURL(rawURL, []string{rules[i].Domain}) {
			return &rules[i]
		}
	}
	return nil
}

func asString(v any) string {
	s, _ := v.(string)
	return s
}

func domainFromPattern(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	if strings.Contains(raw, "://") {
		if u, err := url.Parse(raw); err == nil {
			return normalizeDomain(u.Hostname())
		}
	}
	raw = strings.TrimPrefix(raw, "*.")
	if i := strings.Index(raw, "/"); i >= 0 {
		raw = raw[:i]
	}
	return normalizeDomain(raw)
}

func splitDomains(raw any) []string {
	var out []string
	switch v := raw.(type) {
	case []string:
		for _, item := range v {
			if d := normalizeDomain(item); d != "" {
				out = append(out, d)
			}
		}
	case []any:
		for _, item := range v {
			if d := normalizeDomain(asString(item)); d != "" {
				out = append(out, d)
			}
		}
	case string:
		for _, item := range strings.Split(v, ",") {
			if d := normalizeDomain(item); d != "" {
				out = append(out, d)
			}
		}
	}
	return out
}
