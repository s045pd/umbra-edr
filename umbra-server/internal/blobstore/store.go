// Package blobstore is a content-addressed filesystem for screenshot and
// audio payloads so Postgres is not used as a blob dump.
package blobstore

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Store writes blobs under root/{kind}/{hash[:2]}/{hash}.
type Store struct {
	Root string
}

// Open creates the root directory if needed.
func Open(root string) (*Store, error) {
	if strings.TrimSpace(root) == "" {
		return nil, fmt.Errorf("blobstore root is empty")
	}
	if err := os.MkdirAll(root, 0o755); err != nil {
		return nil, fmt.Errorf("mkdir blobstore: %w", err)
	}
	return &Store{Root: root}, nil
}

func (s *Store) path(kind, hash string) string {
	return filepath.Join(s.Root, kind, hash[:2], hash)
}

// Put writes data if it is not already present and returns the sha256 hex.
func (s *Store) Put(kind string, data []byte) (string, error) {
	if s == nil {
		return "", fmt.Errorf("blobstore is nil")
	}
	sum := sha256.Sum256(data)
	hash := hex.EncodeToString(sum[:])
	p := s.path(kind, hash)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return "", err
	}
	if _, err := os.Stat(p); err == nil {
		return hash, nil
	}
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return "", err
	}
	if err := os.Rename(tmp, p); err != nil {
		_ = os.Remove(tmp)
		return "", err
	}
	return hash, nil
}

// Get reads a previously stored blob.
func (s *Store) Get(kind, hash string) ([]byte, error) {
	if s == nil {
		return nil, fmt.Errorf("blobstore is nil")
	}
	if len(hash) < 4 {
		return nil, fmt.Errorf("invalid blob hash")
	}
	return os.ReadFile(s.path(kind, hash))
}

// DecodeDataURL extracts raw bytes from a data: URL or raw base64.
func DecodeDataURL(img string) (raw []byte, contentType string, err error) {
	contentType = "application/octet-stream"
	payload := img
	if idx := strings.Index(img, ";base64,"); idx != -1 {
		prefix := img[:idx]
		contentType = strings.TrimPrefix(prefix, "data:")
		payload = img[idx+len(";base64,"):]
	}
	raw, err = base64.StdEncoding.DecodeString(payload)
	if err != nil {
		raw, err = base64.RawStdEncoding.DecodeString(payload)
	}
	return raw, contentType, err
}
