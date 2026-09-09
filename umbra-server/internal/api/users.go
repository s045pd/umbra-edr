package api

import (
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/s045pd/umbra/internal/auth"
	"github.com/s045pd/umbra/internal/db/models"
	"github.com/s045pd/umbra/internal/utils"
)

// UsersAPI is operator account management (admin role only).
type UsersAPI struct {
	DB           *gorm.DB
	BcryptRounds int
}

type userView struct {
	ID          uuid.UUID `json:"id"`
	Username    string    `json:"username"`
	Role        string    `json:"role"`
	TOTPEnabled bool      `json:"totp_enabled"`
}

func toUserView(u models.User) userView {
	role := u.Role
	if role == "" {
		role = "admin"
	}
	return userView{ID: u.ID, Username: u.Username, Role: role, TOTPEnabled: u.TOTPEnabled}
}

func loadActor(db *gorm.DB, r *http.Request) (models.User, bool) {
	s, ok := auth.SessionFromContext(r.Context())
	if !ok || db == nil {
		return models.User{}, false
	}
	var u models.User
	if err := db.Where("id = ?", s.UserID).First(&u).Error; err != nil {
		return models.User{}, false
	}
	return u, true
}

func isAdmin(u models.User) bool {
	return u.Role == "admin" || u.Role == ""
}

func requireAdmin(db *gorm.DB, w http.ResponseWriter, r *http.Request) (models.User, bool) {
	u, ok := loadActor(db, r)
	if !ok {
		JSONErr(w, http.StatusUnauthorized, "no session")
		return u, false
	}
	if !isAdmin(u) {
		JSONErr(w, http.StatusForbidden, "admin role required")
		return u, false
	}
	return u, true
}

// List is GET /api/v1/users
func (a *UsersAPI) List(w http.ResponseWriter, r *http.Request) {
	if _, ok := requireAdmin(a.DB, w, r); !ok {
		return
	}
	var rows []models.User
	if err := a.DB.Order("username").Find(&rows).Error; err != nil {
		JSONErr(w, http.StatusInternalServerError, "query failed")
		return
	}
	out := make([]userView, 0, len(rows))
	for _, u := range rows {
		out = append(out, toUserView(u))
	}
	JSONOK(w, out)
}

type createUserReq struct {
	Username string `json:"username"`
	Password string `json:"password"`
	Role     string `json:"role"`
}

// Create is POST /api/v1/users
func (a *UsersAPI) Create(w http.ResponseWriter, r *http.Request) {
	if _, ok := requireAdmin(a.DB, w, r); !ok {
		return
	}
	var body createUserReq
	if !MustDecode(w, r, &body) {
		return
	}
	body.Username = strings.TrimSpace(body.Username)
	if body.Username == "" || len(body.Password) < 8 {
		JSONErr(w, http.StatusBadRequest, "username and 8+ char password required")
		return
	}
	role := strings.ToLower(strings.TrimSpace(body.Role))
	if role == "" {
		role = "operator"
	}
	if role != "admin" && role != "operator" {
		JSONErr(w, http.StatusBadRequest, "role must be admin or operator")
		return
	}
	hash, err := utils.HashPassword(body.Password, a.BcryptRounds)
	if err != nil {
		JSONErr(w, http.StatusInternalServerError, "hash failed")
		return
	}
	u := models.User{
		Username:                body.Username,
		Password:                hash,
		Role:                    role,
		PasswordShouldBeChanged: true,
	}
	if err := a.DB.Create(&u).Error; err != nil {
		JSONErr(w, http.StatusConflict, "username already exists")
		return
	}
	JSONOK(w, toUserView(u))
}

// Delete is DELETE /api/v1/users/{id}
func (a *UsersAPI) Delete(w http.ResponseWriter, r *http.Request) {
	actor, ok := requireAdmin(a.DB, w, r)
	if !ok {
		return
	}
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		JSONErr(w, http.StatusBadRequest, "invalid id")
		return
	}
	if id == actor.ID {
		JSONErr(w, http.StatusBadRequest, "cannot delete yourself")
		return
	}
	var n int64
	if err := a.DB.Model(&models.User{}).Count(&n).Error; err != nil {
		JSONErr(w, http.StatusInternalServerError, "query failed")
		return
	}
	if n <= 1 {
		JSONErr(w, http.StatusBadRequest, "cannot delete the last user")
		return
	}
	res := a.DB.Where("id = ?", id).Delete(&models.User{})
	if res.Error != nil {
		JSONErr(w, http.StatusInternalServerError, "delete failed")
		return
	}
	if res.RowsAffected == 0 {
		JSONErr(w, http.StatusNotFound, "user not found")
		return
	}
	JSONOK(w, map[string]any{"deleted": true})
}
