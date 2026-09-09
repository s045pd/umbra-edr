package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"

	"github.com/s045pd/umbra/internal/db/models"
)

func setupProxyCredsAPI(t *testing.T) (*ProxyCredsAPI, *gorm.DB, *fakeRPC) {
	t.Helper()
	g, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := g.AutoMigrate(models.All()...); err != nil {
		t.Fatal(err)
	}
	rpc := &fakeRPC{resp: map[string]any{"cookies": []any{"a", "b"}, "history": []any{"x"}}}
	return &ProxyCredsAPI{DB: g, RPC: rpc}, g, rpc
}

func TestVerifyProxyCredentials_Success(t *testing.T) {
	a, gdb, _ := setupProxyCredsAPI(t)
	b := models.Bot{
		BrowserID: "br1", Name: "n", ProxyUsername: "u1", ProxyPassword: "p1",
		IsOnline: true, LastOnline: time.Now(),
	}
	if err := gdb.Create(&b).Error; err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(proxyCredReq{Username: "u1", Password: "p1"})
	r := httptest.NewRequest(http.MethodPost, "/", bytes.NewReader(body))
	rr := httptest.NewRecorder()
	a.VerifyProxyCredentials(rr, r)
	if rr.Code != http.StatusOK {
		t.Fatalf("status=%d", rr.Code)
	}
}

func TestVerifyProxyCredentials_BadCreds(t *testing.T) {
	a, _, _ := setupProxyCredsAPI(t)
	body, _ := json.Marshal(proxyCredReq{Username: "x", Password: "y"})
	r := httptest.NewRequest(http.MethodPost, "/", bytes.NewReader(body))
	rr := httptest.NewRecorder()
	a.VerifyProxyCredentials(rr, r)
	if rr.Code != http.StatusUnauthorized {
		t.Errorf("status=%d", rr.Code)
	}
}

func TestGetBotBrowserCookies(t *testing.T) {
	a, gdb, rpc := setupProxyCredsAPI(t)
	b := models.Bot{BrowserID: "br1", Name: "n", ProxyUsername: "u1", ProxyPassword: "p1", LastOnline: time.Now()}
	gdb.Create(&b)

	body, _ := json.Marshal(proxyCredReq{Username: "u1", Password: "p1"})
	r := httptest.NewRequest(http.MethodPost, "/", bytes.NewReader(body))
	rr := httptest.NewRecorder()
	a.GetBotBrowserCookies(rr, r)
	if rr.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rr.Code, rr.Body.String())
	}
	if len(rpc.calls) != 1 || rpc.calls[0].Action != "GET_BROWSER_COOKIE_ARRAY" {
		t.Errorf("rpc call wrong: %+v", rpc.calls)
	}
}

func TestGetBotBrowser_RequestsAllHistory(t *testing.T) {
	a, gdb, rpc := setupProxyCredsAPI(t)
	b := models.Bot{BrowserID: "br1", Name: "n", ProxyUsername: "u1", ProxyPassword: "p1", LastOnline: time.Now()}
	if err := gdb.Create(&b).Error; err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(proxyCredReq{Username: "u1", Password: "p1"})
	r := httptest.NewRequest(http.MethodPost, "/", bytes.NewReader(body))
	rr := httptest.NewRecorder()
	a.GetBotBrowser(rr, r)
	if rr.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rr.Code, rr.Body.String())
	}
	if len(rpc.calls) != 1 || rpc.calls[0].Action != "GET_BROWSER_HISTORY_ARRAY" {
		t.Fatalf("rpc call wrong: %+v", rpc.calls)
	}
	days, _ := rpc.calls[0].Data["days"].(int)
	if days != 36500 {
		t.Errorf("days=%v, want 36500", rpc.calls[0].Data["days"])
	}
}

