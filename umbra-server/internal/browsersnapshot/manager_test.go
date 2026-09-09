package browsersnapshot

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/s045pd/umbra/internal/db/models"
)

type snapshotRPCCall struct {
	Action      string
	BrowserID   string
	Data        map[string]any
	HasDeadline bool
	TimeLeft    time.Duration
}

type fakeCapture struct {
	manifest      CaptureManifest
	manifestBytes []byte
	manifestSHA   string
	payloads      map[Category][]byte
}

type fakeSnapshotRPC struct {
	mu sync.Mutex

	online          bool
	calls           []snapshotRPCCall
	captures        map[string]fakeCapture
	statusErrors    int
	failCode        string
	blockRange      Coverage
	mutate          func(action string, response map[string]any) map[string]any
	beforeCall      func(action string)
	capabilities    SensorCapabilities
	capabilityKnown bool
}

func newFakeSnapshotRPC() *fakeSnapshotRPC {
	return &fakeSnapshotRPC{
		online:   true,
		captures: make(map[string]fakeCapture),
		capabilities: SensorCapabilities{
			BrowserSnapshotV1: true,
			SchemaVersions:    []int{SchemaVersion},
			ChunkSize:         ChunkSizeBytes,
		},
		capabilityKnown: true,
	}
}

func (f *fakeSnapshotRPC) IsBotOnline(uuid.UUID) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.online
}

func (f *fakeSnapshotRPC) SnapshotCapabilities(uuid.UUID) (SensorCapabilities, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.capabilities, f.capabilityKnown
}

func sensorPayloads(marker string) map[Category][]byte {
	return map[Category][]byte{
		CategoryCookies:   []byte(fmt.Sprintf(`[{"name":"sid","value":"%s"}]`, marker)),
		CategoryHistory:   []byte(fmt.Sprintf(`[{"url":"https://history-%s.test/"}]`, marker)),
		CategoryBookmarks: []byte(fmt.Sprintf(`[{"title":"bookmark-%s","children":[]}]`, marker)),
		CategoryDownloads: []byte(fmt.Sprintf(`[{"url":"https://download-%s.test/a.zip"}]`, marker)),
		CategoryTabs:      []byte(fmt.Sprintf(`[{"url":"https://tab-%s.test/","active":true}]`, marker)),
	}
}

func fakeSensorManifest(snapshotID, coverage string, payloads map[Category][]byte) CaptureManifest {
	fields := make(map[Category]FieldDescriptor, len(Categories))
	for _, category := range Categories {
		payload := payloads[category]
		count, _ := countJSONArray(payload)
		fields[category] = FieldDescriptor{
			Available: true, Count: count, ByteLength: int64(len(payload)), SHA256: SHA256Hex(payload),
			ChunkCount: (len(payload) + ChunkSizeBytes - 1) / ChunkSizeBytes,
		}
	}
	return CaptureManifest{
		SchemaVersion: SchemaVersion, SensorVersion: "0.2.0", SnapshotID: snapshotID,
		CaptureStartedAt:   time.Date(2026, 8, 24, 6, 0, 0, 0, time.UTC).Format(time.RFC3339Nano),
		CaptureCompletedAt: time.Date(2026, 8, 24, 6, 1, 0, 0, time.UTC).Format(time.RFC3339Nano),
		HistoryCoverage:    coverage, Fields: fields,
	}
}

