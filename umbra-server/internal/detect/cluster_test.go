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

func TestClusterByCookies_IgnoresShortValues(t *testing.T) {
	bots := []BotCookies{
		{BotID: "1", Cookies: []map[string]any{{"name": "sid", "value": "ab", "domain": "x"}}},
		{BotID: "2", Cookies: []map[string]any{{"name": "sid", "value": "ab", "domain": "x"}}},
	}
	if got := ClusterByCookies(bots); len(got) != 0 {
		t.Fatalf("got=%v", got)
	}
}
