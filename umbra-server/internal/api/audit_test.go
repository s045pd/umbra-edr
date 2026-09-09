package api

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/s045pd/umbra/internal/db/models"
)

func TestAuditMutations_WritesRow(t *testing.T) {
	a := setupAuthAPI(t)
	id := seedUser(t, a, "alice", "hunter222")
	inner := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusCreated)
	})
	h := AuditMutations(a.DB)(inner)
	r := withSession(httptest.NewRequest(http.MethodPost, "/api/v1/bots", nil), id)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, r)
	if rr.Code != http.StatusCreated {
		t.Fatalf("status=%d", rr.Code)
	}
	var n int64
	if err := a.DB.Model(&models.OperatorAudit{}).Count(&n).Error; err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("audit rows=%d", n)
	}
}

func TestAuditMutations_SkipsGET(t *testing.T) {
	a := setupAuthAPI(t)
	id := seedUser(t, a, "alice", "hunter222")
	h := AuditMutations(a.DB)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	r := withSession(httptest.NewRequest(http.MethodGet, "/api/v1/bots", nil), id)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, r)
	var n int64
	_ = a.DB.Model(&models.OperatorAudit{}).Count(&n).Error
	if n != 0 {
		t.Fatalf("logged GET n=%d", n)
	}
}

func TestAuditList_AdminOnly(t *testing.T) {
	a := setupAuthAPI(t)
	admin := seedUser(t, a, "admin", "hunter222")
	op := seedUser(t, a, "ops", "hunter222")
	_ = a.DB.Model(&models.User{}).Where("id = ?", op).Update("role", "operator")
	api := &AuditAPI{DB: a.DB}

	r := withSession(httptest.NewRequest(http.MethodGet, "/api/v1/audit", nil), op)
	rr := httptest.NewRecorder()
	api.List(rr, r)
	if rr.Code != http.StatusForbidden {
		t.Fatalf("operator status=%d", rr.Code)
	}

	r = withSession(httptest.NewRequest(http.MethodGet, "/api/v1/audit", nil), admin)
	rr = httptest.NewRecorder()
	api.List(rr, r)
	if rr.Code != http.StatusOK {
		t.Fatalf("admin status=%d body=%s", rr.Code, rr.Body.String())
	}
}
