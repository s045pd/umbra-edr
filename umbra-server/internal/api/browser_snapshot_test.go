package api

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	"github.com/s045pd/umbra/internal/browsersnapshot"
	"github.com/s045pd/umbra/internal/db/models"
)

type fakeBrowserSnapshotService struct {
	startStatus browsersnapshot.Status
	statusValue browsersnapshot.Status
	chunkValue  browsersnapshot.Chunk
	err         error
	startCalls  int
	statusBot   uuid.UUID
	chunkBot    uuid.UUID
}

func (f *fakeBrowserSnapshotService) Start(_ context.Context, _ models.Bot, _ browsersnapshot.StartRequest) (browsersnapshot.Status, error) {
	f.startCalls++
	return f.startStatus, f.err
}

func (f *fakeBrowserSnapshotService) Status(_ context.Context, botID, _ uuid.UUID) (browsersnapshot.Status, error) {
	f.statusBot = botID
	return f.statusValue, f.err
}

func (f *fakeBrowserSnapshotService) ReadChunk(_ context.Context, botID uuid.UUID, _ string, _ browsersnapshot.Category, _ int) (browsersnapshot.Chunk, error) {
	f.chunkBot = botID
	return f.chunkValue, f.err
}

func browserSnapshotAPITestDB(t *testing.T) (*gorm.DB, models.Bot, models.Bot) {
	t.Helper()
	dsn := fmt.Sprintf("file:%s?mode=memory&cache=shared", uuid.NewString())
	db, err := gorm.Open(sqlite.Open(dsn), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&models.Bot{}, &models.BotBrowserSnapshot{}, &models.BotBrowserSnapshotState{}); err != nil {
		t.Fatal(err)
	}
	makeBot := func(name string) models.Bot {
		bot := models.Bot{
			BrowserID: uuid.NewString(), Name: name, ProxyUsername: name + "-user",
			ProxyPassword: name + "-password", LastOnline: time.Now(),
		}
		if err := db.Create(&bot).Error; err != nil {
			t.Fatal(err)
		}
		return bot
	}
	return db, makeBot("one"), makeBot("two")
}

func jsonRequest(t *testing.T, path string, value any) *http.Request {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(raw))
	request.Header.Set("Content-Type", "application/json")
	return request
}

func decodeAPIEnvelope(t *testing.T, recorder *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var value map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &value); err != nil {
		t.Fatalf("decode response: %v; body=%s", err, recorder.Body.String())
	}
	return value
}

func readySnapshotForAPI(source browsersnapshot.SnapshotSource, legacy bool) *browsersnapshot.ReadySnapshot {
	fields := make(map[browsersnapshot.Category]browsersnapshot.ReadyField, len(browsersnapshot.Categories))
	for _, category := range browsersnapshot.Categories {
		payload := []byte(`[]`)
		fields[category] = browsersnapshot.ReadyField{
			FieldDescriptor: browsersnapshot.FieldDescriptor{
				Available: true, Count: 0, ByteLength: int64(len(payload)),
				SHA256: browsersnapshot.SHA256Hex(payload), ChunkCount: 1,
			},
			Legacy: legacy, Bytes: payload,
		}
	}
	result := &browsersnapshot.ReadySnapshot{
		SnapshotID: uuid.NewString(), SchemaVersion: 1, SensorVersion: "0.2.0", Source: source,
		CaptureStartedAt: "2026-08-24T06:00:00Z", CaptureCompletedAt: "2026-08-24T06:01:00Z",
		HistoryCoverage: browsersnapshot.CoverageAll, Fields: fields,
		ManifestSHA256: strings.Repeat("a", 64), ManifestBytes: []byte(`{"trusted":true}`),
	}
	if legacy {
		result.SchemaVersion = 0
		result.SensorVersion = ""
		result.CaptureStartedAt = ""
		result.CaptureCompletedAt = ""
		result.ManifestSHA256 = ""
		result.ManifestBytes = nil
	}
	return result
}

