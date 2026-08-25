package browsersnapshot

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/cyberphone/json-canonicalization/go/src/webpki.org/jsoncanonicalizer"
)

var (
	ErrInvalidManifest = errors.New("invalid browser snapshot manifest")
	ErrDigestMismatch  = errors.New("browser snapshot manifest digest mismatch")
)

func Canonicalize(input []byte) ([]byte, error) {
	canonical, err := jsoncanonicalizer.Transform(input)
	if err != nil {
		return nil, fmt.Errorf("canonicalize JSON: %w", err)
	}
	return canonical, nil
}

func SHA256Hex(input []byte) string {
	sum := sha256.Sum256(input)
	return hex.EncodeToString(sum[:])
}

func CanonicalManifestBytes(manifest CaptureManifest) ([]byte, error) {
	if err := validateManifest(manifest); err != nil {
		return nil, err
	}
	raw, err := json.Marshal(manifest)
	if err != nil {
		return nil, fmt.Errorf("marshal browser snapshot manifest: %w", err)
	}
	return Canonicalize(raw)
}

func VerifyManifestBytes(canonicalBytes []byte, claimedSHA string) (CaptureManifest, error) {
	var zero CaptureManifest
	if !isLowerHexDigest(claimedSHA) || SHA256Hex(canonicalBytes) != claimedSHA {
		return zero, ErrDigestMismatch
	}
	recanonicalized, err := Canonicalize(canonicalBytes)
	if err != nil {
		return zero, fmt.Errorf("%w: canonical JSON", ErrInvalidManifest)
	}
	if !bytes.Equal(recanonicalized, canonicalBytes) {
		return zero, fmt.Errorf("%w: non-canonical bytes", ErrInvalidManifest)
	}

	decoder := json.NewDecoder(bytes.NewReader(canonicalBytes))
	decoder.DisallowUnknownFields()
	var manifest CaptureManifest
	if err := decoder.Decode(&manifest); err != nil {
		return zero, fmt.Errorf("%w: decode", ErrInvalidManifest)
	}
	if err := ensureJSONEOF(decoder); err != nil {
		return zero, fmt.Errorf("%w: trailing data", ErrInvalidManifest)
	}
	if err := validateManifest(manifest); err != nil {
		return zero, err
	}
	return manifest, nil
}

func ensureJSONEOF(decoder *json.Decoder) error {
	var extra any
	err := decoder.Decode(&extra)
	if errors.Is(err, io.EOF) {
		return nil
	}
	if err == nil {
		return errors.New("extra JSON value")
	}
	return err
}

func validateManifest(manifest CaptureManifest) error {
	invalid := func(reason string) error {
		return fmt.Errorf("%w: %s", ErrInvalidManifest, reason)
	}
	if manifest.SchemaVersion != SchemaVersion {
		return invalid("unsupported schema")
	}
	if strings.TrimSpace(manifest.SensorVersion) == "" || strings.TrimSpace(manifest.SnapshotID) == "" {
		return invalid("missing identity")
	}
	started, err := time.Parse(time.RFC3339Nano, manifest.CaptureStartedAt)
	if err != nil {
		return invalid("capture start")
	}
	completed, err := time.Parse(time.RFC3339Nano, manifest.CaptureCompletedAt)
	if err != nil || completed.Before(started) {
		return invalid("capture completion")
	}
	switch manifest.HistoryCoverage {
	case "7", "30", "90", "all":
	default:
		return invalid("history coverage")
	}
	if len(manifest.Fields) != len(Categories) {
		return invalid("category set")
	}
	for _, category := range Categories {
		descriptor, ok := manifest.Fields[category]
		if !ok {
			return invalid("missing category")
		}
		if descriptor.Count < 0 || descriptor.ByteLength < 0 || descriptor.ChunkCount < 0 {
			return invalid("negative descriptor")
		}
		if descriptor.Available {
			if descriptor.ByteLength < 2 || descriptor.ChunkCount < 1 || !isLowerHexDigest(descriptor.SHA256) {
				return invalid("available descriptor")
			}
		} else if descriptor.Count != 0 || descriptor.ByteLength != 0 || descriptor.ChunkCount != 0 || descriptor.SHA256 != "" {
			return invalid("unavailable descriptor")
		}
	}
	return nil
}

func isLowerHexDigest(value string) bool {
	if len(value) != sha256.Size*2 || value != strings.ToLower(value) {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil
}