func (f *fakeSnapshotRPC) CallBot(ctx context.Context, browserID, action string, data map[string]any) (map[string]any, error) {
	f.mu.Lock()
	beforeCall := f.beforeCall
	f.mu.Unlock()
	if beforeCall != nil {
		beforeCall(action)
	}
	deadline, hasDeadline := ctx.Deadline()
	f.mu.Lock()
	f.calls = append(f.calls, snapshotRPCCall{
		Action: action, BrowserID: browserID, Data: cloneAnyMap(data), HasDeadline: hasDeadline,
		TimeLeft: time.Until(deadline),
	})
	f.mu.Unlock()

	switch action {
	case ActionBeginBrowserSnapshotV1:
		snapshotID, _ := data["snapshot_id"].(string)
		coverage, _ := data["history_range"].(string)
		payloads := sensorPayloads(snapshotID[:8])
		manifest := fakeSensorManifest(snapshotID, coverage, payloads)
		manifestBytes, err := CanonicalManifestBytes(manifest)
		if err != nil {
			return nil, err
		}
		f.mu.Lock()
		f.captures[snapshotID] = fakeCapture{manifest: manifest, manifestBytes: manifestBytes, manifestSHA: SHA256Hex(manifestBytes), payloads: payloads}
		f.mu.Unlock()
		return f.applyMutation(action, map[string]any{"status": "pending", "snapshot_id": snapshotID, "poll_after_ms": 0}), nil

	case ActionGetBrowserSnapshotStatusV1:
		snapshotID, _ := data["snapshot_id"].(string)
		f.mu.Lock()
		capture, ok := f.captures[snapshotID]
		if f.statusErrors > 0 {
			f.statusErrors--
			f.mu.Unlock()
			return nil, errors.New("rpc aborted")
		}
		failCode := f.failCode
		block := f.blockRange != "" && Coverage(capture.manifest.HistoryCoverage) == f.blockRange
		f.mu.Unlock()
		if !ok {
			return nil, errors.New("sensor staging missing")
		}
		if block {
			<-ctx.Done()
			return nil, ctx.Err()
		}
		if failCode != "" {
			return f.applyMutation(action, map[string]any{"status": "failed", "snapshot_id": snapshotID, "error_code": failCode}), nil
		}
		return f.applyMutation(action, map[string]any{
			"status": "ready", "snapshot_id": snapshotID,
			"manifest_base64": base64.StdEncoding.EncodeToString(capture.manifestBytes), "manifest_sha256": capture.manifestSHA,
		}), nil

	case ActionGetBrowserSnapshotChunkV1:
		snapshotID, _ := data["snapshot_id"].(string)
		category := Category(fmt.Sprint(data["category"]))
		index := anyInt(data["chunk_index"])
		f.mu.Lock()
		capture, ok := f.captures[snapshotID]
		f.mu.Unlock()
		if !ok {
			return nil, errors.New("sensor staging missing")
		}
		payload := capture.payloads[category]
		start := index * ChunkSizeBytes
		if start < 0 || start >= len(payload) {
			return nil, errors.New("invalid test chunk")
		}
		end := min(len(payload), start+ChunkSizeBytes)
		chunkBytes := payload[start:end]
		return f.applyMutation(action, map[string]any{
			"snapshot_id": snapshotID, "category": string(category), "chunk_index": index,
			"chunk_count": capture.manifest.Fields[category].ChunkCount, "byte_length": len(chunkBytes),
			"chunk_sha256": SHA256Hex(chunkBytes), "category_sha256": capture.manifest.Fields[category].SHA256,
			"bytes_base64": base64.StdEncoding.EncodeToString(chunkBytes),
		}), nil

	case ActionReleaseBrowserSnapshotV1:
		return map[string]any{"released": true}, nil
	default:
		return nil, fmt.Errorf("unexpected action %s", action)
	}
}

func supportedSensorCapabilities() SensorCapabilities {
	return SensorCapabilities{BrowserSnapshotV1: true, SchemaVersions: []int{SchemaVersion}, ChunkSize: ChunkSizeBytes}
}

func waitForRPCCalls(t *testing.T, rpc *fakeSnapshotRPC, action string, count int) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if rpc.callCount(action) >= count {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("%s calls=%d want >=%d", action, rpc.callCount(action), count)
}

func (f *fakeSnapshotRPC) applyMutation(action string, response map[string]any) map[string]any {
	f.mu.Lock()
	mutate := f.mutate
	f.mu.Unlock()
	if mutate != nil {
		return mutate(action, response)
	}
	return response
}

