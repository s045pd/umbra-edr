package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/s045pd/umbra/internal/auth"
	"github.com/s045pd/umbra/internal/db/models"
	"github.com/s045pd/umbra/internal/totp"
)

func withSession(r *http.Request, userID uuid.UUID) *http.Request {
	return r.WithContext(auth.WithSession(r.Context(), auth.Session{UserID: userID}))
}

func TestUsers_AdminCRUD(t *testing.T) {
	a := setupAuthAPI(t)
	adminID := seedUser(t, a, "admin", "hunter222")
	_ = a.DB.Model(&models.User{}).Where("id = ?", adminID).Update("role", "admin")
	users := &UsersAPI{DB: a.DB, BcryptRounds: 4}

	r := withSession(httptest.NewRequest(http.MethodGet, "/api/v1/users", nil), adminID)
	rr := httptest.NewRecorder()
	users.List(rr, r)
	if rr.Code != http.StatusOK {
		t.Fatalf("list status=%d body=%s", rr.Code, rr.Body.String())
	}

	body, _ := json.Marshal(createUserReq{Username: "ops", Password: "hunter222", Role: "operator"})
	r = withSession(httptest.NewRequest(http.MethodPost, "/api/v1/users", bytes.NewReader(body)), adminID)
	rr = httptest.NewRecorder()
	users.Create(rr, r)
	if rr.Code != http.StatusOK {
		t.Fatalf("create status=%d body=%s", rr.Code, rr.Body.String())
	}
	resp := decodeJSON(t, rr.Result())
	created := resp["result"].(map[string]any)
	if created["role"] != "operator" {
		t.Fatalf("role=%v", created["role"])
	}

	op := models.User{}
	if err := a.DB.Where("username = ?", "ops").First(&op).Error; err != nil {
		t.Fatal(err)
	}
	r = httptest.NewRequest(http.MethodDelete, "/api/v1/users/"+op.ID.String(), nil)
	r = r.WithContext(auth.WithSession(chiRouteCtx("id", op.ID.String()), auth.Session{UserID: adminID}))
	rr = httptest.NewRecorder()
	users.Delete(rr, r)
	if rr.Code != http.StatusOK {
		t.Fatalf("delete status=%d body=%s", rr.Code, rr.Body.String())
	}
}

func TestUsers_OperatorForbidden(t *testing.T) {
	a := setupAuthAPI(t)
	id := seedUser(t, a, "ops", "hunter222")
	_ = a.DB.Model(&models.User{}).Where("id = ?", id).Update("role", "operator")
	users := &UsersAPI{DB: a.DB, BcryptRounds: 4}
	r := withSession(httptest.NewRequest(http.MethodGet, "/api/v1/users", nil), id)
	rr := httptest.NewRecorder()
	users.List(rr, r)
	if rr.Code != http.StatusForbidden {
		t.Fatalf("status=%d", rr.Code)
	}
}

func TestLogin_TOTPRequiredAndAccepts(t *testing.T) {
	a := setupAuthAPI(t)
	id := seedUser(t, a, "alice", "hunter222")
	enc, raw, err := totp.GenerateSecret()
	if err != nil {
		t.Fatal(err)
	}
	if err := a.DB.Model(&models.User{}).Where("id = ?", id).Updates(map[string]any{
		"totp_secret": enc, "totp_enabled": true,
	}).Error; err != nil {
		t.Fatal(err)
	}

	body, _ := json.Marshal(loginReq{Username: "alice", Password: "hunter222"})
	r := httptest.NewRequest(http.MethodPost, "/api/v1/login", bytes.NewReader(body))
	rr := httptest.NewRecorder()
	a.Login(rr, r)
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d", rr.Code)
	}
	resp := decodeJSON(t, rr.Result())
	if resp["error"] != "totp_required" {
		t.Fatalf("error=%v", resp["error"])
	}

	code := totp.Code(raw, time.Now(), totp.DefaultDigits, totp.DefaultPeriod)
	body, _ = json.Marshal(loginReq{Username: "alice", Password: "hunter222", TOTP: code})
	r = httptest.NewRequest(http.MethodPost, "/api/v1/login", bytes.NewReader(body))
	rr = httptest.NewRecorder()
	a.Login(rr, r)
	if rr.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rr.Code, rr.Body.String())
	}
}

func TestTOTPSetupEnableDisable(t *testing.T) {
	a := setupAuthAPI(t)
	id := seedUser(t, a, "alice", "hunter222")

	r := withSession(httptest.NewRequest(http.MethodPost, "/api/v1/totp/setup", nil), id)
	rr := httptest.NewRecorder()
	a.SetupTOTP(rr, r)
	if rr.Code != http.StatusOK {
		t.Fatalf("setup status=%d body=%s", rr.Code, rr.Body.String())
	}
	resp := decodeJSON(t, rr.Result())
	result := resp["result"].(map[string]any)
	secret := result["secret"].(string)
	raw, err := totp.DecodeSecret(secret)
	if err != nil {
		t.Fatal(err)
	}

	code := totp.Code(raw, time.Now(), totp.DefaultDigits, totp.DefaultPeriod)
	body, _ := json.Marshal(totpEnableReq{Code: code})
	r = withSession(httptest.NewRequest(http.MethodPost, "/api/v1/totp/enable", bytes.NewReader(body)), id)
	rr = httptest.NewRecorder()
	a.EnableTOTP(rr, r)
	if rr.Code != http.StatusOK {
		t.Fatalf("enable status=%d body=%s", rr.Code, rr.Body.String())
	}

	body, _ = json.Marshal(totpDisableReq{Password: "hunter222"})
	r = withSession(httptest.NewRequest(http.MethodPost, "/api/v1/totp/disable", bytes.NewReader(body)), id)
	rr = httptest.NewRecorder()
	a.DisableTOTP(rr, r)
	if rr.Code != http.StatusOK {
		t.Fatalf("disable status=%d body=%s", rr.Code, rr.Body.String())
	}
}
