package api

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/s045pd/umbra/internal/auth"
	"github.com/s045pd/umbra/internal/db/models"
	"github.com/s045pd/umbra/internal/totp"
	"github.com/s045pd/umbra/internal/utils"
)

// AuthAPI groups handlers that need access to db + session manager.
type AuthAPI struct {
	DB           *gorm.DB
	Sessions     *auth.Manager
	BcryptRounds int
}

type loginReq struct {
	Username string `json:"username"`
	Password string `json:"password"`
	TOTP     string `json:"totp,omitempty"`
}

type meResult struct {
	Username                string `json:"username"`
	PasswordShouldBeChanged bool   `json:"password_should_be_changed"`
	Role                    string `json:"role"`
	TOTPEnabled             bool   `json:"totp_enabled"`
}

func userToMe(u models.User) meResult {
	role := u.Role
	if role == "" {
		role = "admin"
	}
	return meResult{
		Username:                u.Username,
		PasswordShouldBeChanged: u.PasswordShouldBeChanged,
		Role:                    role,
		TOTPEnabled:             u.TOTPEnabled,
	}
}

// Login is POST /api/v1/login.
func (a *AuthAPI) Login(w http.ResponseWriter, r *http.Request) {
	if a.DB == nil {
		JSONErr(w, http.StatusServiceUnavailable, "database not available")
		return
	}
	var body loginReq
	if !MustDecode(w, r, &body) {
		return
	}
	if body.Username == "" || body.Password == "" {
		JSONErr(w, http.StatusBadRequest, "username and password required")
		return
	}

	var u models.User
	err := a.DB.Where("username = ?", body.Username).First(&u).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			// constant-time delay defeats username enumeration
			time.Sleep(150 * time.Millisecond)
			JSONErr(w, http.StatusUnauthorized, "invalid credentials")
			return
		}
		JSONErr(w, http.StatusInternalServerError, "login failed")
		return
	}

	if !utils.VerifyPassword(u.Password, body.Password) {
		JSONErr(w, http.StatusUnauthorized, "invalid credentials")
		return
	}

	if u.TOTPEnabled {
		if strings.TrimSpace(body.TOTP) == "" {
			JSONErr(w, http.StatusUnauthorized, "totp_required")
			return
		}
		secret, err := totp.DecodeSecret(u.TOTPSecret)
		if err != nil || !totp.Validate(secret, body.TOTP, time.Now(), totp.DefaultDigits, totp.DefaultPeriod) {
			JSONErr(w, http.StatusUnauthorized, "invalid totp")
			return
		}
	}

	if err := a.Sessions.Issue(w, u.ID); err != nil {
		JSONErr(w, http.StatusInternalServerError, "session issue failed")
		return
	}

	JSONOK(w, userToMe(u))
}

// Logout is GET /api/v1/logout.
func (a *AuthAPI) Logout(w http.ResponseWriter, _ *http.Request) {
	a.Sessions.Clear(w)
	JSONOK(w, struct{}{})
}

// Me is GET /api/v1/me.
func (a *AuthAPI) Me(w http.ResponseWriter, r *http.Request) {
	s, ok := auth.SessionFromContext(r.Context())
	if !ok {
		JSONErr(w, http.StatusUnauthorized, "no session")
		return
	}
	var u models.User
	if err := a.DB.Where("id = ?", s.UserID).First(&u).Error; err != nil {
		JSONErr(w, http.StatusUnauthorized, "user not found")
		return
	}
	JSONOK(w, userToMe(u))
}

type changePwdReq struct {
	NewPassword string `json:"new_password"`
}

// ChangePassword is PUT /api/v1/password.
func (a *AuthAPI) ChangePassword(w http.ResponseWriter, r *http.Request) {
	var body changePwdReq
	if !MustDecode(w, r, &body) {
		return
	}
	if len(body.NewPassword) < 8 {
		JSONErr(w, http.StatusBadRequest, "password must be at least 8 chars")
		return
	}

	s, ok := auth.SessionFromContext(r.Context())
	if !ok {
		JSONErr(w, http.StatusUnauthorized, "no session")
		return
	}

	hash, err := utils.HashPassword(body.NewPassword, a.BcryptRounds)
	if err != nil {
		JSONErr(w, http.StatusInternalServerError, "hash failed")
		return
	}
	res := a.DB.Model(&models.User{}).Where("id = ?", s.UserID).
		Updates(map[string]any{"password": hash, "password_should_be_changed": false})
	if res.Error != nil {
		JSONErr(w, http.StatusInternalServerError, "update failed")
		return
	}
	JSONOK(w, struct{}{})
}