func TestBrowserSnapshotRoutesReturnServiceUnavailableInSmokeMode(t *testing.T) {
	api := &BrowserSnapshotAPI{}
	tests := []struct {
		name   string
		body   map[string]any
		handle func(http.ResponseWriter, *http.Request)
	}{
		{
			name:   "start",
			body:   map[string]any{"username": "u", "password": "p", "history_range": "all"},
			handle: api.Start,
		},
		{
			name:   "status",
			body:   map[string]any{"username": "u", "password": "p", "job_id": uuid.NewString()},
			handle: api.Status,
		},
		{
			name: "chunk",
			body: map[string]any{
				"username": "u", "password": "p", "snapshot_id": uuid.NewString(),
				"category": "cookies", "chunk_index": 0,
			},
			handle: api.Chunk,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			test.handle(recorder, jsonRequest(t, "/api/v1/browser-snapshot", test.body))
			if recorder.Code != http.StatusServiceUnavailable {
				t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
			}
		})
	}
}

func TestBrowserSnapshotStartValidatesCredentialsRangeAndReturnsPending(t *testing.T) {
	db, bot, _ := browserSnapshotAPITestDB(t)
	jobID := uuid.New()
	service := &fakeBrowserSnapshotService{startStatus: browsersnapshot.Status{
		Status: browsersnapshot.JobPending, JobID: jobID, PollAfterMS: 1000,
		Progress: browsersnapshot.Progress{Phase: "history", Completed: 2, Total: 5},
	}}
	api := &BrowserSnapshotAPI{DB: db, Service: service}

	recorder := httptest.NewRecorder()
	api.Start(recorder, jsonRequest(t, "/api/v1/get-bot-browser-snapshot", map[string]any{
		"username": bot.ProxyUsername, "password": bot.ProxyPassword,
		"history_range": "all", "prefer_live": true,
	}))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	result := decodeAPIEnvelope(t, recorder)["result"].(map[string]any)
	if result["status"] != "pending" || result["job_id"] != jobID.String() || service.startCalls != 1 {
		t.Fatalf("result=%v calls=%d", result, service.startCalls)
	}

	for _, tc := range []struct {
		name string
		body map[string]any
		code int
	}{
		{"bad credentials", map[string]any{"username": bot.ProxyUsername, "password": "SENTINEL_BAD_PASSWORD", "history_range": "all"}, http.StatusUnauthorized},
		{"bad range", map[string]any{"username": bot.ProxyUsername, "password": bot.ProxyPassword, "history_range": "365"}, http.StatusBadRequest},
	} {
		t.Run(tc.name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			api.Start(recorder, jsonRequest(t, "/api/v1/get-bot-browser-snapshot", tc.body))
			if recorder.Code != tc.code {
				t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
			}
			if strings.Contains(recorder.Body.String(), "SENTINEL_BAD_PASSWORD") || strings.Contains(recorder.Body.String(), bot.ProxyUsername) {
				t.Fatal("credential leaked in error")
			}
		})
	}
}

