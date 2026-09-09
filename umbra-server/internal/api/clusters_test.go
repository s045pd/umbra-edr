package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/s045pd/umbra/internal/db/models"
)

func TestClusters_GroupsSharedSession(t *testing.T) {
	_, _, gdb := setupInvestigation(t)
	a := &ClustersAPI{DB: gdb}
	gdb.Create(&models.Bot{
		Name: "a", BrowserID: "ba", ProxyUsername: "ua", ProxyPassword: "x",
		Cookies: models.JSONArray{map[string]any{"name": "PHPSESSID", "value": "shared-session", "domain": "app.example"}},
	})
	gdb.Create(&models.Bot{
		Name: "b", BrowserID: "bb", ProxyUsername: "ub", ProxyPassword: "y",
		Cookies: models.JSONArray{map[string]any{"name": "PHPSESSID", "value": "shared-session", "domain": "app.example"}},
	})
	r := httptest.NewRequest(http.MethodGet, "/api/v1/clusters", nil)
	rr := httptest.NewRecorder()
	a.List(rr, r)
	if rr.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rr.Code, rr.Body.String())
	}
	var resp envelope
	_ = json.Unmarshal(rr.Body.Bytes(), &resp)
	rows := resp.Result.([]any)
	if len(rows) != 1 {
		t.Fatalf("clusters=%d want 1", len(rows))
	}
}
