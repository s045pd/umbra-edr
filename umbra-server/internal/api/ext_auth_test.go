package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"

	"github.com/s045pd/umbra/internal/db/models"
	"github.com/s045pd/umbra/internal/utils"
)

func setupExtAuthAPI(t *testing.T) (*ExtAuthAPI, *gorm.DB) {
	t.Helper()
	g, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := g.AutoMigrate(models.All()...); err != nil {
		t.Fatal(err)
	}
	return &ExtAuthAPI{DB: g}, g
}

func TestExtLogin_RPCOverridesIsOnline(t *testing.T) {
	a, gdb := setupExtAuthAPI(t)
	hash, err := utils.HashPassword("secret", 4)
	if err != nil {
		t.Fatal(err)
	}
	if err := gdb.Create(&models.User{Username: "admin", Password: hash}).Error; err != nil {
		t.Fatal(err)
	}
	bot := seedBot(t, gdb, "sensor")
	if !bot.IsOnline {
		t.Fatal("seedBot should produce is_online=true")
	}
	a.RPC = &fakeRPC{online: false}

	body, _ := json.Marshal(map[string]string{"username": "admin", "password": "secret"})
	r := httptest.NewRequest(http.MethodPost, "/api/v1/ext/login", bytes.NewReader(body))
	rr := httptest.NewRecorder()
	a.Login(rr, r)
	if rr.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rr.Code, rr.Body.String())
	}
	var resp envelope
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	bots := resp.Result.(map[string]any)["bots"].([]any)
	if len(bots) != 1 {
		t.Fatalf("got %d bots, want 1", len(bots))
	}
	got := bots[0].(map[string]any)["is_online"].(bool)
	if got {
		t.Errorf("is_online = true, want false (RPC says no active socket)")
	}

	a.RPC = &fakeRPC{online: true}
	rr2 := httptest.NewRecorder()
	a.Login(rr2, httptest.NewRequest(http.MethodPost, "/api/v1/ext/login", bytes.NewReader(body)))
	var resp2 envelope
	if err := json.Unmarshal(rr2.Body.Bytes(), &resp2); err != nil {
		t.Fatal(err)
	}
	got2 := resp2.Result.(map[string]any)["bots"].([]any)[0].(map[string]any)["is_online"].(bool)
	if !got2 {
		t.Errorf("is_online = false, want true (RPC says socket is live)")
	}
}