func TestBrowserSnapshotStatusIsManifestOnlyForTrustedAndLegacySources(t *testing.T) {
	db, bot, _ := browserSnapshotAPITestDB(t)
	jobID := uuid.New()
	for _, tc := range []struct {
		name   string
		source browsersnapshot.SnapshotSource
		legacy bool
	}{
		{"trusted", browsersnapshot.SourceCached, false},
		{"legacy", browsersnapshot.SourceLegacyCached, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			snapshot := readySnapshotForAPI(tc.source, tc.legacy)
			service := &fakeBrowserSnapshotService{statusValue: browsersnapshot.Status{
				Status: browsersnapshot.JobReady, JobID: jobID, SnapshotID: snapshot.SnapshotID,
				Source: tc.source, Snapshot: snapshot,
			}}
			api := &BrowserSnapshotAPI{DB: db, Service: service}
			recorder := httptest.NewRecorder()
			api.Status(recorder, jsonRequest(t, "/api/v1/get-bot-browser-snapshot-status", map[string]any{
				"username": bot.ProxyUsername, "password": bot.ProxyPassword, "job_id": jobID,
			}))
			if recorder.Code != http.StatusOK {
				t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
			}
			body := recorder.Body.String()
			for _, forbidden := range []string{"manifest_base64", `"bytes"`, "category_bytes", "SENTINEL_COOKIE_VALUE"} {
				if strings.Contains(body, forbidden) {
					t.Errorf("response leaked %q: %s", forbidden, body)
				}
			}
			result := decodeAPIEnvelope(t, recorder)["result"].(map[string]any)
			fields := result["fields"].(map[string]any)
			cookies := fields["cookies"].(map[string]any)
			if cookies["legacy"] != tc.legacy {
				t.Fatalf("legacy=%v result=%v", cookies["legacy"], result)
			}
			if tc.legacy {
				if _, ok := result["manifest_sha256"]; ok {
					t.Fatal("legacy response invented manifest digest")
				}
				if _, ok := result["capture_completed_at"]; ok {
					t.Fatal("legacy response invented capture time")
				}
			} else {
				if result["manifest_sha256"] != snapshot.ManifestSHA256 {
					t.Fatalf("manifest digest=%v", result["manifest_sha256"])
				}
				if result["sensor_version"] != snapshot.SensorVersion {
					t.Fatalf("sensor version=%v", result["sensor_version"])
				}
			}
		})
	}
}

func TestBrowserSnapshotStatusAndChunkAreCredentialScoped(t *testing.T) {
	db, bot, other := browserSnapshotAPITestDB(t)
	jobID := uuid.New()
	snapshot := readySnapshotForAPI(browsersnapshot.SourceCached, false)
	payload := []byte(`[{"name":"sid","value":"SENTINEL_COOKIE_VALUE"}]`)
	service := &fakeBrowserSnapshotService{
		statusValue: browsersnapshot.Status{Status: browsersnapshot.JobReady, JobID: jobID, SnapshotID: snapshot.SnapshotID, Source: snapshot.Source, Snapshot: snapshot},
		chunkValue: browsersnapshot.Chunk{
			SnapshotID: snapshot.SnapshotID, Category: browsersnapshot.CategoryCookies, ChunkIndex: 0, ChunkCount: 1,
			ByteLength: len(payload), ChunkSHA256: browsersnapshot.SHA256Hex(payload),
			CategorySHA256: browsersnapshot.SHA256Hex(payload), ManifestSHA256: snapshot.ManifestSHA256, Bytes: payload,
		},
	}
	api := &BrowserSnapshotAPI{DB: db, Service: service}

	recorder := httptest.NewRecorder()
	api.Status(recorder, jsonRequest(t, "/api/v1/get-bot-browser-snapshot-status", map[string]any{
		"username": other.ProxyUsername, "password": other.ProxyPassword, "job_id": jobID,
	}))
	if service.statusBot != other.ID {
		t.Fatalf("status bot=%s want %s", service.statusBot, other.ID)
	}

	requestBody := map[string]any{
		"username": bot.ProxyUsername, "password": bot.ProxyPassword,
		"snapshot_id": snapshot.SnapshotID, "category": "cookies", "chunk_index": 0,
	}
	var firstBody []byte
	for attempt := 0; attempt < 2; attempt++ {
		recorder = httptest.NewRecorder()
		api.Chunk(recorder, jsonRequest(t, "/api/v1/get-bot-browser-snapshot-chunk", requestBody))
		if recorder.Code != http.StatusOK || !bytes.Equal(recorder.Body.Bytes(), payload) || recorder.Body.Len() > browsersnapshot.ChunkSizeBytes {
			t.Fatalf("chunk status=%d len=%d body=%q", recorder.Code, recorder.Body.Len(), recorder.Body.Bytes())
		}
		if attempt == 0 {
			firstBody = append([]byte(nil), recorder.Body.Bytes()...)
		} else if !bytes.Equal(firstBody, recorder.Body.Bytes()) {
			t.Fatal("immutable repeated chunk changed")
		}
		wantHeaders := map[string]string{
			"X-Snapshot-Id": snapshot.SnapshotID, "X-Snapshot-Category": "cookies",
			"X-Chunk-Index": "0", "X-Chunk-Offset": "0", "X-Chunk-Count": "1",
			"X-Chunk-Length": strconv.Itoa(len(payload)), "X-Chunk-Sha256": browsersnapshot.SHA256Hex(payload),
			"X-Category-Sha256": browsersnapshot.SHA256Hex(payload), "X-Manifest-Sha256": snapshot.ManifestSHA256,
		}
		for key, want := range wantHeaders {
			if got := recorder.Header().Get(key); got != want {
				t.Errorf("%s=%q want %q", key, got, want)
			}
		}
		if recorder.Header().Get("Content-Type") != "application/octet-stream" {
			t.Errorf("content type=%q", recorder.Header().Get("Content-Type"))
		}
	}
	if service.chunkBot != bot.ID {
		t.Fatalf("chunk bot=%s want %s", service.chunkBot, bot.ID)
	}

	for _, body := range []map[string]any{
		{"username": bot.ProxyUsername, "password": bot.ProxyPassword, "snapshot_id": snapshot.SnapshotID, "category": "sessions", "chunk_index": 0},
		{"username": bot.ProxyUsername, "password": bot.ProxyPassword, "snapshot_id": snapshot.SnapshotID, "category": "cookies", "chunk_index": -1},
	} {
		recorder := httptest.NewRecorder()
		api.Chunk(recorder, jsonRequest(t, "/api/v1/get-bot-browser-snapshot-chunk", body))
		if recorder.Code != http.StatusBadRequest || recorder.Body.Len() == len(payload) {
			t.Fatalf("invalid chunk status=%d body=%s", recorder.Code, recorder.Body.String())
		}
	}
}