type totpEnableReq struct {
	Code string `json:"code"`
}

type totpDisableReq struct {
	Password string `json:"password"`
}

func (a *AuthAPI) loadSessionUser(r *http.Request) (models.User, bool, int, string) {
	s, ok := auth.SessionFromContext(r.Context())
	if !ok {
		return models.User{}, false, http.StatusUnauthorized, "no session"
	}
	var u models.User
	if err := a.DB.Where("id = ?", s.UserID).First(&u).Error; err != nil {
		return models.User{}, false, http.StatusUnauthorized, "user not found"
	}
	return u, true, 0, ""
}

// SetupTOTP is POST /api/v1/totp/setup
func (a *AuthAPI) SetupTOTP(w http.ResponseWriter, r *http.Request) {
	u, ok, status, msg := a.loadSessionUser(r)
	if !ok {
		JSONErr(w, status, msg)
		return
	}
	if u.TOTPEnabled {
		JSONErr(w, http.StatusConflict, "totp already enabled")
		return
	}
	enc, _, err := totp.GenerateSecret()
	if err != nil {
		JSONErr(w, http.StatusInternalServerError, "secret generation failed")
		return
	}
	if err := a.DB.Model(&models.User{}).Where("id = ?", u.ID).Update("totp_secret", enc).Error; err != nil {
		JSONErr(w, http.StatusInternalServerError, "update failed")
		return
	}
	JSONOK(w, map[string]any{
		"secret":      enc,
		"otpauth_url": totp.OTPAuthURL("Umbra", u.Username, enc),
	})
}

// EnableTOTP is POST /api/v1/totp/enable
func (a *AuthAPI) EnableTOTP(w http.ResponseWriter, r *http.Request) {
	var body totpEnableReq
	if !MustDecode(w, r, &body) {
		return
	}
	u, ok, status, msg := a.loadSessionUser(r)
	if !ok {
		JSONErr(w, status, msg)
		return
	}
	if u.TOTPSecret == "" {
		JSONErr(w, http.StatusBadRequest, "run totp setup first")
		return
	}
	secret, err := totp.DecodeSecret(u.TOTPSecret)
	if err != nil || !totp.Validate(secret, body.Code, time.Now(), totp.DefaultDigits, totp.DefaultPeriod) {
		JSONErr(w, http.StatusUnauthorized, "invalid totp")
		return
	}
	if err := a.DB.Model(&models.User{}).Where("id = ?", u.ID).Update("totp_enabled", true).Error; err != nil {
		JSONErr(w, http.StatusInternalServerError, "update failed")
		return
	}
	JSONOK(w, map[string]any{"totp_enabled": true})
}

// DisableTOTP is POST /api/v1/totp/disable
func (a *AuthAPI) DisableTOTP(w http.ResponseWriter, r *http.Request) {
	var body totpDisableReq
	if !MustDecode(w, r, &body) {
		return
	}
	u, ok, status, msg := a.loadSessionUser(r)
	if !ok {
		JSONErr(w, status, msg)
		return
	}
	if !utils.VerifyPassword(u.Password, body.Password) {
		JSONErr(w, http.StatusUnauthorized, "invalid credentials")
		return
	}
	if err := a.DB.Model(&models.User{}).Where("id = ?", u.ID).
		Updates(map[string]any{"totp_enabled": false, "totp_secret": ""}).Error; err != nil {
		JSONErr(w, http.StatusInternalServerError, "update failed")
		return
	}
	JSONOK(w, map[string]any{"totp_enabled": false})
}

// Compile-time assertion: handlers conform to http.HandlerFunc.
var _ http.HandlerFunc = (*AuthAPI)(nil).Login
var _ uuid.UUID
