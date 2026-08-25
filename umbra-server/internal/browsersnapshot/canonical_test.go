package browsersnapshot

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type canonicalVectorFile struct {
	Valid []struct {
		Name      string `json:"name"`
		Input     string `json:"input"`
		Canonical string `json:"canonical"`
	} `json:"valid"`
	Invalid []struct {
		Name  string `json:"name"`
		Input string `json:"input"`
	} `json:"invalid"`
}

func snapshotFixture(t *testing.T, name string) []byte {
	t.Helper()
	p := filepath.Join("..", "..", "..", "testdata", "browser_snapshot", name)
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatalf("read fixture %s: %v", p, err)
	}
	return b
}

func TestJCSVectors(t *testing.T) {
	var vectors canonicalVectorFile
	if err := json.Unmarshal(snapshotFixture(t, "jcs_vectors.json"), &vectors); err != nil {
		t.Fatal(err)
	}
	for _, vector := range vectors.Valid {
		t.Run(vector.Name, func(t *testing.T) {
			got, err := Canonicalize([]byte(vector.Input))
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(got, []byte(vector.Canonical)) {
				t.Fatalf("canonical bytes\n got: %q\nwant: %q", got, vector.Canonical)
			}
		})
	}
	for _, vector := range vectors.Invalid {
		t.Run("invalid-"+vector.Name, func(t *testing.T) {
			if _, err := Canonicalize([]byte(vector.Input)); err == nil {
				t.Fatal("expected canonicalization error")
			}
		})
	}
}

func TestManifestDigest(t *testing.T) {
	var fixture struct {
		Manifest  json.RawMessage `json:"manifest"`
		Canonical string          `json:"canonical"`
		SHA256    string          `json:"sha256"`
	}
	if err := json.Unmarshal(snapshotFixture(t, "manifest_v1.json"), &fixture); err != nil {
		t.Fatal(err)
	}
	canonical, err := Canonicalize(fixture.Manifest)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(canonical, []byte(fixture.Canonical)) {
		t.Fatalf("canonical manifest mismatch\n got: %q\nwant: %q", canonical, fixture.Canonical)
	}
	if got := SHA256Hex(canonical); got != fixture.SHA256 {
		t.Fatalf("digest=%s, want %s", got, fixture.SHA256)
	}
	manifest, err := VerifyManifestBytes(canonical, fixture.SHA256)
	if err != nil {
		t.Fatal(err)
	}
	if manifest.SchemaVersion != 1 || manifest.SnapshotID == "" {
		t.Fatalf("unexpected manifest: %+v", manifest)
	}
}

func TestVerifyManifestBytesRejectsInvalidContracts(t *testing.T) {
	var fixture struct {
		Manifest  map[string]any `json:"manifest"`
		Canonical string         `json:"canonical"`
		SHA256    string         `json:"sha256"`
	}
	if err := json.Unmarshal(snapshotFixture(t, "manifest_v1.json"), &fixture); err != nil {
		t.Fatal(err)
	}

	canonicalFrom := func(t *testing.T, value map[string]any) []byte {
		t.Helper()
		raw, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		canonical, err := Canonicalize(raw)
		if err != nil {
			t.Fatal(err)
		}
		return canonical
	}
	cloneManifest := func(t *testing.T) map[string]any {
		t.Helper()
		raw, _ := json.Marshal(fixture.Manifest)
		var clone map[string]any
		if err := json.Unmarshal(raw, &clone); err != nil {
			t.Fatal(err)
		}
		return clone
	}

	tests := []struct {
		name  string
		bytes func(*testing.T) []byte
		sha   func([]byte) string
	}{
		{
			name: "non-canonical whitespace",
			bytes: func(*testing.T) []byte {
				return append([]byte("{\n"), []byte(fixture.Canonical[1:])...)
			},
			sha: SHA256Hex,
		},
		{
			name: "unsupported schema",
			bytes: func(t *testing.T) []byte {
				m := cloneManifest(t)
				m["schema_version"] = 2
				return canonicalFrom(t, m)
			},
			sha: SHA256Hex,
		},
		{
			name: "missing category",
			bytes: func(t *testing.T) []byte {
				m := cloneManifest(t)
				delete(m["fields"].(map[string]any), "tabs")
				return canonicalFrom(t, m)
			},
			sha: SHA256Hex,
		},
		{
			name: "extra category",
			bytes: func(t *testing.T) []byte {
				m := cloneManifest(t)
				m["fields"].(map[string]any)["sessions"] = map[string]any{}
				return canonicalFrom(t, m)
			},
			sha: SHA256Hex,
		},
		{
			name: "negative descriptor",
			bytes: func(t *testing.T) []byte {
				m := cloneManifest(t)
				m["fields"].(map[string]any)["history"].(map[string]any)["count"] = -1
				return canonicalFrom(t, m)
			},
			sha: SHA256Hex,
		},
		{
			name: "unknown digest member",
			bytes: func(t *testing.T) []byte {
				m := cloneManifest(t)
				m["manifest_sha256"] = fixture.SHA256
				return canonicalFrom(t, m)
			},
			sha: SHA256Hex,
		},
		{
			name: "completion before start",
			bytes: func(t *testing.T) []byte {
				m := cloneManifest(t)
				m["capture_completed_at"] = "2026-08-24T06:30:00.000Z"
				return canonicalFrom(t, m)
			},
			sha: SHA256Hex,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			payload := tc.bytes(t)
			_, err := VerifyManifestBytes(payload, tc.sha(payload))
			if !errors.Is(err, ErrInvalidManifest) {
				t.Fatalf("error=%v, want ErrInvalidManifest", err)
			}
		})
	}

	t.Run("digest mismatch", func(t *testing.T) {
		_, err := VerifyManifestBytes([]byte(fixture.Canonical), strings.Repeat("0", 64))
		if !errors.Is(err, ErrDigestMismatch) {
			t.Fatalf("error=%v, want ErrDigestMismatch", err)
		}
	})
}
