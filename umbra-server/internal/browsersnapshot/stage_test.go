package browsersnapshot

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/google/uuid"
)

func stageManifest(t *testing.T, snapshotID string, payloads map[Category][]byte) CaptureManifest {
	t.Helper()
	fields := make(map[Category]FieldDescriptor, len(Categories))
	for _, category := range Categories {
		payload := payloads[category]
		var items []any
		if err := json.Unmarshal(payload, &items); err != nil {
			t.Fatal(err)
		}
		fields[category] = FieldDescriptor{
			Available: true, Count: int64(len(items)), ByteLength: int64(len(payload)),
			SHA256: SHA256Hex(payload), ChunkCount: (len(payload) + ChunkSizeBytes - 1) / ChunkSizeBytes,
		}
	}
	return CaptureManifest{
		SchemaVersion: SchemaVersion, SensorVersion: "0.2.0", SnapshotID: snapshotID,
		CaptureStartedAt:   time.Date(2026, 8, 24, 6, 0, 0, 0, time.UTC).Format(time.RFC3339Nano),
		CaptureCompletedAt: time.Date(2026, 8, 24, 6, 1, 0, 0, time.UTC).Format(time.RFC3339Nano),
		HistoryCoverage:    string(CoverageAll), Fields: fields,
	}
}

func completeStagePayloads(history []byte) map[Category][]byte {
	return map[Category][]byte{
		CategoryCookies: []byte(`[{"name":"sid"}]`), CategoryHistory: history,
		CategoryBookmarks: []byte(`[]`), CategoryDownloads: []byte(`[]`), CategoryTabs: []byte(`[]`),
	}
}

func chunkFor(manifest CaptureManifest, category Category, index int, payload []byte) Chunk {
	start := index * ChunkSizeBytes
	end := min(len(payload), start+ChunkSizeBytes)
	bytes := payload[start:end]
	return Chunk{
		SnapshotID: manifest.SnapshotID, Category: category, ChunkIndex: index,
		ChunkCount: manifest.Fields[category].ChunkCount, ByteLength: len(bytes),
		ChunkSHA256: SHA256Hex(bytes), CategorySHA256: manifest.Fields[category].SHA256,
		Bytes: append([]byte(nil), bytes...),
	}
}

