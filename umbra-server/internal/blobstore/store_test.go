package blobstore

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func TestPutGet_RoundTrip(t *testing.T) {
	root := t.TempDir()
	s, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	hash, err := s.Put("screenshots", []byte("jpeg-bytes"))
	if err != nil {
		t.Fatal(err)
	}
	if len(hash) != 64 {
		t.Fatalf("hash len=%d want 64", len(hash))
	}
	got, err := s.Get("screenshots", hash)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, []byte("jpeg-bytes")) {
		t.Fatalf("got %q", got)
	}
	// Content-addressed: same bytes, same hash, no extra file.
	hash2, err := s.Put("screenshots", []byte("jpeg-bytes"))
	if err != nil {
		t.Fatal(err)
	}
	if hash2 != hash {
		t.Fatalf("hash2=%s hash=%s", hash2, hash)
	}
}

func TestGet_Missing(t *testing.T) {
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.Get("screenshots", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestDecodeDataURL(t *testing.T) {
	raw, ct, err := DecodeDataURL("data:image/png;base64,aGVsbG8=")
	if err != nil {
		t.Fatal(err)
	}
	if ct != "image/png" || string(raw) != "hello" {
		t.Fatalf("ct=%s raw=%q", ct, raw)
	}
	raw, ct, err = DecodeDataURL("aGVsbG8=")
	if err != nil {
		t.Fatal(err)
	}
	if ct != "application/octet-stream" || string(raw) != "hello" {
		t.Fatalf("ct=%s raw=%q", ct, raw)
	}
}

func TestOpen_CreatesRoot(t *testing.T) {
	root := filepath.Join(t.TempDir(), "nested", "media")
	if _, err := Open(root); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(root); err != nil {
		t.Fatal(err)
	}
}
