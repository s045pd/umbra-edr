package detect

import "testing"

func TestMatchURL(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name    string
		rawURL  string
		domains []string
		want    bool
	}{
		{name: "exact host", rawURL: "https://bank.example/login", domains: []string{"bank.example"}, want: true},
		{name: "subdomain", rawURL: "https://mail.google.com/inbox", domains: []string{"google.com"}, want: true},
		{name: "wildcard prefix", rawURL: "https://a.b.example.com/", domains: []string{"*.example.com"}, want: true},
		{name: "query string is not a host", rawURL: "https://evil.test/?q=google.com", domains: []string{"google.com"}, want: false},
		{name: "suffix without label boundary", rawURL: "https://notgoogle.com/", domains: []string{"google.com"}, want: false},
		{name: "port stripped", rawURL: "https://intranet.corp:8443/x", domains: []string{"intranet.corp"}, want: true},
		{name: "empty domains", rawURL: "https://bank.example/", domains: nil, want: false},
		{name: "invalid url", rawURL: "not a url", domains: []string{"bank.example"}, want: false},
		{name: "whitespace and case", rawURL: "https://Mail.Example.COM/a", domains: []string{"  EXAMPLE.com "}, want: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if got := MatchURL(tc.rawURL, tc.domains); got != tc.want {
				t.Fatalf("MatchURL(%q, %v) = %v, want %v", tc.rawURL, tc.domains, got, tc.want)
			}
		})
	}
}

func TestDomainsFromConfig(t *testing.T) {
	t.Parallel()
	got := DomainsFromConfig(map[string]any{
		"NOTIFICATION_DOMAINS": []any{"Bank.Example", "  ", "evil.test"},
	})
	if len(got) != 2 || got[0] != "bank.example" || got[1] != "evil.test" {
		t.Fatalf("got %#v", got)
	}
	fromCSV := DomainsFromConfig(map[string]any{"NOTIFICATION_DOMAINS": "a.com, b.com"})
	if len(fromCSV) != 2 {
		t.Fatalf("csv got %#v", fromCSV)
	}
}

func TestNotificationEnabled(t *testing.T) {
	t.Parallel()
	if !NotificationEnabled(map[string]any{"NOTIFICATION": true}) {
		t.Fatal("expected enabled")
	}
	if NotificationEnabled(map[string]any{"NOTIFICATION": false}) {
		t.Fatal("expected disabled")
	}
	if NotificationEnabled(nil) {
		t.Fatal("nil config is disabled")
	}
}
