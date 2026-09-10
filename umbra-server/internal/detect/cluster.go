package detect

import (
	"crypto/sha256"
	"encoding/hex"
	"sort"
	"strings"
)

// BotCookies is one endpoint's cookie bag for clustering.
type BotCookies struct {
	BotID   string
	Name    string
	Cookies []map[string]any
}

// Cluster is a set of endpoints sharing a session-like cookie.
type Cluster struct {
	Key      string   `json:"key"`
	Cookie   string   `json:"cookie"`
	Domain   string   `json:"domain"`
	BotIDs   []string `json:"bot_ids"`
	BotNames []string `json:"bot_names"`
}

var sessionCookieNames = map[string]struct{}{
	"phpsessid": {}, "jsessionid": {}, "sid": {}, "session": {},
	"sessionid": {}, "connect.sid": {}, "auth_token": {},
	"asp.net_sessionid": {}, "__secure-next-auth.session-token": {},
}

// ClusterByCookies groups endpoints that share a session cookie value.
func ClusterByCookies(bots []BotCookies) []Cluster {
	type member struct {
		id, name string
	}
	groups := map[string][]member{}
	meta := map[string][2]string{} // key -> {cookie, domain}
	for _, bot := range bots {
		seen := map[string]struct{}{}
		for _, c := range bot.Cookies {
			name, _ := c["name"].(string)
			val, _ := c["value"].(string)
			domain, _ := c["domain"].(string)
			if !isSessionCookie(name, val) {
				continue
			}
			key := cookieKey(name, domain, val)
			if _, ok := seen[key]; ok {
				continue
			}
			seen[key] = struct{}{}
			groups[key] = append(groups[key], member{id: bot.BotID, name: bot.Name})
			meta[key] = [2]string{name, domain}
		}
	}
	var out []Cluster
	for key, members := range groups {
		if len(members) < 2 {
			continue
		}
		ids := make([]string, 0, len(members))
		names := make([]string, 0, len(members))
		for _, m := range members {
			ids = append(ids, m.id)
			names = append(names, m.name)
		}
		sort.Strings(ids)
		info := meta[key]
		out = append(out, Cluster{
			Key: key, Cookie: info[0], Domain: info[1],
			BotIDs: ids, BotNames: names,
		})
	}
	sort.Slice(out, func(i, j int) bool { return len(out[i].BotIDs) > len(out[j].BotIDs) })
	return out
}

func isSessionCookie(name, value string) bool {
	if len(value) < 8 {
		return false
	}
	n := strings.ToLower(strings.TrimSpace(name))
	if strings.Contains(n, "csrf") {
		return false
	}
	if _, ok := sessionCookieNames[n]; ok {
		return true
	}
	return strings.Contains(n, "session")
}

func cookieKey(name, domain, value string) string {
	sum := sha256.Sum256([]byte(strings.ToLower(name) + "|" + strings.ToLower(domain) + "|" + value))
	return hex.EncodeToString(sum[:8])
}