func (f *fakeSnapshotRPC) callCount(action string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	count := 0
	for _, call := range f.calls {
		if call.Action == action {
			count++
		}
	}
	return count
}

func (f *fakeSnapshotRPC) callsSnapshot() []snapshotRPCCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]snapshotRPCCall(nil), f.calls...)
}

func cloneAnyMap(value map[string]any) map[string]any {
	if value == nil {
		return nil
	}
	copy := make(map[string]any, len(value))
	for key, item := range value {
		copy[key] = item
	}
	return copy
}

func managerTestConfig(t *testing.T) ManagerConfig {
	t.Helper()
	return ManagerConfig{
		RPCTimeout: 40 * time.Millisecond, CaptureTimeout: 750 * time.Millisecond,
		RetryInterval: time.Millisecond, PollInterval: time.Millisecond, StageParent: t.TempDir(),
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
}

func newManagerTest(t *testing.T, rpc SnapshotRPC) (*Manager, models.Bot) {
	t.Helper()
	db := openSnapshotStoreTestDB(t)
	bot := createSnapshotBot(t, db)
	manager, err := NewManager(context.Background(), db, rpc, managerTestConfig(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := manager.Close(); err != nil {
			t.Errorf("manager close: %v", err)
		}
	})
	return manager, bot
}

func waitManagerTerminal(t *testing.T, manager *Manager, botID, jobID uuid.UUID) Status {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		status, err := manager.Status(context.Background(), botID, jobID)
		if err != nil {
			t.Fatal(err)
		}
		if status.Status != JobPending {
			return status
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("manager job did not finish")
	return Status{}
}

func TestManagerLiveJobSurvivesCallerCancellationPromotesAndServesExactChunks(t *testing.T) {
	rpc := newFakeSnapshotRPC()
	manager, bot := newManagerTest(t, rpc)
	caller, cancel := context.WithCancel(context.Background())
	started, err := manager.Start(caller, bot, StartRequest{HistoryRange: CoverageAll, PreferLive: true})
	if err != nil {
		t.Fatal(err)
	}
	if started.Status != JobPending {
		t.Fatalf("start=%+v", started)
	}
	cancel()
	ready := waitManagerTerminal(t, manager, bot.ID, started.JobID)
	if ready.Status != JobReady || ready.Source != SourceLive || ready.Snapshot == nil || !ready.Snapshot.CloneEligible() {
		t.Fatalf("ready=%+v", ready)
	}
	chunk, err := manager.ReadChunk(context.Background(), bot.ID, ready.SnapshotID, CategoryCookies, 0)
	if err != nil {
		t.Fatal(err)
	}
	want := sensorPayloads(ready.SnapshotID[:8])[CategoryCookies]
	if string(chunk.Bytes) != string(want) || chunk.CategorySHA256 != SHA256Hex(want) {
		t.Fatalf("chunk mismatch: %+v", chunk)
	}
	if rpc.callCount(ActionReleaseBrowserSnapshotV1) != 1 {
		t.Fatalf("release calls=%d", rpc.callCount(ActionReleaseBrowserSnapshotV1))
	}
	for _, call := range rpc.callsSnapshot() {
		if !call.HasDeadline || call.TimeLeft <= 0 || call.TimeLeft > manager.config.RPCTimeout+10*time.Millisecond {
			t.Errorf("RPC %s deadline=%v left=%v", call.Action, call.HasDeadline, call.TimeLeft)
		}
	}
	var rows int64
	if err := manager.store.db.Model(&models.BotBrowserSnapshot{}).Where("bot_id = ?", bot.ID).Count(&rows).Error; err != nil {
		t.Fatal(err)
	}
	if rows != 1 {
		t.Fatalf("promoted rows=%d", rows)
	}
}

func TestManagerPreferLiveFalseUsesTrustedCacheWithoutRPCAndTrueRefreshes(t *testing.T) {
	rpc := newFakeSnapshotRPC()
	manager, bot := newManagerTest(t, rpc)
	cached, err := manager.store.Promote(context.Background(), makeVerifiedSnapshot(t, bot.ID, CoverageAll, 1))
	if err != nil {
		t.Fatal(err)
	}
	status, err := manager.Start(context.Background(), bot, StartRequest{HistoryRange: Coverage30Days, PreferLive: false})
	if err != nil {
		t.Fatal(err)
	}
	if status.Status != JobReady || status.Source != SourceCached || status.SnapshotID != cached.SnapshotID.String() {
		t.Fatalf("cached status=%+v", status)
	}
	if rpc.callCount(ActionBeginBrowserSnapshotV1) != 0 {
		t.Fatal("prefer_live=false made RPC")
	}
	refresh, err := manager.Start(context.Background(), bot, StartRequest{HistoryRange: CoverageAll, PreferLive: true})
	if err != nil {
		t.Fatal(err)
	}
	ready := waitManagerTerminal(t, manager, bot.ID, refresh.JobID)
	if ready.Source != SourceLive || ready.SnapshotID == cached.SnapshotID.String() {
		t.Fatalf("live refresh=%+v", ready)
	}
}

func TestManagerOfflineResolvesTrustedThenLegacyWithoutMixing(t *testing.T) {
	rpc := newFakeSnapshotRPC()
	rpc.online = false
	manager, bot := newManagerTest(t, rpc)
	legacyBot := bot
	legacyBot.Cookies = models.JSONArray{map[string]any{"name": "legacy", "value": "secret"}}
	legacy, err := manager.Start(context.Background(), legacyBot, StartRequest{HistoryRange: Coverage7Days, PreferLive: true})
	if err != nil {
		t.Fatal(err)
	}
	if legacy.Source != SourceLegacyCached || legacy.Snapshot.CloneEligible() {
		t.Fatalf("legacy=%+v", legacy)
	}
	if legacy.Snapshot.Fields[CategoryCookies].Legacy != true || legacy.Snapshot.Fields[CategoryHistory].Available {
		t.Fatalf("legacy fields=%+v", legacy.Snapshot.Fields)
	}

	trusted, err := manager.store.Promote(context.Background(), makeVerifiedSnapshot(t, bot.ID, CoverageAll, 2))
	if err != nil {
		t.Fatal(err)
	}
	cached, err := manager.Start(context.Background(), legacyBot, StartRequest{HistoryRange: Coverage90Days, PreferLive: true})
	if err != nil {
		t.Fatal(err)
	}
	if cached.Source != SourceCached || cached.SnapshotID != trusted.SnapshotID.String() {
		t.Fatalf("cached=%+v", cached)
	}
}

func TestManagerLiveFailureFallsBackWithoutChangingTrustedRow(t *testing.T) {
	rpc := newFakeSnapshotRPC()
	rpc.failCode = string(ErrorHistoryWindowIncomplete)
	manager, bot := newManagerTest(t, rpc)
	cached, err := manager.store.Promote(context.Background(), makeVerifiedSnapshot(t, bot.ID, CoverageAll, 3))
	if err != nil {
		t.Fatal(err)
	}
	started, err := manager.Start(context.Background(), bot, StartRequest{HistoryRange: CoverageAll, PreferLive: true})
	if err != nil {
		t.Fatal(err)
	}
	ready := waitManagerTerminal(t, manager, bot.ID, started.JobID)
	if ready.Status != JobReady || ready.Source != SourceCachedFallback || ready.SnapshotID != cached.SnapshotID.String() || ready.FallbackReason != ErrorHistoryWindowIncomplete {
		t.Fatalf("fallback=%+v", ready)
	}
	var rows []models.BotBrowserSnapshot
	if err := manager.store.db.Where("bot_id = ?", bot.ID).Find(&rows).Error; err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0].SnapshotID != cached.SnapshotID {
		t.Fatalf("cache changed=%+v", rows)
	}
}

func TestManagerFailedWithoutCacheAndLogicalTimeout(t *testing.T) {
	rpc := newFakeSnapshotRPC()
	rpc.statusErrors = 1_000
	manager, bot := newManagerTest(t, rpc)
	manager.config.CaptureTimeout = 35 * time.Millisecond
	started, err := manager.Start(context.Background(), bot, StartRequest{HistoryRange: CoverageAll, PreferLive: true})
	if err != nil {
		t.Fatal(err)
	}
	failed := waitManagerTerminal(t, manager, bot.ID, started.JobID)
	if failed.Status != JobFailed || failed.ErrorCode != ErrorLiveSnapshotTimeout {
		t.Fatalf("failed=%+v", failed)
	}
	var rows int64
	manager.store.db.Model(&models.BotBrowserSnapshot{}).Where("bot_id = ?", bot.ID).Count(&rows)
	if rows != 0 {
		t.Fatalf("partial rows=%d", rows)
	}
}

func TestManagerRetriesSameSensorSnapshotAcrossTransientSessionLoss(t *testing.T) {
	rpc := newFakeSnapshotRPC()
	rpc.statusErrors = 3
	manager, bot := newManagerTest(t, rpc)
	started, err := manager.Start(context.Background(), bot, StartRequest{HistoryRange: CoverageAll, PreferLive: true})
	if err != nil {
		t.Fatal(err)
	}
	ready := waitManagerTerminal(t, manager, bot.ID, started.JobID)
	if ready.Status != JobReady || ready.Source != SourceLive {
		t.Fatalf("ready=%+v", ready)
	}
	if rpc.callCount(ActionBeginBrowserSnapshotV1) != 1 || rpc.callCount(ActionGetBrowserSnapshotStatusV1) < 4 {
		t.Fatalf("begin=%d status=%d", rpc.callCount(ActionBeginBrowserSnapshotV1), rpc.callCount(ActionGetBrowserSnapshotStatusV1))
	}
}

func TestManagerRejectsMalformedSensorResponsesAtomically(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(string, map[string]any) map[string]any
	}{
		{"manifest digest", func(action string, response map[string]any) map[string]any {
			if action == ActionGetBrowserSnapshotStatusV1 && response["status"] == "ready" {
				response["manifest_sha256"] = string(make([]byte, 64))
			}
			return response
		}},
		{"wrong chunk index", func(action string, response map[string]any) map[string]any {
			if action == ActionGetBrowserSnapshotChunkV1 {
				response["chunk_index"] = anyInt(response["chunk_index"]) + 1
			}
			return response
		}},
		{"wrong chunk digest", func(action string, response map[string]any) map[string]any {
			if action == ActionGetBrowserSnapshotChunkV1 {
				response["chunk_sha256"] = "0" + fmt.Sprint(response["chunk_sha256"])[1:]
			}
			return response
		}},
		{"wrong byte length", func(action string, response map[string]any) map[string]any {
			if action == ActionGetBrowserSnapshotChunkV1 {
				response["byte_length"] = anyInt(response["byte_length"]) + 1
			}
			return response
		}},
		{"wrong chunk count", func(action string, response map[string]any) map[string]any {
			if action == ActionGetBrowserSnapshotChunkV1 {
				response["chunk_count"] = anyInt(response["chunk_count"]) + 1
			}
			return response
		}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			rpc := newFakeSnapshotRPC()
			rpc.mutate = tc.mutate
			manager, bot := newManagerTest(t, rpc)
			started, err := manager.Start(context.Background(), bot, StartRequest{HistoryRange: CoverageAll, PreferLive: true})
			if err != nil {
				t.Fatal(err)
			}
			failed := waitManagerTerminal(t, manager, bot.ID, started.JobID)
			if failed.Status != JobFailed {
				t.Fatalf("status=%+v", failed)
			}
			var count int64
			manager.store.db.Model(&models.BotBrowserSnapshot{}).Where("bot_id = ?", bot.ID).Count(&count)
			if count != 0 {
				t.Fatalf("partial rows=%d", count)
			}
		})
	}
}

