package api

import (
	"net/http"
	"strings"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/s045pd/umbra/internal/auth"
	"github.com/s045pd/umbra/internal/db/models"
)

// AuditAPI lists operator audit records.
type AuditAPI struct {
	DB *gorm.DB
}

type auditView struct {
	ID        uuid.UUID `json:"id"`
	UserID    uuid.UUID `json:"user_id"`
	Username  string    `json:"username"`
	Method    string    `json:"method"`
	Path      string    `json:"path"`
	Action    string    `json:"action"`
	Detail    string    `json:"detail"`
	IP        string    `json:"ip"`
	Status    int       `json:"status"`
	CreatedAt string    `json:"created_at"`
}

// List is GET /api/v1/audit
func (a *AuditAPI) List(w http.ResponseWriter, r *http.Request) {
	if _, ok := requireAdmin(a.DB, w, r); !ok {
		return
	}
	limit, offset := parseLimitOffset(r, 100)
	var rows []models.OperatorAudit
	if err := a.DB.Order(`"createdAt" DESC`).Limit(limit).Offset(offset).Find(&rows).Error; err != nil {
		JSONErr(w, http.StatusInternalServerError, "query failed")
		return
	}
	out := make([]auditView, 0, len(rows))
	for _, row := range rows {
		out = append(out, auditView{
			ID: row.ID, UserID: row.UserID, Username: row.Username,
			Method: row.Method, Path: row.Path, Action: row.Action,
			Detail: row.Detail, IP: row.IP, Status: row.Status,
			CreatedAt: row.CreatedAt.UTC().Format("2006-01-02T15:04:05.000Z"),
		})
	}
	JSONOK(w, out)
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}

// AuditMutations logs POST/PUT/DELETE on the operator API.
func AuditMutations(db *gorm.DB) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if db == nil || !isMutating(r.Method) || !strings.HasPrefix(r.URL.Path, "/api/") {
				next.ServeHTTP(w, r)
				return
			}
			rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
			next.ServeHTTP(rec, r)
			s, ok := auth.SessionFromContext(r.Context())
			if !ok {
				return
			}
			username := ""
			var u models.User
			if err := db.Select("username").Where("id = ?", s.UserID).First(&u).Error; err == nil {
				username = u.Username
			}
			_ = db.Create(&models.OperatorAudit{
				UserID:   s.UserID,
				Username: username,
				Method:   r.Method,
				Path:     r.URL.Path,
				Action:   r.Method + " " + r.URL.Path,
				Detail:   r.URL.RawQuery,
				IP:       r.RemoteAddr,
				Status:   rec.status,
			}).Error
		})
	}
}

func isMutating(method string) bool {
	switch method {
	case http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
		return true
	default:
		return false
	}
}
