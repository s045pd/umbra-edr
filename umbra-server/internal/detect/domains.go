// Package detect holds small, testable matching helpers used by the
// browser-EDR path (domain notifications, future rule evaluation).
package detect

import (
	"net/url"
	"strings"
)

// MatchURL reports whether rawURL's host is the domain or a subdomain
// of any entry in domains. Entries may be prefixed with "*.". Matching
// is case-insensitive and requires a DNS label boundary so that
// "notgoogle.com" does not match "google.com".
func MatchURL(rawURL string, domains []string) bool {
	if rawURL == "" || len(domains) == 0 {
		return false
	}
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.Host == "" {
		return false
	}
	host := strings.ToLower(parsed.Hostname())
	if host == "" {
		return false
	}
	for _, raw := range domains {
		domain := normalizeDomain(raw)
		if domain == "" {
			continue
		}
		if host == domain || strings.HasSuffix(host, "."+domain) {
			return true
		}
	}
	return false
}

// DomainsFromConfig reads NOTIFICATION_DOMAINS from a bot data_config
// map. Accepts a string slice, []any, or a comma-separated string.
func DomainsFromConfig(dataConfig map[string]any) []string {
	if dataConfig == nil {
		return nil
	}
	raw, ok := dataConfig["NOTIFICATION_DOMAINS"]
	if !ok || raw == nil {
		return nil
	}
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
			s, _ := item.(string)
			if d := normalizeDomain(s); d != "" {
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

// NotificationEnabled is true when switch_config.NOTIFICATION is set.
func NotificationEnabled(switchConfig map[string]any) bool {
	if switchConfig == nil {
		return false
	}
	switch v := switchConfig["NOTIFICATION"].(type) {
	case bool:
		return v
	case string:
		return strings.EqualFold(v, "true") || v == "1"
	default:
		return false
	}
}

func normalizeDomain(raw string) string {
	d := strings.ToLower(strings.TrimSpace(raw))
	d = strings.TrimPrefix(d, "*.")
	d = strings.TrimPrefix(d, ".")
	return d
}