func TestGetBotBrowserState(t *testing.T) {
	a, gdb, rpc := setupProxyCredsAPI(t)
	rpc.resp = map[string]any{
		"cookies":   []any{"c1"},
		"history":   []any{"h1"},
		"tabs":      []any{"t1"},
		"bookmarks": []any{"b1"},
	}
	b := models.Bot{BrowserID: "br1", Name: "n", ProxyUsername: "u1", ProxyPassword: "p1", LastOnline: time.Now()}
	if err := gdb.Create(&b).Error; err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(browserStateReq{
		Username:   "u1",
		Password:   "p1",
		Categories: []string{"cookies", "history", "tabs", "bookmarks"},
	})
	r := httptest.NewRequest(http.MethodPost, "/", bytes.NewReader(body))
	rr := httptest.NewRecorder()
	a.GetBotBrowserState(rr, r)
	if rr.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rr.Code, rr.Body.String())
	}
	if len(rpc.calls) != 4 {
		t.Fatalf("calls=%d want 4: %+v", len(rpc.calls), rpc.calls)
	}
	want := []string{"GET_BROWSER_COOKIE_ARRAY", "GET_BROWSER_HISTORY_ARRAY", "GET_TABS", "GET_BOOKMARKS"}
	for i, action := range want {
		if rpc.calls[i].Action != action {
			t.Errorf("call %d action=%s want %s", i, rpc.calls[i].Action, action)
		}
	}
	days, _ := rpc.calls[1].Data["days"].(int)
	if days != 36500 {
		t.Errorf("history days=%v, want 36500", rpc.calls[1].Data["days"])
	}
	var env struct {
		Success bool           `json:"success"`
		Result  map[string]any `json:"result"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &env); err != nil {
		t.Fatal(err)
	}
	if !env.Success {
		t.Fatal("expected success envelope")
	}
	if _, ok := env.Result["cookies"]; !ok {
		t.Errorf("result missing cookies: %+v", env.Result)
	}
}

func TestGetBotBrowserState_UnsupportedCategory(t *testing.T) {
	a, gdb, _ := setupProxyCredsAPI(t)
	b := models.Bot{BrowserID: "br1", Name: "n", ProxyUsername: "u1", ProxyPassword: "p1", LastOnline: time.Now()}
	if err := gdb.Create(&b).Error; err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(browserStateReq{
		Username:   "u1",
		Password:   "p1",
		Categories: []string{"passwords"},
	})
	r := httptest.NewRequest(http.MethodPost, "/", bytes.NewReader(body))
	rr := httptest.NewRecorder()
	a.GetBotBrowserState(rr, r)
	if rr.Code != http.StatusBadRequest {
		t.Errorf("status=%d, want 400", rr.Code)
	}
}

func TestGetBotBrowserState_DefaultsCookies(t *testing.T) {
	a, gdb, rpc := setupProxyCredsAPI(t)
	b := models.Bot{BrowserID: "br1", Name: "n", ProxyUsername: "u1", ProxyPassword: "p1", LastOnline: time.Now()}
	if err := gdb.Create(&b).Error; err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(browserStateReq{Username: "u1", Password: "p1"})
	r := httptest.NewRequest(http.MethodPost, "/", bytes.NewReader(body))
	rr := httptest.NewRecorder()
	a.GetBotBrowserState(rr, r)
	if rr.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rr.Code, rr.Body.String())
	}
	if len(rpc.calls) != 1 || rpc.calls[0].Action != "GET_BROWSER_COOKIE_ARRAY" {
		t.Errorf("rpc call wrong: %+v", rpc.calls)
	}
}

func TestProxyCreds_BotOffline(t *testing.T) {
	a, gdb, rpc := setupProxyCredsAPI(t)
	rpc.err = ErrBotOffline
	b := models.Bot{BrowserID: "br", ProxyUsername: "u", ProxyPassword: "p", LastOnline: time.Now()}
	gdb.Create(&b)
	body, _ := json.Marshal(proxyCredReq{Username: "u", Password: "p"})
	r := httptest.NewRequest(http.MethodPost, "/", bytes.NewReader(body))
	rr := httptest.NewRecorder()
	a.GetBotBrowser(rr, r)
	if rr.Code != http.StatusBadGateway {
		t.Errorf("status=%d, want 502", rr.Code)
	}
	_ = uuid.New
}
