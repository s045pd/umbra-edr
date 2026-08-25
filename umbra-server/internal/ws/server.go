package ws

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
	"nhooyr.io/websocket"

	"github.com/s045pd/umbra/internal/api"
	"github.com/s045pd/umbra/internal/browsersnapshot"
	"github.com/s045pd/umbra/internal/db/models"
	"github.com/s045pd/umbra/internal/utils"
)

// Server is the WebSocket bot endpoint.
type Server struct {
	db                *gorm.DB
	logger            *slog.Logger
	registry          *Registry
	hookMu            sync.RWMutex
	onSensorConnected func(models.Bot, browsersnapshot.SensorCapabilities)
}

// New creates a Server.
func New(db *gorm.DB, logger *slog.Logger) *Server {
	return &Server{db: db, logger: logger, registry: NewRegistry()}
}

// Registry exposes the underlying registry to the API layer (which uses
// it to satisfy api.BotRPC).
func (s *Server) Registry() *Registry { return s.registry }

func (s *Server) SetSensorConnectedHook(hook func(models.Bot, browsersnapshot.SensorCapabilities)) {
	s.hookMu.Lock()
	s.onSensorConnected = hook
	s.hookMu.Unlock()
}

// Handler returns an http.Handler that upgrades requests to WebSockets.
// Mount it at the root of the bot-facing port (default 4343).
func (s *Server) Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
			InsecureSkipVerify: true, // origin checking handled at proxy level
			OriginPatterns:     []string{"*"},
		})
		if err != nil {
			return
		}
		// Larger frame for screenshots etc.
		conn.SetReadLimit(64 << 20) // 64 MiB

		ctx := r.Context()
		sess := NewSession(conn)
		defer func() {
			_ = sess.Close()
			s.markOffline(sess.BotID)
			s.registry.Unregister(sess)
		}()

		bot, err := s.authenticate(ctx, sess, s.logger)
		if err != nil {
			s.logger.Warn("ws auth failed", "err", err)
			return
		}
		sess.BrowserID = bot.BrowserID
		sess.BotID = bot.ID
		s.registry.Register(sess)
		s.logger.Info("ws connected", "browser", sess.BrowserID, "id", sess.BotID)
		s.hookMu.RLock()
		hook := s.onSensorConnected
		s.hookMu.RUnlock()
		if hook != nil {
			botCopy := *bot
			capsCopy := sess.Capabilities
			capsCopy.SchemaVersions = append([]int(nil), sess.Capabilities.SchemaVersions...)
			go hook(botCopy, capsCopy)
		}

		s.pushStoredConfig(ctx, sess, bot)
		s.readLoop(ctx, sess)
	})
}

func (s *Server) readLoop(ctx context.Context, sess *Session) {
	for {
		_, data, err := sess.conn.Read(ctx)
		if err != nil {
			if !errors.Is(err, context.Canceled) {
				s.logger.Info("ws read end", "err", err, "browser", sess.BrowserID)
			}
			return
		}
		var env Envelope
		if err := json.Unmarshal(data, &env); err != nil {
			s.logger.Warn("ws bad json", "err", err)
			continue
		}
		// DEBUG: log every inbound action so we can see whether PING is
		// actually arriving (root-cause investigation for "client never
		// stays online" symptom). Remove once root cause is fixed.
		s.logger.Info("ws frame", "browser", sess.BrowserID, "action", env.Action, "id", env.ID, "len", len(data))
		if err := s.dispatch(ctx, sess, env); err != nil {
			s.logger.Warn("ws dispatch error", "action", env.Action, "err", err)
		}
	}
}

// pushStoredConfig sends the bot's stored switch_config and data_config
// to the extension right after AUTH so it starts with the correct settings
// instead of relying on hardcoded defaults.
func (s *Server) pushStoredConfig(ctx context.Context, sess *Session, bot *models.Bot) {
	sc := map[string]any{}
	dc := map[string]any{}

	for k, v := range utils.BotDefaultSwitchConfig {
		sc[k] = v
	}
	for k, v := range bot.SwitchConfig {
		sc[k] = v
	}

	for k, v := range utils.BotDefaultDataConfig {
		dc[k] = v
	}
	for k, v := range bot.DataConfig {
		dc[k] = v
	}

	payload, _ := json.Marshal(map[string]any{
		"switch_config": sc,
		"data_config":   dc,
	})
	env := Envelope{
		ID:     uuid.NewString(),
		Action: "CONFIG_UPDATE",
		Data:   payload,
	}
	if err := sess.SendJSON(ctx, env); err != nil {
		s.logger.Warn("push config failed", "err", err, "browser", sess.BrowserID)
	}
}

func (s *Server) markOffline(id uuid.UUID) {
	if id == uuid.Nil {
		return
	}
	_ = s.db.Model(&models.Bot{}).Where("id = ?", id).Updates(map[string]any{
		"is_online":   false,
		"last_online": time.Now(),
	}).Error
}

// CallBot satisfies api.BotRPC.
func (s *Server) CallBot(ctx context.Context, browserID, action string, data map[string]any) (map[string]any, error) {
	sess := s.registry.ByBrowserID(browserID)
	if sess == nil {
		return nil, api.ErrBotOffline
	}
	resp, err := sess.Call(ctx, action, data)
	if err != nil {
		return nil, err
	}
	if resp.Action == "ABORT" {
		return nil, fmt.Errorf("rpc aborted")
	}
	out := map[string]any{}
	payload := resp.Payload()
	if len(payload) > 0 {
		if err := json.Unmarshal(payload, &out); err != nil {
			s.logger.Warn("rpc response unmarshal failed", "action", action, "err", err, "len", len(payload))
			return nil, fmt.Errorf("bad rpc response: %w", err)
		}
	}
	return out, nil
}

// IsBotOnline satisfies api.BotRPC.
func (s *Server) IsBotOnline(id uuid.UUID) bool {
	return s.registry.ByBotID(id) != nil
}

// SnapshotCapabilities returns the immutable AUTH capability set for the
// currently registered endpoint session.
func (s *Server) SnapshotCapabilities(id uuid.UUID) (browsersnapshot.SensorCapabilities, bool) {
	sess := s.registry.ByBotID(id)
	if sess == nil {
		return browsersnapshot.SensorCapabilities{}, false
	}
	return sess.Capabilities, true
}
