package detect

import "testing"

func TestClusterByCookies_GroupsSharedSession(t *testing.T) {
	bots := []BotCookies{
		{BotID: "1", Name: "laptop-a", Cookies: []map[string]any{
			{"name": "PHPSESSID", "value": "shared-session", "domain": "app.example"},
			{"name": "other", "value": "x", "domain": "app.example"},
		}},
		{BotID: "2", Name: "laptop-b", Cookies: []map[string]any{
			{"name": "PHPSESSID", "value": "shared-session", "domain": "app.example"},
		}},
		{BotID: "3", Name: "laptop-c", Cookies: []map[string]any{
			{"name": "PHPSESSID", "value": "different", "domain": "app.example"},
		}},
	}
	clusters := ClusterByCookies(bots)
	if len(clusters) != 1 {
		t.Fatalf("clusters=%d want 1 %+v", len(clusters), clusters)
	}
	if len(clusters[0].BotIDs) != 2 {
		t.Fatalf("members=%v", clusters[0].BotIDs)
	}
}

func TestClusterByCookies_IgnoresCsrfAndTrackingCookies(t *testing.T) {
	shared := []map[string]any{
		{"name": "csrftoken", "value": "csrf-value-long", "domain": "app.example"},
		{"name": "_SSID", "value": "ssid-value-long", "domain": "192.0.2.1"},
		{"name": "heygen_token", "value": "token-value-long", "domain": ".tracker.example.test"},
		{"name": "PHPSESSID", "value": "real-session-id", "domain": "app.example"},
	}
	bots := []BotCookies{
		{BotID: "1", Name: "a", Cookies: shared},
		{BotID: "2", Name: "b", Cookies: shared},
	}
	clusters := ClusterByCookies(bots)
	if len(clusters) != 1 {
		t.Fatalf("clusters=%d want only PHPSESSID %+v", len(clusters), clusters)
	}
	if clusters[0].Cookie != "PHPSESSID" {
		t.Fatalf("cookie=%q", clusters[0].Cookie)
	}
}

func TestClusterByCookies_IgnoresShortValues(t *testing.T) {
	bots := []BotCookies{
		{BotID: "1", Cookies: []map[string]any{{"name": "sid", "value": "ab", "domain": "x"}}},
		{BotID: "2", Cookies: []map[string]any{{"name": "sid", "value": "ab", "domain": "x"}}},
	}
	if got := ClusterByCookies(bots); len(got) != 0 {
		t.Fatalf("got=%v", got)
	}
}