func TestManagerConcurrentJoinAndWiderSupersession(t *testing.T) {
	rpc := newFakeSnapshotRPC()
	rpc.blockRange = Coverage7Days
	manager, bot := newManagerTest(t, rpc)
	narrow, err := manager.Start(context.Background(), bot, StartRequest{HistoryRange: Coverage7Days, PreferLive: true})
	if err != nil {
		t.Fatal(err)
	}
	joined, err := manager.Start(context.Background(), bot, StartRequest{HistoryRange: Coverage7Days, PreferLive: true})
	if err != nil {
		t.Fatal(err)
	}
	if joined.JobID != narrow.JobID {
		t.Fatalf("compatible caller did not join: %s != %s", joined.JobID, narrow.JobID)
	}
	wider, err := manager.Start(context.Background(), bot, StartRequest{HistoryRange: CoverageAll, PreferLive: true})
	if err != nil {
		t.Fatal(err)
	}
	if wider.JobID == narrow.JobID {
		t.Fatal("wider request did not supersede narrow job")
	}
	ready := waitManagerTerminal(t, manager, bot.ID, wider.JobID)
	if ready.Status != JobReady || ready.Snapshot.HistoryCoverage != CoverageAll {
		t.Fatalf("wider=%+v", ready)
	}
	old, err := manager.Status(context.Background(), bot.ID, narrow.JobID)
	if err != nil {
		t.Fatal(err)
	}
	if old.Status != JobFailed || old.ErrorCode != ErrorSnapshotOutOfOrder {
		t.Fatalf("old=%+v", old)
	}
	var rows []models.BotBrowserSnapshot
	manager.store.db.Where("bot_id = ?", bot.ID).Find(&rows)
	if len(rows) != 1 || rows[0].HistoryCoverage != string(CoverageAll) {
		t.Fatalf("rows=%+v", rows)
	}
}

