package crxsign

import (
	"archive/zip"
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/binary"
	"encoding/pem"
	"os"
	"path/filepath"
	"testing"
)

func TestLoadOrGenerate_StableIDAcrossRestarts(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	path := filepath.Join(dir, "extkey.pem")

	first, err := LoadOrGenerate(path)
	if err != nil {
		t.Fatalf("first generate: %v", err)
	}
	if got := len(first.ExtensionID()); got != 32 {
		t.Fatalf("ext id length = %d, want 32", got)
	}

	second, err := LoadOrGenerate(path)
	if err != nil {
		t.Fatalf("second load: %v", err)
	}
	if first.ExtensionID() != second.ExtensionID() {
		t.Fatalf("id changed across restarts: %s -> %s", first.ExtensionID(), second.ExtensionID())
	}
}

func TestLoadOrGenerate_RejectsWrongCurve(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	path := filepath.Join(dir, "wrongcurve.pem")

	key, err := ecdsa.GenerateKey(elliptic.P384(), rand.Reader)
	if err != nil {
		t.Fatalf("gen p384: %v", err)
	}
	der, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	pemBytes := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: der})
	if err := os.WriteFile(path, pemBytes, 0o600); err != nil {
		t.Fatalf("write key: %v", err)
	}
	if _, err := LoadOrGenerate(path); err == nil {
		t.Fatal("expected error for non-P256 curve")
	}
}

// TestEncodeExtensionID locks in Chrome's a-p nibble alphabet.
// Each byte maps to two letters: high nibble + low nibble, where
// 0 -> 'a', 1 -> 'b', ..., 15 -> 'p'.
func TestEncodeExtensionID(t *testing.T) {
	t.Parallel()
	in := []byte{0x00, 0xFF, 0x12, 0x34, 0xAB, 0xCD, 0xEF, 0x01}
	want := "aappbcdeklmnopab"
	if got := encodeExtensionID(in); got != want {
		t.Fatalf("encodeExtensionID = %q, want %q", got, want)
	}
}

// TestBuildCRX_ParsesAndVerifies covers the exact chain Chrome / Edge runs
// at install time: parse magic + version, pull the ECDSA proof out of the
// header, recompute the signed input, and verify the signature.
func TestBuildCRX_ParsesAndVerifies(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	signer, err := LoadOrGenerate(filepath.Join(dir, "extkey.pem"))
	if err != nil {
		t.Fatalf("signer: %v", err)
	}

	var zb bytes.Buffer
	zw := zip.NewWriter(&zb)
	fw, _ := zw.Create("manifest.json")
	if _, err := fw.Write([]byte(`{"name":"x","version":"1.0.0","manifest_version":3}`)); err != nil {
		t.Fatalf("zip write: %v", err)
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("zip close: %v", err)
	}

	crx, err := signer.BuildCRX(zb.Bytes())
	if err != nil {
		t.Fatalf("BuildCRX: %v", err)
	}

	if string(crx[:4]) != "Cr24" {
		t.Fatalf("magic = %q, want %q", crx[:4], "Cr24")
	}
	if v := binary.LittleEndian.Uint32(crx[4:8]); v != 3 {
		t.Fatalf("version = %d, want 3", v)
	}
	headerLen := binary.LittleEndian.Uint32(crx[8:12])
	if int(headerLen) > len(crx)-12 {
		t.Fatalf("header_size %d would exceed crx body %d", headerLen, len(crx)-12)
	}
	header := crx[12 : 12+headerLen]
	body := crx[12+headerLen:]

	if !bytes.Equal(body, zb.Bytes()) {
		t.Fatal("zip body in CRX differs from input")
	}

	pubKey, sig, signedHeaderData := decodeHeader(t, header)

	var lenBuf [4]byte
	binary.LittleEndian.PutUint32(lenBuf[:], uint32(len(signedHeaderData)))
	signInput := append([]byte(nil), signedDataMagic...)
	signInput = append(signInput, lenBuf[:]...)
	signInput = append(signInput, signedHeaderData...)
	signInput = append(signInput, body...)

	digest := sha256.Sum256(signInput)
	parsedPub, err := x509.ParsePKIXPublicKey(pubKey)
	if err != nil {
		t.Fatalf("parse pub: %v", err)
	}
	ecPub, ok := parsedPub.(*ecdsa.PublicKey)
	if !ok {
		t.Fatalf("pub is %T, want *ecdsa.PublicKey", parsedPub)
	}
	if !ecdsa.VerifyASN1(ecPub, digest[:], sig) {
		t.Fatal("ECDSA signature did not verify")
	}

	want := signer.ExtensionID()
	got := encodeExtensionID(extractCrxID(t, signedHeaderData))
	if want != got {
		t.Fatalf("crx_id derives id %q, signer reports %q", got, want)
	}
}

func decodeHeader(t *testing.T, header []byte) (pubKey, sig, signedHeaderData []byte) {
	t.Helper()
	for len(header) > 0 {
		tag, n := readVarint(header)
		header = header[n:]
		length, n := readVarint(header)
		header = header[n:]
		switch tag >> 3 {
		case 3:
			pubKey, sig = decodeProof(t, header[:length])
		case 10000:
			signedHeaderData = append([]byte(nil), header[:length]...)
		}
		header = header[length:]
	}
	return
}

func decodeProof(t *testing.T, proof []byte) (pubKey, sig []byte) {
	t.Helper()
	for len(proof) > 0 {
		tag, n := readVarint(proof)
		proof = proof[n:]
		length, n := readVarint(proof)
		proof = proof[n:]
		switch tag >> 3 {
		case 1:
			pubKey = append([]byte(nil), proof[:length]...)
		case 2:
			sig = append([]byte(nil), proof[:length]...)
		}
		proof = proof[length:]
	}
	return
}

func extractCrxID(t *testing.T, signedHeaderData []byte) []byte {
	t.Helper()
	for len(signedHeaderData) > 0 {
		tag, n := readVarint(signedHeaderData)
		signedHeaderData = signedHeaderData[n:]
		length, n := readVarint(signedHeaderData)
		signedHeaderData = signedHeaderData[n:]
		if tag>>3 == 1 {
			return append([]byte(nil), signedHeaderData[:length]...)
		}
		signedHeaderData = signedHeaderData[length:]
	}
	t.Fatal("crx_id not found in signed_header_data")
	return nil
}

func readVarint(b []byte) (uint64, int) {
	var v uint64
	var shift uint
	for i, c := range b {
		v |= uint64(c&0x7F) << shift
		if c < 0x80 {
			return v, i + 1
		}
		shift += 7
	}
	return 0, 0
}