func TestStageAppendCompletePreservesExactBytesAndPrivatePermissions(t *testing.T) {
	history := []byte(`[{"url":"https://large.test/","payload":"` + string(bytes.Repeat([]byte{'x'}, ChunkSizeBytes+32)) + `"}]`)
	payloads := completeStagePayloads(history)
	manifest := stageManifest(t, uuid.NewString(), payloads)
	root, err := NewStageRoot(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	rootInfo, err := os.Stat(root)
	if err != nil {
		t.Fatal(err)
	}
	if rootInfo.Mode().Perm() != 0o700 {
		t.Fatalf("root mode=%o", rootInfo.Mode().Perm())
	}
	stage, err := NewStage(root, manifest)
	if err != nil {
		t.Fatal(err)
	}
	defer stage.Close()

	for _, category := range Categories {
		payload := payloads[category]
		for index := range manifest.Fields[category].ChunkCount {
			if err := stage.Append(chunkFor(manifest, category, index, payload)); err != nil {
				t.Fatalf("append %s/%d: %v", category, index, err)
			}
		}
	}
	assembled, err := stage.Complete()
	if err != nil {
		t.Fatal(err)
	}
	for _, category := range Categories {
		if !bytes.Equal(assembled[category], payloads[category]) {
			t.Errorf("category %s was changed", category)
		}
		info, err := os.Stat(filepath.Join(stage.Dir(), string(category)+".json"))
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != 0o600 {
			t.Errorf("%s mode=%o", category, info.Mode().Perm())
		}
	}
}

func TestStageRejectsOutOfOrderAndOnlyAcceptsIdenticalDuplicate(t *testing.T) {
	history := []byte(`[{"url":"https://large.test/","payload":"` + string(bytes.Repeat([]byte{'y'}, ChunkSizeBytes+16)) + `"}]`)
	payloads := completeStagePayloads(history)
	manifest := stageManifest(t, uuid.NewString(), payloads)
	root, _ := NewStageRoot(t.TempDir())
	stage, err := NewStage(root, manifest)
	if err != nil {
		t.Fatal(err)
	}
	defer stage.Close()

	second := chunkFor(manifest, CategoryHistory, 1, history)
	if err := stage.Append(second); err == nil {
		t.Fatal("out-of-order second chunk succeeded")
	}
	first := chunkFor(manifest, CategoryHistory, 0, history)
	if err := stage.Append(first); err != nil {
		t.Fatal(err)
	}
	if err := stage.Append(first); err != nil {
		t.Fatalf("identical retry failed: %v", err)
	}
	changed := first
	changed.Bytes = append([]byte(nil), first.Bytes...)
	changed.Bytes[0] ^= 1
	changed.ChunkSHA256 = SHA256Hex(changed.Bytes)
	if err := stage.Append(changed); err == nil {
		t.Fatal("changed duplicate succeeded")
	}
	if err := stage.Append(second); err != nil {
		t.Fatal(err)
	}
}

func TestStageRejectsEchoDigestLengthCountAndPartialFailures(t *testing.T) {
	payloads := completeStagePayloads([]byte(`[{"url":"https://history.test/"}]`))
	manifest := stageManifest(t, uuid.NewString(), payloads)

	mutations := []struct {
		name   string
		mutate func(*Chunk)
	}{
		{"snapshot", func(chunk *Chunk) { chunk.SnapshotID = uuid.NewString() }},
		{"category", func(chunk *Chunk) { chunk.Category = CategoryTabs }},
		{"index", func(chunk *Chunk) { chunk.ChunkIndex = 1 }},
		{"chunk count", func(chunk *Chunk) { chunk.ChunkCount++ }},
		{"byte length", func(chunk *Chunk) { chunk.ByteLength++ }},
		{"chunk digest", func(chunk *Chunk) { chunk.ChunkSHA256 = string(bytes.Repeat([]byte{'0'}, 64)) }},
		{"category digest", func(chunk *Chunk) { chunk.CategorySHA256 = string(bytes.Repeat([]byte{'0'}, 64)) }},
	}
	for _, tc := range mutations {
		t.Run(tc.name, func(t *testing.T) {
			root, _ := NewStageRoot(t.TempDir())
			stage, err := NewStage(root, manifest)
			if err != nil {
				t.Fatal(err)
			}
			defer stage.Close()
			chunk := chunkFor(manifest, CategoryCookies, 0, payloads[CategoryCookies])
			tc.mutate(&chunk)
			if err := stage.Append(chunk); err == nil {
				t.Fatal("invalid chunk succeeded")
			}
		})
	}

	root, _ := NewStageRoot(t.TempDir())
	stage, _ := NewStage(root, manifest)
	defer stage.Close()
	if err := stage.Append(chunkFor(manifest, CategoryCookies, 0, payloads[CategoryCookies])); err != nil {
		t.Fatal(err)
	}
	if _, err := stage.Complete(); err == nil {
		t.Fatal("partial stage completed")
	}
}

func TestStageCompleteRejectsMalformedOrCountMismatchedJSON(t *testing.T) {
	for _, tc := range []struct {
		name    string
		payload []byte
		count   int64
	}{
		{"malformed", []byte(`not-json`), 1},
		{"not array", []byte(`{"url":"x"}`), 1},
		{"count", []byte(`[]`), 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			payloads := completeStagePayloads([]byte(`[]`))
			payloads[CategoryCookies] = tc.payload
			manifest := stageManifest(t, uuid.NewString(), completeStagePayloads([]byte(`[]`)))
			descriptor := manifest.Fields[CategoryCookies]
			descriptor.Count = tc.count
			descriptor.ByteLength = int64(len(tc.payload))
			descriptor.SHA256 = SHA256Hex(tc.payload)
			descriptor.ChunkCount = (len(tc.payload) + ChunkSizeBytes - 1) / ChunkSizeBytes
			if descriptor.ChunkCount == 0 {
				descriptor.ChunkCount = 1
			}
			manifest.Fields[CategoryCookies] = descriptor
			root, _ := NewStageRoot(t.TempDir())
			stage, err := NewStage(root, manifest)
			if err != nil {
				t.Fatal(err)
			}
			defer stage.Close()
			for _, category := range Categories {
				payload := payloads[category]
				if err := stage.Append(chunkFor(manifest, category, 0, payload)); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := stage.Complete(); err == nil {
				t.Fatal("invalid category JSON completed")
			}
		})
	}
}

func TestStageCloseRemovesOnlyItsPrivateDirectory(t *testing.T) {
	payloads := completeStagePayloads([]byte(`[]`))
	manifest := stageManifest(t, uuid.NewString(), payloads)
	parent := t.TempDir()
	root, _ := NewStageRoot(parent)
	keep := filepath.Join(root, "keep")
	if err := os.WriteFile(keep, []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	stage, _ := NewStage(root, manifest)
	dir := stage.Dir()
	if err := stage.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("stage directory still exists: %v", err)
	}
	if _, err := os.Stat(keep); err != nil {
		t.Fatalf("sibling was removed: %v", err)
	}
}