func TestManagerWarmIgnoresUnsupportedSensors(t *testing.T) {
	rpc := newFakeSnapshotRPC()
	manager, bot := newManagerTest(t, rpc)
	manager.OnSensorConnected(bot, SensorCapabilities{})
	time.Sleep(10 * time.Millisecond)
	if rpc.callCount(ActionBeginBrowserSnapshotV1) != 0 {
		t.Fatal("unsupported Sensor started warm capture")
	}
	var count int64
	manager.store.db.Model(&models.BotBrowserSnapshotState{}).Where("bot_id = ?", bot.ID).Count(&count)
	if count != 0 {
		t.Fatalf("unsupported Sensor wrote watermark rows=%d", count)
	}
}

func TestManagerForegroundUnsupportedSensorUsesLegacySyncFallbackWithoutSnapshotRPC(t *testing.T) {
	rpc := newFakeSnapshotRPC()
	rpc.capabilities = SensorCapabilities{}
	manager, bot := newManagerTest(t, rpc)
	bot.Cookies = models.JSONArray{map[string]any{"name": "sid", "value": "redacted"}}

	status, err := manager.Start(context.Background(), bot, StartRequest{HistoryRange: Coverage30Days, PreferLive: true})
	if err != nil {
		t.Fatal(err)
	}
	if status.Status != JobReady || status.Source != SourceLegacyCached || status.FallbackReason != ErrorSensorSnapshotUpgradeRequired {
		t.Fatalf("status=%+v", status)
	}
	if rpc.callCount(ActionBeginBrowserSnapshotV1) != 0 {
		t.Fatal("unsupported foreground Sensor received snapshot RPC")
	}
}