type handlerSensorRPC struct {
	mu       sync.Mutex
	captures map[string]handlerCapture
}

type handlerCapture struct {
	manifest []byte
	digest   string
	fields   map[browsersnapshot.Category][]byte
}

func (r *handlerSensorRPC) IsBotOnline(uuid.UUID) bool { return true }

func (r *handlerSensorRPC) CallBot(_ context.Context, _ string, action string, data map[string]any) (map[string]any, error) {
	snapshotID, _ := data["snapshot_id"].(string)
	switch action {
	case browsersnapshot.ActionBeginBrowserSnapshotV1:
		fields := make(map[browsersnapshot.Category][]byte, len(browsersnapshot.Categories))
		descriptors := make(map[browsersnapshot.Category]browsersnapshot.FieldDescriptor, len(browsersnapshot.Categories))
		for _, category := range browsersnapshot.Categories {
			payload := []byte(`[]`)
			fields[category] = payload
			descriptors[category] = browsersnapshot.FieldDescriptor{
				Available: true, Count: 0, ByteLength: 2, SHA256: browsersnapshot.SHA256Hex(payload), ChunkCount: 1,
			}
		}
		now := time.Now().UTC()
		manifest, err := browsersnapshot.CanonicalManifestBytes(browsersnapshot.CaptureManifest{
			SchemaVersion: 1, SensorVersion: "0.2.0", SnapshotID: snapshotID,
			CaptureStartedAt: now.Format(time.RFC3339Nano), CaptureCompletedAt: now.Add(time.Millisecond).Format(time.RFC3339Nano),
			HistoryCoverage: fmt.Sprint(data["history_range"]), Fields: descriptors,
		})
		if err != nil {
			return nil, err
		}
		r.mu.Lock()
		r.captures[snapshotID] = handlerCapture{manifest: manifest, digest: browsersnapshot.SHA256Hex(manifest), fields: fields}
		r.mu.Unlock()
		return map[string]any{"status": "pending", "snapshot_id": snapshotID, "poll_after_ms": 0}, nil
	case browsersnapshot.ActionGetBrowserSnapshotStatusV1:
		r.mu.Lock()
		capture := r.captures[snapshotID]
		r.mu.Unlock()
		return map[string]any{
			"status": "ready", "snapshot_id": snapshotID,
			"manifest_base64": base64.StdEncoding.EncodeToString(capture.manifest), "manifest_sha256": capture.digest,
		}, nil
	case browsersnapshot.ActionGetBrowserSnapshotChunkV1:
		category := browsersnapshot.Category(fmt.Sprint(data["category"]))
		r.mu.Lock()
		capture := r.captures[snapshotID]
		r.mu.Unlock()
		payload := capture.fields[category]
		return map[string]any{
			"snapshot_id": snapshotID, "category": string(category), "chunk_index": 0, "chunk_count": 1,
			"byte_length": len(payload), "chunk_sha256": browsersnapshot.SHA256Hex(payload),
			"category_sha256": browsersnapshot.SHA256Hex(payload), "bytes_base64": base64.StdEncoding.EncodeToString(payload),
		}, nil
	case browsersnapshot.ActionReleaseBrowserSnapshotV1:
		return map[string]any{"released": true}, nil
	default:
		return nil, fmt.Errorf("unexpected action %s", action)
	}
}

