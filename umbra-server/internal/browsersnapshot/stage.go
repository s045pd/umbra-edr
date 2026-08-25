package browsersnapshot

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"

	"github.com/google/uuid"
)

var (
	ErrInvalidChunk    = errors.New("invalid browser snapshot chunk")
	ErrIncompleteStage = errors.New("incomplete browser snapshot stage")
)

type stagedChunk struct {
	byteLength int
	digest     string
}

// Stage appends verified chunks into private per-category files and exposes
// exact bytes only after all descriptors, JSON arrays, counts, and digests pass.
type Stage struct {
	mu       sync.Mutex
	dir      string
	manifest CaptureManifest
	next     map[Category]int
	seen     map[Category]map[int]stagedChunk
	closed   bool
}

func NewStageRoot(parent string) (string, error) {
	if parent == "" {
		parent = os.TempDir()
	}
	root, err := os.MkdirTemp(parent, "umbra-browser-snapshots-")
	if err != nil {
		return "", fmt.Errorf("create browser snapshot staging root: %w", err)
	}
	if err := os.Chmod(root, 0o700); err != nil {
		_ = os.RemoveAll(root)
		return "", fmt.Errorf("protect browser snapshot staging root: %w", err)
	}
	return root, nil
}

func NewStage(root string, manifest CaptureManifest) (*Stage, error) {
	if err := validateManifest(manifest); err != nil {
		return nil, err
	}
	if _, err := uuid.Parse(manifest.SnapshotID); err != nil {
		return nil, fmt.Errorf("%w: snapshot id", ErrInvalidManifest)
	}
	var total int64
	for _, category := range Categories {
		descriptor := manifest.Fields[category]
		if !descriptor.Available || descriptor.ByteLength > MaxCategoryBytes || descriptor.Count > MaxCategoryItemCount {
			return nil, fmt.Errorf("%w: category %s", ErrInvalidManifest, category)
		}
		wantChunks := int((descriptor.ByteLength + ChunkSizeBytes - 1) / ChunkSizeBytes)
		if descriptor.ChunkCount != wantChunks {
			return nil, fmt.Errorf("%w: category chunks %s", ErrInvalidManifest, category)
		}
		total += descriptor.ByteLength
	}
	if total > MaxSnapshotBytes {
		return nil, fmt.Errorf("%w: total bytes", ErrInvalidManifest)
	}
	info, err := os.Stat(root)
	if err != nil || !info.IsDir() {
		return nil, fmt.Errorf("invalid browser snapshot staging root")
	}
	if info.Mode().Perm() != 0o700 {
		return nil, fmt.Errorf("browser snapshot staging root must be mode 0700")
	}
	dir, err := os.MkdirTemp(root, "stage-")
	if err != nil {
		return nil, fmt.Errorf("create browser snapshot stage: %w", err)
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		_ = os.RemoveAll(dir)
		return nil, fmt.Errorf("protect browser snapshot stage: %w", err)
	}
	stage := &Stage{
		dir: dir, manifest: manifest, next: make(map[Category]int, len(Categories)),
		seen: make(map[Category]map[int]stagedChunk, len(Categories)),
	}
	for _, category := range Categories {
		stage.seen[category] = make(map[int]stagedChunk)
	}
	return stage, nil
}

func (s *Stage) Dir() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.dir
}

func (s *Stage) Append(chunk Chunk) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	invalid := func(reason string) error { return fmt.Errorf("%w: %s", ErrInvalidChunk, reason) }
	if s.closed {
		return invalid("stage closed")
	}
	if chunk.SnapshotID != s.manifest.SnapshotID {
		return invalid("snapshot echo")
	}
	descriptor, ok := s.manifest.Fields[chunk.Category]
	if !ok || !descriptor.Available {
		return invalid("category echo")
	}
	if chunk.ChunkIndex < 0 || chunk.ChunkIndex >= descriptor.ChunkCount {
		return invalid("chunk index")
	}
	if chunk.ChunkCount != descriptor.ChunkCount {
		return invalid("chunk count")
	}
	if chunk.ByteLength != len(chunk.Bytes) || len(chunk.Bytes) == 0 || len(chunk.Bytes) > ChunkSizeBytes {
		return invalid("byte length")
	}
	if chunk.ChunkSHA256 != SHA256Hex(chunk.Bytes) {
		return invalid("chunk digest")
	}
	if chunk.CategorySHA256 != descriptor.SHA256 {
		return invalid("category digest")
	}
	if previous, exists := s.seen[chunk.Category][chunk.ChunkIndex]; exists {
		if previous.byteLength == chunk.ByteLength && previous.digest == chunk.ChunkSHA256 {
			return nil
		}
		return invalid("changed duplicate")
	}
	if chunk.ChunkIndex != s.next[chunk.Category] {
		return invalid("out of order")
	}
	path := filepath.Join(s.dir, string(chunk.Category)+".json")
	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return fmt.Errorf("append browser snapshot chunk: %w", err)
	}
	if err := file.Chmod(0o600); err != nil {
		_ = file.Close()
		return fmt.Errorf("protect browser snapshot category: %w", err)
	}
	if _, err := file.Write(chunk.Bytes); err != nil {
		_ = file.Close()
		return fmt.Errorf("append browser snapshot chunk: %w", err)
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		return fmt.Errorf("sync browser snapshot chunk: %w", err)
	}
	if err := file.Close(); err != nil {
		return fmt.Errorf("close browser snapshot chunk: %w", err)
	}
	s.seen[chunk.Category][chunk.ChunkIndex] = stagedChunk{byteLength: chunk.ByteLength, digest: chunk.ChunkSHA256}
	s.next[chunk.Category]++
	return nil
}

func (s *Stage) Complete() (map[Category][]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil, fmt.Errorf("%w: stage closed", ErrIncompleteStage)
	}
	result := make(map[Category][]byte, len(Categories))
	for _, category := range Categories {
		descriptor := s.manifest.Fields[category]
		if s.next[category] != descriptor.ChunkCount {
			return nil, fmt.Errorf("%w: category %s", ErrIncompleteStage, category)
		}
		path := filepath.Join(s.dir, string(category)+".json")
		file, err := os.Open(path)
		if err != nil {
			return nil, fmt.Errorf("%w: open category %s", ErrIncompleteStage, category)
		}
		payload, readErr := io.ReadAll(io.LimitReader(file, MaxCategoryBytes+1))
		closeErr := file.Close()
		if readErr != nil {
			return nil, fmt.Errorf("read staged category %s: %w", category, readErr)
		}
		if closeErr != nil {
			return nil, fmt.Errorf("close staged category %s: %w", category, closeErr)
		}
		if len(payload) > MaxCategoryBytes || int64(len(payload)) != descriptor.ByteLength || SHA256Hex(payload) != descriptor.SHA256 {
			return nil, fmt.Errorf("%w: integrity %s", ErrIncompleteStage, category)
		}
		count, err := countJSONArray(payload)
		if err != nil || count != descriptor.Count {
			return nil, fmt.Errorf("%w: JSON %s", ErrIncompleteStage, category)
		}
		result[category] = payload
	}
	return result, nil
}

func (s *Stage) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil
	}
	s.closed = true
	return os.RemoveAll(s.dir)
}