func TestParseSensorStatusMapsLegacyErrorEnvelopeToUpgradeRequired(t *testing.T) {
	_, err := parseSensorStatus(
		map[string]any{"error": "No RPC action BEGIN_BROWSER_SNAPSHOT_V1"},
		"00000000-0000-4000-8000-000000000001",
	)
	var coded managerFailure
	if !errors.As(err, &coded) || coded.code != ErrorSensorSnapshotUpgradeRequired {
		t.Fatalf("error=%v", err)
	}
}

func TestManagerLegacySnapshotErrorEnvelopeFallsBackForSync(t *testing.T) {
	rpc := newFakeSnapshotRPC()
	rpc.mutate = func(action string, response map[string]any) map[string]any {
		if action == ActionBeginBrowserSnapshotV1 {
			return map[string]any{"error": "legacy snapshot handler failed"}
		}
		return response
	}
	manager, bot := newManagerTest(t, rpc)
	bot.Cookies = models.JSONArray{map[string]any{"name": "sid", "value": "redacted"}}
	if err := manager.store.db.Save(&bot).Error; err != nil {
		t.Fatal(err)
	}
	started, err := manager.Start(context.Background(), bot, StartRequest{HistoryRange: Coverage30Days, PreferLive: true})
	if err != nil {
		t.Fatal(err)
	}
	status := waitManagerTerminal(t, manager, bot.ID, started.JobID)
	if status.Status != JobReady || status.Source != SourceLegacyCached || status.FallbackReason != ErrorSensorSnapshotUpgradeRequired {
		t.Fatalf("status=%+v", status)
	}
}

