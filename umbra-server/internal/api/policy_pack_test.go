package api

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/s045pd/umbra/internal/crxsign"
)

func TestChromePolicyJSON_IncludesQuicOffAndForcelist(t *testing.T) {
	dir := t.TempDir()
	key := filepath.Join(dir, "extkey.pem")
	signer, err := crxsign.LoadOrGenerate(key)
	if err != nil {
		t.Fatal(err)
	}
	c := &crxAPI{signer: signer, publicURL: "https://umbra.example"}
	r := httptest.NewRequest("GET", "/ext/chrome-policy.json", nil)
	rr := httptest.NewRecorder()
	c.ServeChromePolicy(rr, r)
	if rr.Code != 200 {
		t.Fatalf("status=%d body=%s", rr.Code, rr.Body.String())
	}
	var doc map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &doc); err != nil {
		t.Fatal(err)
	}
	if doc["QuicAllowed"] != false {
		t.Fatalf("QuicAllowed=%v", doc["QuicAllowed"])
	}
	list, _ := doc["ExtensionInstallForcelist"].([]any)
	if len(list) != 1 || !strings.Contains(list[0].(string), signer.ExtensionID()) {
		t.Fatalf("forcelist=%v", list)
	}
}

func TestChromePolicyREG_ContainsQuicAndForcelist(t *testing.T) {
	dir := t.TempDir()
	signer, err := crxsign.LoadOrGenerate(filepath.Join(dir, "k.pem"))
	if err != nil {
		t.Fatal(err)
	}
	c := &crxAPI{signer: signer, publicURL: "https://umbra.example"}
	r := httptest.NewRequest("GET", "/ext/chrome-policy.reg", nil)
	rr := httptest.NewRecorder()
	c.ServeChromePolicyREG(rr, r)
	body := rr.Body.String()
	if !strings.Contains(body, "QuicAllowed") || !strings.Contains(body, signer.ExtensionID()) {
		t.Fatalf("reg=%s", body)
	}
	_ = os.RemoveAll(dir)
}
