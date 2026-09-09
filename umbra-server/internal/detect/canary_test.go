package detect

import "testing"

func TestCanaryCookieName(t *testing.T) {
	if CookieName != "__umbra_canary" {
		t.Fatalf("name=%s", CookieName)
	}
}

func TestNewToken_Unique(t *testing.T) {
	a, err := NewToken()
	if err != nil {
		t.Fatal(err)
	}
	b, err := NewToken()
	if err != nil {
		t.Fatal(err)
	}
	if a == b || len(a) < 16 {
		t.Fatalf("a=%s b=%s", a, b)
	}
}

func TestForeignCanary_FindsOtherEndpoint(t *testing.T) {
	cookies := []map[string]any{
		{"name": "sid", "value": "abc", "domain": "app.example"},
		{"name": CookieName, "value": "token-other", "domain": "app.example"},
	}
	got := ForeignCanary(cookies, "token-self")
	if got == nil || got.Value != "token-other" {
		t.Fatalf("got=%+v", got)
	}
	if ForeignCanary(cookies, "token-other") != nil {
		t.Fatal("own token should not be foreign")
	}
}

func TestLookupOwner(t *testing.T) {
	owners := map[string]string{
		"token-a": "bot-a",
		"token-b": "bot-b",
	}
	if LookupOwner(owners, "token-b") != "bot-b" {
		t.Fatal("miss")
	}
	if LookupOwner(owners, "unknown") != "" {
		t.Fatal("unknown should be empty")
	}
}