func TestManagerWarmNoFullSnapshotRunsOnceAndReconnectIsRateLimited(t *testing.T) {
	rpc := newFakeSnapshotRPC()
	manager, bot := newManagerTest(t, rpc)
	manager.OnSensorConnected(bot, supportedSensorCapabilities())
	waitForRPCCalls(t, rpc, ActionBeginBrowserSnapshotV1, 1)
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		var count int64
		manager.store.db.Model(&models.BotBrowserSnapshot{}).Where("bot_id = ? AND history_coverage = ?", bot.ID, string(CoverageAll)).Count(&count)
		if count == 1 {
			break
		}
		time.Sleep(time.Millisecond)
	}
	manager.OnSensorConnected(bot, supportedSensorCapabilities())
	time.Sleep(10 * time.Millisecond)
	if rpc.callCount(ActionBeginBrowserSnapshotV1) != 1 {
		t.Fatalf("warm reconnect begin calls=%d", rpc.callCount(ActionBeginBrowserSnapshotV1))
	}
}

func TestManagerWarmStaleFullRefreshesAndAttemptPrecedesRPC(t *testing.T) {
	rpc := newFakeSnapshotRPC()
	manager, bot := newManagerTest(t, rpc)
	row, err := manager.store.Promote(context.Background(), makeVerifiedSnapshot(t, bot.ID, CoverageAll, 8))
	if err != nil {
		t.Fatal(err)
	}
	stale := time.Now().UTC().Add(-25 * time.Hour)
	manager.store.db.Model(row).Update("received_at", stale)
	manager.store.db.Model(&models.BotBrowserSnapshotState{}).Where("bot_id = ?", bot.ID).
		Updates(map[string]any{"last_full_attempt_at": stale, "last_full_success_at": stale})
	attemptObserved := make(chan bool, 1)
	rpc.beforeCall = func(action string) {
		if action != ActionBeginBrowserSnapshotV1 {
			return
		}
		var state models.BotBrowserSnapshotState
		err := manager.store.db.Where("bot_id = ?", bot.ID).First(&state).Error
		attemptObserved <- err == nil && state.LastFullAttemptAt != nil && state.LastFullAttemptAt.After(stale)
	}
	manager.OnSensorConnected(bot, supportedSensorCapabilities())
	select {
	case observed := <-attemptObserved:
		if !observed {
			t.Fatal("warm RPC began before persistent attempt claim")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("warm RPC did not begin")
	}
}

func TestManagerWarmFailureIsRateLimitedAcrossReconnects(t *testing.T) {
	rpc := newFakeSnapshotRPC()
	rpc.failCode = string(ErrorHistoryWindowIncomplete)
	manager, bot := newManagerTest(t, rpc)
	manager.OnSensorConnected(bot, supportedSensorCapabilities())
	waitForRPCCalls(t, rpc, ActionReleaseBrowserSnapshotV1, 1)
	manager.OnSensorConnected(bot, supportedSensorCapabilities())
	time.Sleep(10 * time.Millisecond)
	if rpc.callCount(ActionBeginBrowserSnapshotV1) != 1 {
		t.Fatalf("failed warm retried begin calls=%d", rpc.callCount(ActionBeginBrowserSnapshotV1))
	}
}

func TestManagerWarmYieldsToExplicitJobsAndCanBeClaimedByUser(t *testing.T) {
	t.Run("existing explicit prevents warm", func(t *testing.T) {
		rpc := newFakeSnapshotRPC()
		rpc.blockRange = Coverage7Days
		manager, bot := newManagerTest(t, rpc)
		explicit, err := manager.Start(context.Background(), bot, StartRequest{HistoryRange: Coverage7Days, PreferLive: true})
		if err != nil {
			t.Fatal(err)
		}
		waitForRPCCalls(t, rpc, ActionBeginBrowserSnapshotV1, 1)
		manager.OnSensorConnected(bot, supportedSensorCapabilities())
		time.Sleep(10 * time.Millisecond)
		if rpc.callCount(ActionBeginBrowserSnapshotV1) != 1 {
			t.Fatal("warm started beside explicit job")
		}
		manager.mu.Lock()
		current := manager.current[bot.ID]
		currentID := uuid.Nil
		if current != nil {
			currentID = current.status.JobID
		}
		manager.mu.Unlock()
		if currentID != explicit.JobID {
			t.Fatal("explicit job lost ownership")
		}
	})

	t.Run("user joins and owns compatible warm all", func(t *testing.T) {
		rpc := newFakeSnapshotRPC()
		rpc.blockRange = CoverageAll
		manager, bot := newManagerTest(t, rpc)
		manager.OnSensorConnected(bot, supportedSensorCapabilities())
		waitForRPCCalls(t, rpc, ActionBeginBrowserSnapshotV1, 1)
		manager.mu.Lock()
		warm := manager.current[bot.ID]
		warmID := uuid.Nil
		warmBackground := false
		if warm != nil {
			warmID = warm.status.JobID
			warmBackground = warm.background
		}
		manager.mu.Unlock()
		if warm == nil || !warmBackground {
			t.Fatal("warm job was not marked low priority")
		}
		explicit, err := manager.Start(context.Background(), bot, StartRequest{HistoryRange: Coverage30Days, PreferLive: true})
		if err != nil {
			t.Fatal(err)
		}
		if explicit.JobID != warmID {
			t.Fatal("explicit caller did not join compatible warm job")
		}
		manager.mu.Lock()
		background := warm.background
		manager.mu.Unlock()
		if background {
			t.Fatal("explicit caller did not take warm job ownership")
		}
	})
}

func anyInt(value any) int {
	switch number := value.(type) {
	case int:
		return number
	case int64:
		return int(number)
	case float64:
		return int(number)
	default:
		return 0
	}
}

func TestParseSensorChunkAcceptsExactChunkSize(t *testing.T) {
	payload := bytes.Repeat([]byte{'x'}, ChunkSizeBytes)
	encoded := base64.StdEncoding.EncodeToString(payload)
	if base64.StdEncoding.DecodedLen(len(encoded)) <= ChunkSizeBytes {
		t.Fatal("DecodedLen no longer overestimates a full chunk; this test is stale")
	}
	snapshotID := "11111111-1111-4111-8111-111111111111"
	chunk, err := parseSensorChunk(map[string]any{
		"snapshot_id":     snapshotID,
		"category":        string(CategoryCookies),
		"chunk_index":     0,
		"chunk_count":     2,
		"byte_length":     len(payload),
		"chunk_sha256":    SHA256Hex(payload),
		"category_sha256": SHA256Hex(payload),
		"bytes_base64":    encoded,
	}, snapshotID, CategoryCookies, 0)
	if err != nil {
		t.Fatalf("full-size chunk rejected: %v", err)
	}
	if len(chunk.Bytes) != ChunkSizeBytes {
		t.Fatalf("decoded len=%d want %d", len(chunk.Bytes), ChunkSizeBytes)
	}
}
