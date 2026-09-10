package api

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/s045pd/umbra/internal/db/models"
	"github.com/s045pd/umbra/internal/transcribe"
)

func TestPendingNightly_SkipsFreshAndTranscribed(t *testing.T) {
	now := time.Date(2026, 9, 11, 2, 0, 0, 0, time.UTC)
	freshEnd := now.Add(-2 * time.Minute)
	oldEnd := now.Add(-30 * time.Minute)
	sessions := []audioSession{
		{SessionID: "fresh", EndTime: freshEnd, ChunkCount: 3},
		{SessionID: "done", EndTime: oldEnd, ChunkCount: 2, Transcript: "already"},
		{SessionID: "due", EndTime: oldEnd, ChunkCount: 4},
	}
	got := pendingNightly(sessions, now, 15*time.Minute)
	if len(got) != 1 || got[0].SessionID != "due" {
		t.Fatalf("got %+v", got)
	}
}

func TestTranscribePending_WritesEmptyTakes(t *testing.T) {
	a, gdb := setupMediaAPI(t)
	bot := uuid.New()
	old := time.Now().UTC().Add(-time.Hour)
	due := models.BotRecording{Bot: bot, Recording: "YWI=", SessionID: "night-1", Timestamp: &old}
	if err := gdb.Create(&due).Error; err != nil {
		t.Fatal(err)
	}
	freshTS := time.Now().UTC()
	fresh := models.BotRecording{Bot: bot, Recording: "YWI=", SessionID: "live-1", Timestamp: &freshTS}
	if err := gdb.Create(&fresh).Error; err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	bin := filepath.Join(dir, "whisper-cli")
	model := filepath.Join(dir, "ggml-tiny.bin")
	if err := os.WriteFile(model, []byte("m"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(bin, []byte("#!/bin/sh\necho '  nightly ok  '\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	a.Transcribe = transcribe.Options{Bin: bin, Model: model}

	n, err := a.TranscribePending(context.Background(), time.Now().UTC(), 15*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("transcribed %d, want 1", n)
	}
	var saved models.BotRecording
	if err := gdb.First(&saved, "session_id = ?", "night-1").Error; err != nil {
		t.Fatal(err)
	}
	if saved.Text != "nightly ok" {
		t.Fatalf("text=%q", saved.Text)
	}
	var live models.BotRecording
	if err := gdb.First(&live, "session_id = ?", "live-1").Error; err != nil {
		t.Fatal(err)
	}
	if live.Text != "" {
		t.Fatalf("live take should wait, got %q", live.Text)
	}
}

func TestTranscribePending_EmptyOutputMarkedSoItDoesNotRetry(t *testing.T) {
	a, gdb := setupMediaAPI(t)
	bot := uuid.New()
	old := time.Now().UTC().Add(-time.Hour)
	row := models.BotRecording{Bot: bot, Recording: "YWI=", SessionID: "quiet-1", Timestamp: &old}
	if err := gdb.Create(&row).Error; err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	bin := filepath.Join(dir, "whisper-cli")
	model := filepath.Join(dir, "ggml-tiny.bin")
	if err := os.WriteFile(model, []byte("m"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(bin, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	a.Transcribe = transcribe.Options{Bin: bin, Model: model}
	n, err := a.TranscribePending(context.Background(), time.Now().UTC(), 15*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("n=%d", n)
	}
	var saved models.BotRecording
	if err := gdb.First(&saved, "session_id = ?", "quiet-1").Error; err != nil {
		t.Fatal(err)
	}
	if saved.Text != noSpeechMarker {
		t.Fatalf("text=%q want marker", saved.Text)
	}
	n, err = a.TranscribePending(context.Background(), time.Now().UTC(), 15*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("retry n=%d, want 0", n)
	}
}