func TestBrowserSnapshotHandlerPendingJobOutlivesInitiatingRequest(t *testing.T) {
	db, bot, other := browserSnapshotAPITestDB(t)
	rpc := &handlerSensorRPC{captures: make(map[string]handlerCapture)}
	manager, err := browsersnapshot.NewManager(context.Background(), db, rpc, browsersnapshot.ManagerConfig{
		RPCTimeout: 50 * time.Millisecond, CaptureTimeout: time.Second,
		RetryInterval: time.Millisecond, PollInterval: time.Millisecond, StageParent: t.TempDir(),
	})
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()
	api := &BrowserSnapshotAPI{DB: db, Service: manager}

	requestCtx, cancel := context.WithCancel(context.Background())
	request := jsonRequest(t, "/api/v1/get-bot-browser-snapshot", map[string]any{
		"username": bot.ProxyUsername, "password": bot.ProxyPassword, "history_range": "all", "prefer_live": true,
	}).WithContext(requestCtx)
	recorder := httptest.NewRecorder()
	api.Start(recorder, request)
	cancel()
	startResult := decodeAPIEnvelope(t, recorder)["result"].(map[string]any)
	if startResult["status"] != "pending" {
		t.Fatalf("start=%v", startResult)
	}
	jobID := startResult["job_id"].(string)
	crossBot := httptest.NewRecorder()
	api.Status(crossBot, jsonRequest(t, "/api/v1/get-bot-browser-snapshot-status", map[string]any{
		"username": other.ProxyUsername, "password": other.ProxyPassword, "job_id": jobID,
	}))
	if crossBot.Code != http.StatusNotFound {
		t.Fatalf("cross-bot status=%d body=%s", crossBot.Code, crossBot.Body.String())
	}

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		recorder = httptest.NewRecorder()
		api.Status(recorder, jsonRequest(t, "/api/v1/get-bot-browser-snapshot-status", map[string]any{
			"username": bot.ProxyUsername, "password": bot.ProxyPassword, "job_id": jobID,
		}))
		result := decodeAPIEnvelope(t, recorder)["result"].(map[string]any)
		if result["status"] == "ready" {
			if result["source"] != "live" {
				t.Fatalf("result=%v", result)
			}
			crossChunk := httptest.NewRecorder()
			api.Chunk(crossChunk, jsonRequest(t, "/api/v1/get-bot-browser-snapshot-chunk", map[string]any{
				"username": other.ProxyUsername, "password": other.ProxyPassword,
				"snapshot_id": result["snapshot_id"], "category": "cookies", "chunk_index": 0,
			}))
			if crossChunk.Code != http.StatusNotFound {
				t.Fatalf("cross-bot chunk=%d body=%s", crossChunk.Code, crossChunk.Body.String())
			}
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("job did not become ready after initiating request cancellation")
}
