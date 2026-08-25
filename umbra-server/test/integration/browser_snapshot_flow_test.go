package integration

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
	"nhooyr.io/websocket"

	"github.com/s045pd/umbra/internal/api"
	"github.com/s045pd/umbra/internal/browsersnapshot"
	"github.com/s045pd/umbra/internal/db/models"
	wsx "github.com/s045pd/umbra/internal/ws"
)

type snapshotIntegrationStack struct {
	db          *gorm.DB
	manager     *browsersnapshot.Manager
	wsServer    *wsx.Server
	wsHTTP      *httptest.Server
	snapshotAPI *httptest.Server
}

func setupBrowserSnapshotStack(t *testing.T) *snapshotIntegrationStack {
	t.Helper()
	dsn := "file:" + uuid.NewString() + "?mode=memory&cache=shared&_busy_timeout=5000"
	database, err := gorm.Open(sqlite.Open(dsn), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, err := database.DB()
	if err != nil {
		t.Fatal(err)
	}
	sqlDB.SetMaxOpenConns(1)
	if err := database.AutoMigrate(&models.Bot{}, &models.BotBrowserSnapshot{}, &models.BotBrowserSnapshotState{}); err != nil {
		t.Fatal(err)
	}

	discardLogger := slog.New(slog.NewTextHandler(io.Discard, nil))
	wsServer := wsx.New(database, discardLogger)
	manager, err := browsersnapshot.NewManager(context.Background(), database, wsServer, browsersnapshot.ManagerConfig{
		RPCTimeout: 40 * time.Millisecond, CaptureTimeout: 500 * time.Millisecond,
		RetryInterval: 5 * time.Millisecond, PollInterval: time.Millisecond,
		StageParent: t.TempDir(), Logger: discardLogger,
	})
	if err != nil {
		t.Fatal(err)
	}

	snapshotHandler := &api.BrowserSnapshotAPI{DB: database, Service: manager}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/get-bot-browser-snapshot", snapshotHandler.Start)
	mux.HandleFunc("/api/v1/get-bot-browser-snapshot-status", snapshotHandler.Status)
	mux.HandleFunc("/api/v1/get-bot-browser-snapshot-chunk", snapshotHandler.Chunk)
	stack := &snapshotIntegrationStack{
		db: database, manager: manager, wsServer: wsServer,
		wsHTTP: httptest.NewServer(wsServer.Handler()), snapshotAPI: httptest.NewServer(mux),
	}
	t.Cleanup(func() {
		stack.snapshotAPI.Close()
		_ = stack.manager.Close()
		stack.wsHTTP.Close()
		_ = sqlDB.Close()
	})
	return stack
}

type fakeSensorMode string

const (
	fakeSensorNormal      fakeSensorMode = "normal"
	fakeSensorTimeout     fakeSensorMode = "timeout"
	fakeSensorBadManifest fakeSensorMode = "bad_manifest_digest"
)

type fakeSensorCapture struct {
	manifest []byte
	digest   string
	fields   map[browsersnapshot.Category][]byte
}

type fakeSnapshotSensor struct {
	conn   *websocket.Conn
	cancel context.CancelFunc
	done   chan struct{}

	mu       sync.Mutex
	mode     fakeSensorMode
	calls    map[string]int
	captures map[string]fakeSensorCapture
}

func connectFakeSnapshotSensor(t *testing.T, stack *snapshotIntegrationStack, browserID, username, password string, mode fakeSensorMode) (*fakeSnapshotSensor, models.Bot) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	dialCtx, dialCancel := context.WithTimeout(ctx, 3*time.Second)
	defer dialCancel()
	wsURL := strings.Replace(stack.wsHTTP.URL, "http://", "ws://", 1)
	conn, _, err := websocket.Dial(dialCtx, wsURL, nil)
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	_, raw, err := conn.Read(dialCtx)
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	var probe wsx.Envelope
	if err := json.Unmarshal(raw, &probe); err != nil {
		cancel()
		t.Fatal(err)
	}
	if probe.Action != wsx.ActionAuth {
		cancel()
		t.Fatalf("fake Sensor expected AUTH, got %s", probe.Action)
	}
	authPayload, _ := json.Marshal(wsx.AuthData{
		BrowserID: browserID, ProxyUsername: username, ProxyPassword: password, Version: "0.2.0",
		Capabilities: browsersnapshot.SensorCapabilities{
			BrowserSnapshotV1: true, SchemaVersions: []int{browsersnapshot.SchemaVersion}, ChunkSize: browsersnapshot.ChunkSizeBytes,
		},
	})
	authReply, _ := json.Marshal(wsx.Envelope{ID: probe.ID, Action: wsx.ActionAuth, OriginAction: wsx.ActionAuth, Data: authPayload})
	if err := conn.Write(dialCtx, websocket.MessageText, authReply); err != nil {
		cancel()
		t.Fatal(err)
	}

	sensor := &fakeSnapshotSensor{
		conn: conn, cancel: cancel, done: make(chan struct{}), mode: mode,
		calls: make(map[string]int), captures: make(map[string]fakeSensorCapture),
	}
	go sensor.run(ctx)
	t.Cleanup(sensor.close)

	deadline := time.Now().Add(3 * time.Second)
	var bot models.Bot
	for time.Now().Before(deadline) {
		if stack.db.Where("browser_id = ?", browserID).First(&bot).Error == nil && stack.wsServer.IsBotOnline(bot.ID) {
			return sensor, bot
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("fake Sensor %s did not enroll", browserID)
	return nil, models.Bot{}
}

func (s *fakeSnapshotSensor) setMode(mode fakeSensorMode) {
	s.mu.Lock()
	s.mode = mode
	s.mu.Unlock()
}

func (s *fakeSnapshotSensor) callCount(action string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.calls[action]
}

func (s *fakeSnapshotSensor) close() {
	s.cancel()
	_ = s.conn.Close(websocket.StatusNormalClosure, "test complete")
	select {
	case <-s.done:
	case <-time.After(time.Second):
	}
}

func (s *fakeSnapshotSensor) run(ctx context.Context) {
	defer close(s.done)
	for {
		_, raw, err := s.conn.Read(ctx)
		if err != nil {
			return
		}
		var request wsx.Envelope
		if json.Unmarshal(raw, &request) != nil {
			continue
		}
		s.mu.Lock()
		mode := s.mode
		if isBrowserSnapshotAction(request.Action) {
			s.calls[request.Action]++
		}
		s.mu.Unlock()
		if !isBrowserSnapshotAction(request.Action) || mode == fakeSensorTimeout {
			continue
		}
		var input map[string]any
		_ = json.Unmarshal(request.Data, &input)
		snapshotID, _ := input["snapshot_id"].(string)
		switch request.Action {
		case browsersnapshot.ActionBeginBrowserSnapshotV1:
			capture, err := buildFakeSensorCapture(snapshotID, fmt.Sprint(input["history_range"]))
			if err != nil {
				return
			}
			s.mu.Lock()
			s.captures[snapshotID] = capture
			s.mu.Unlock()
			s.respond(ctx, request, map[string]any{
				"status": "pending", "snapshot_id": snapshotID, "poll_after_ms": 1,
				"progress": map[string]any{"phase": "capture", "completed": 0, "total": len(browsersnapshot.Categories)},
			})
		case browsersnapshot.ActionGetBrowserSnapshotStatusV1:
			s.mu.Lock()
			capture := s.captures[snapshotID]
			s.mu.Unlock()
			digest := capture.digest
			if mode == fakeSensorBadManifest {
				digest = strings.Repeat("0", 64)
			}
			s.respond(ctx, request, map[string]any{
				"status": "ready", "snapshot_id": snapshotID,
				"manifest_base64": base64.StdEncoding.EncodeToString(capture.manifest), "manifest_sha256": digest,
			})
		case browsersnapshot.ActionGetBrowserSnapshotChunkV1:
			category := browsersnapshot.Category(fmt.Sprint(input["category"]))
			s.mu.Lock()
			capture := s.captures[snapshotID]
			s.mu.Unlock()
			payload := capture.fields[category]
			s.respond(ctx, request, map[string]any{
				"snapshot_id": snapshotID, "category": string(category), "chunk_index": 0, "chunk_count": 1,
				"byte_length": len(payload), "chunk_sha256": browsersnapshot.SHA256Hex(payload),
				"category_sha256": browsersnapshot.SHA256Hex(payload), "bytes_base64": base64.StdEncoding.EncodeToString(payload),
			})
		case browsersnapshot.ActionReleaseBrowserSnapshotV1:
			s.respond(ctx, request, map[string]any{"released": true})
		}
	}
}

func isBrowserSnapshotAction(action string) bool {
	switch action {
	case browsersnapshot.ActionBeginBrowserSnapshotV1,
		browsersnapshot.ActionGetBrowserSnapshotStatusV1,
		browsersnapshot.ActionGetBrowserSnapshotChunkV1,
		browsersnapshot.ActionReleaseBrowserSnapshotV1:
		return true
	default:
		return false
	}
}

func (s *fakeSnapshotSensor) respond(ctx context.Context, request wsx.Envelope, result map[string]any) {
	payload, _ := json.Marshal(result)
	response, _ := json.Marshal(wsx.Envelope{
		ID: request.ID, Action: request.Action, OriginAction: request.Action, Data: payload,
	})
	_ = s.conn.Write(ctx, websocket.MessageText, response)
}

func buildFakeSensorCapture(snapshotID, historyCoverage string) (fakeSensorCapture, error) {
	fields := make(map[browsersnapshot.Category][]byte, len(browsersnapshot.Categories))
	descriptors := make(map[browsersnapshot.Category]browsersnapshot.FieldDescriptor, len(browsersnapshot.Categories))
	for _, category := range browsersnapshot.Categories {
		payload := []byte(`[]`)
		fields[category] = payload
		descriptors[category] = browsersnapshot.FieldDescriptor{
			Available: true, Count: 0, ByteLength: int64(len(payload)),
			SHA256: browsersnapshot.SHA256Hex(payload), ChunkCount: 1,
		}
	}
	now := time.Now().UTC()
	manifest, err := browsersnapshot.CanonicalManifestBytes(browsersnapshot.CaptureManifest{
		SchemaVersion: browsersnapshot.SchemaVersion, SensorVersion: "0.2.0", SnapshotID: snapshotID,
		CaptureStartedAt: now.Format(time.RFC3339Nano), CaptureCompletedAt: now.Add(time.Millisecond).Format(time.RFC3339Nano),
		HistoryCoverage: historyCoverage, Fields: descriptors,
	})
	if err != nil {
		return fakeSensorCapture{}, err
	}
	return fakeSensorCapture{manifest: manifest, digest: browsersnapshot.SHA256Hex(manifest), fields: fields}, nil
}

type snapshotHTTPEnvelope struct {
	Success bool           `json:"success"`
	Result  map[string]any `json:"result"`
	Error   string         `json:"error"`
}

func postSnapshotJSON(t *testing.T, stack *snapshotIntegrationStack, path string, body map[string]any) (int, snapshotHTTPEnvelope) {
	t.Helper()
	payload, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	response, err := http.Post(stack.snapshotAPI.URL+path, "application/json", bytes.NewReader(payload))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var envelope snapshotHTTPEnvelope
	if err := json.NewDecoder(response.Body).Decode(&envelope); err != nil {
		t.Fatalf("decode %s response: %v", path, err)
	}
	return response.StatusCode, envelope
}

func startBrowserSnapshot(t *testing.T, stack *snapshotIntegrationStack, username, password string, preferLive bool) (int, snapshotHTTPEnvelope) {
	t.Helper()
	return postSnapshotJSON(t, stack, "/api/v1/get-bot-browser-snapshot", map[string]any{
		"username": username, "password": password, "history_range": "all", "prefer_live": preferLive,
	})
}

func waitBrowserSnapshotTerminal(t *testing.T, stack *snapshotIntegrationStack, username, password, jobID string) map[string]any {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		status, envelope := postSnapshotJSON(t, stack, "/api/v1/get-bot-browser-snapshot-status", map[string]any{
			"username": username, "password": password, "job_id": jobID,
		})
		if status != http.StatusOK || !envelope.Success {
			t.Fatalf("snapshot status HTTP=%d response=%+v", status, envelope)
		}
		if envelope.Result["status"] != "pending" {
			return envelope.Result
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("browser snapshot job did not reach a terminal state")
	return nil
}

func getSnapshotChunk(t *testing.T, stack *snapshotIntegrationStack, username, password, snapshotID string, category browsersnapshot.Category) (*http.Response, []byte) {
	t.Helper()
	payload, _ := json.Marshal(map[string]any{
		"username": username, "password": password, "snapshot_id": snapshotID,
		"category": string(category), "chunk_index": 0,
	})
	response, err := http.Post(stack.snapshotAPI.URL+"/api/v1/get-bot-browser-snapshot-chunk", "application/json", bytes.NewReader(payload))
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(response.Body)
	_ = response.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	return response, body
}

func waitBotOffline(t *testing.T, stack *snapshotIntegrationStack, botID uuid.UUID) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if !stack.wsServer.IsBotOnline(botID) {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("fake Sensor remained online after disconnect")
}

func createOfflineBot(t *testing.T, stack *snapshotIntegrationStack, name string) models.Bot {
	t.Helper()
	bot := models.Bot{
		BrowserID: uuid.NewString(), Name: name, ProxyUsername: name + "-user", ProxyPassword: name + "-password",
		IsOnline: false, LastOnline: time.Now(),
	}
	if err := stack.db.Create(&bot).Error; err != nil {
		t.Fatal(err)
	}
	return bot
}

func TestBrowserSnapshotEndToEndWebSocketFlow(t *testing.T) {
	stack := setupBrowserSnapshotStack(t)
	username, password := "snapshot-user", "snapshot-password"
	sensor, bot := connectFakeSnapshotSensor(t, stack, uuid.NewString(), username, password, fakeSensorNormal)

	status, started := startBrowserSnapshot(t, stack, username, password, true)
	if status != http.StatusOK || !started.Success || started.Result["status"] != "pending" {
		t.Fatalf("live start HTTP=%d response=%+v", status, started)
	}
	live := waitBrowserSnapshotTerminal(t, stack, username, password, started.Result["job_id"].(string))
	if live["status"] != "ready" || live["source"] != "live" || live["sensor_version"] != "0.2.0" {
		t.Fatalf("live result=%v", live)
	}
	snapshotID := live["snapshot_id"].(string)
	manifestDigest := live["manifest_sha256"].(string)
	for _, category := range browsersnapshot.Categories {
		response, payload := getSnapshotChunk(t, stack, username, password, snapshotID, category)
		if response.StatusCode != http.StatusOK || string(payload) != "[]" {
			t.Fatalf("%s chunk HTTP=%d payload=%q", category, response.StatusCode, payload)
		}
		if response.Header.Get("X-Snapshot-Id") != snapshotID || response.Header.Get("X-Manifest-SHA256") != manifestDigest {
			t.Fatalf("%s chunk headers do not bind the trusted manifest", category)
		}
	}
	for _, action := range []string{
		browsersnapshot.ActionBeginBrowserSnapshotV1, browsersnapshot.ActionGetBrowserSnapshotStatusV1,
		browsersnapshot.ActionGetBrowserSnapshotChunkV1, browsersnapshot.ActionReleaseBrowserSnapshotV1,
	} {
		if sensor.callCount(action) == 0 {
			t.Errorf("fake Sensor did not receive %s", action)
		}
	}

	sensor.close()
	waitBotOffline(t, stack, bot.ID)
	status, cachedResponse := startBrowserSnapshot(t, stack, username, password, true)
	if status != http.StatusOK || !cachedResponse.Success {
		t.Fatalf("offline cached start HTTP=%d response=%+v", status, cachedResponse)
	}
	cached := cachedResponse.Result
	if cached["status"] != "ready" || cached["source"] != "cached" || cached["snapshot_id"] != snapshotID || cached["manifest_sha256"] != manifestDigest {
		t.Fatalf("offline cached result=%v", cached)
	}

	timeoutSensor, reconnected := connectFakeSnapshotSensor(t, stack, bot.BrowserID, username, password, fakeSensorTimeout)
	if reconnected.ID != bot.ID {
		t.Fatalf("reconnect changed endpoint identity: %s != %s", reconnected.ID, bot.ID)
	}
	status, timeoutStart := startBrowserSnapshot(t, stack, username, password, true)
	if status != http.StatusOK || timeoutStart.Result["status"] != "pending" {
		t.Fatalf("timeout start HTTP=%d response=%+v", status, timeoutStart)
	}
	fallback := waitBrowserSnapshotTerminal(t, stack, username, password, timeoutStart.Result["job_id"].(string))
	if fallback["status"] != "ready" || fallback["source"] != "cached_fallback" ||
		fallback["fallback_reason"] != string(browsersnapshot.ErrorLiveSnapshotTimeout) ||
		fallback["snapshot_id"] != snapshotID || fallback["manifest_sha256"] != manifestDigest {
		t.Fatalf("timeout fallback result=%v", fallback)
	}
	if timeoutSensor.callCount(browsersnapshot.ActionBeginBrowserSnapshotV1) < 2 {
		t.Fatal("timeout path did not retry the live Sensor RPC")
	}

	status, invalid := startBrowserSnapshot(t, stack, username, "wrong-password", true)
	if status != http.StatusUnauthorized || invalid.Success {
		t.Fatalf("invalid credentials HTTP=%d response=%+v", status, invalid)
	}
	other := createOfflineBot(t, stack, "other-endpoint")
	status, crossStatus := postSnapshotJSON(t, stack, "/api/v1/get-bot-browser-snapshot-status", map[string]any{
		"username": other.ProxyUsername, "password": other.ProxyPassword, "job_id": started.Result["job_id"],
	})
	if status != http.StatusNotFound || crossStatus.Success {
		t.Fatalf("cross-endpoint status HTTP=%d response=%+v", status, crossStatus)
	}
	crossChunkResponse, _ := getSnapshotChunk(t, stack, other.ProxyUsername, other.ProxyPassword, snapshotID, browsersnapshot.CategoryCookies)
	if crossChunkResponse.StatusCode != http.StatusNotFound {
		t.Fatalf("cross-endpoint chunk HTTP=%d", crossChunkResponse.StatusCode)
	}

	legacy := createOfflineBot(t, stack, "legacy-endpoint")
	legacy.Cookies = models.JSONArray{map[string]any{"name": "legacy-cookie"}}
	if err := stack.db.Save(&legacy).Error; err != nil {
		t.Fatal(err)
	}
	status, legacyResponse := startBrowserSnapshot(t, stack, legacy.ProxyUsername, legacy.ProxyPassword, true)
	if status != http.StatusOK || legacyResponse.Result["status"] != "ready" || legacyResponse.Result["source"] != "legacy_cached" {
		t.Fatalf("legacy result HTTP=%d response=%+v", status, legacyResponse)
	}
	if _, ok := legacyResponse.Result["manifest_sha256"]; ok {
		t.Fatal("legacy Sync-only response must not claim a trusted manifest digest")
	}
	legacyReady, err := browsersnapshot.ResolveLegacy(legacy)
	if err != nil {
		t.Fatal(err)
	}
	if legacyReady.CloneEligible() {
		t.Fatal("legacy cached data must never be Clone-eligible")
	}

	badUsername, badPassword := "digest-user", "digest-password"
	_, badBot := connectFakeSnapshotSensor(t, stack, uuid.NewString(), badUsername, badPassword, fakeSensorBadManifest)
	status, badStart := startBrowserSnapshot(t, stack, badUsername, badPassword, true)
	if status != http.StatusOK || badStart.Result["status"] != "pending" {
		t.Fatalf("digest failure start HTTP=%d response=%+v", status, badStart)
	}
	failed := waitBrowserSnapshotTerminal(t, stack, badUsername, badPassword, badStart.Result["job_id"].(string))
	if failed["status"] != "failed" || failed["error_code"] != string(browsersnapshot.ErrorSnapshotDigestMismatch) {
		t.Fatalf("digest failure result=%v", failed)
	}
	var trustedRows int64
	if err := stack.db.Model(&models.BotBrowserSnapshot{}).Where("bot_id = ?", badBot.ID).Count(&trustedRows).Error; err != nil {
		t.Fatal(err)
	}
	if trustedRows != 0 {
		t.Fatalf("digest failure promoted %d trusted rows", trustedRows)
	}
}
