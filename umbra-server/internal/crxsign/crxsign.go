// Package crxsign builds Chrome CRX v3 packages signed with a persistent
// ECDSA P-256 key. The key is generated on first use and stored alongside
// the MITM CA so the derived Extension ID stays stable across restarts —
// which is what enterprise force-install policies (Edge
// ExtensionInstallForcelist, Chrome ExtensionSettings) need to identify
// and install the extension.
//
// CRX v3 wire format reference:
//
//	[4]  magic = "Cr24"
//	[4]  version = 3 (LE u32)
//	[4]  header_size (LE u32)
//	[N]  header (CrxFileHeader protobuf)
//	[M]  zip body
//
// Signed content (digested by SHA-256, signed by ECDSA):
//
//	"CRX3 SignedData\x00" || LE-u32(len(signed_header_data)) || signed_header_data || zip
package crxsign

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/binary"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// signedDataMagic is the 16-byte prefix Chrome digests before the
// signed_header_data + zip body. Includes the trailing NUL.
var signedDataMagic = []byte("CRX3 SignedData\x00")

// Signer is an ECDSA P-256 keypair plus the derived Extension ID.
// One Signer per server process is sufficient — it's stateless besides
// the key material.
type Signer struct {
	key       *ecdsa.PrivateKey
	pubKeyDER []byte // SubjectPublicKeyInfo (X.509)
	extID     []byte // first 16 bytes of SHA-256(pubKeyDER)
	extIDStr  string // 32-char a-p encoding of extID
}

// LoadOrGenerate loads the EC private key from path, or creates and
// persists a new one if path does not exist. The parent directory is
// created with 0o755 if missing; the key file is written with 0o600.
func LoadOrGenerate(path string) (*Signer, error) {
	s, err := loadFromFile(path)
	if err == nil {
		return s, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("load ext signing key: %w", err)
	}
	return generateAndPersist(path)
}

func loadFromFile(path string) (*Signer, error) {
	data, err := os.ReadFile(path) //nolint:gosec // path supplied by operator
	if err != nil {
		return nil, err
	}
	block, _ := pem.Decode(data)
	if block == nil {
		return nil, errors.New("ext key: missing PEM block")
	}
	if block.Type != "EC PRIVATE KEY" {
		return nil, fmt.Errorf("ext key: unexpected PEM type %q", block.Type)
	}
	key, err := x509.ParseECPrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("parse ec key: %w", err)
	}
	if key.Curve != elliptic.P256() {
		return nil, fmt.Errorf("ext key: expected P-256, got %s", key.Curve.Params().Name)
	}
	return newSignerFromKey(key)
}

func generateAndPersist(path string) (*Signer, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("gen ec key: %w", err)
	}
	der, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return nil, fmt.Errorf("marshal ec key: %w", err)
	}
	if dir := filepath.Dir(path); dir != "" {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return nil, fmt.Errorf("ext key dir: %w", err)
		}
	}
	pemBytes := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: der})
	if err := os.WriteFile(path, pemBytes, 0o600); err != nil {
		return nil, fmt.Errorf("write ext key: %w", err)
	}
	return newSignerFromKey(key)
}

func newSignerFromKey(key *ecdsa.PrivateKey) (*Signer, error) {
	pubDER, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		return nil, fmt.Errorf("marshal pub: %w", err)
	}
	sum := sha256.Sum256(pubDER)
	extID := make([]byte, 16)
	copy(extID, sum[:16])
	return &Signer{
		key:       key,
		pubKeyDER: pubDER,
		extID:     extID,
		extIDStr:  encodeExtensionID(extID),
	}, nil
}

// ExtensionID returns Chrome's 32-char extension identifier (a-p alphabet).
func (s *Signer) ExtensionID() string { return s.extIDStr }

// PublicKeyDER returns the SubjectPublicKeyInfo bytes used to derive the ID.
// Useful for tests and the optional manifest "key" field.
func (s *Signer) PublicKeyDER() []byte {
	out := make([]byte, len(s.pubKeyDER))
	copy(out, s.pubKeyDER)
	return out
}

// BuildCRX wraps zipBody into a CRX v3 with one sha256_with_ecdsa proof.
func (s *Signer) BuildCRX(zipBody []byte) ([]byte, error) {
	signedHeaderData := encodeSignedData(s.extID)

	signInput := make([]byte, 0, len(signedDataMagic)+4+len(signedHeaderData)+len(zipBody))
	signInput = append(signInput, signedDataMagic...)
	var lenBuf [4]byte
	binary.LittleEndian.PutUint32(lenBuf[:], uint32(len(signedHeaderData)))
	signInput = append(signInput, lenBuf[:]...)
	signInput = append(signInput, signedHeaderData...)
	signInput = append(signInput, zipBody...)

	digest := sha256.Sum256(signInput)
	sig, err := ecdsa.SignASN1(rand.Reader, s.key, digest[:])
	if err != nil {
		return nil, fmt.Errorf("sign crx: %w", err)
	}

	header := encodeCrxFileHeader(s.pubKeyDER, sig, signedHeaderData)

	out := make([]byte, 0, 12+len(header)+len(zipBody))
	out = append(out, []byte("Cr24")...)
	var verBuf [4]byte
	binary.LittleEndian.PutUint32(verBuf[:], 3)
	out = append(out, verBuf[:]...)
	var hdrLenBuf [4]byte
	binary.LittleEndian.PutUint32(hdrLenBuf[:], uint32(len(header)))
	out = append(out, hdrLenBuf[:]...)
	out = append(out, header...)
	out = append(out, zipBody...)
	return out, nil
}

// encodeExtensionID maps each 4-bit nibble to 'a'..'p' (Chrome's mpdecimal).
func encodeExtensionID(id []byte) string {
	out := make([]byte, len(id)*2)
	for i, b := range id {
		out[i*2] = 'a' + (b >> 4)
		out[i*2+1] = 'a' + (b & 0x0F)
	}
	return string(out)
}

// encodeSignedData serializes SignedData{ crx_id = id }.
//
//	message SignedData {
//	  optional bytes crx_id = 1;
//	}
func encodeSignedData(id []byte) []byte {
	out := make([]byte, 0, 2+len(id))
	out = appendTag(out, 1, 2) // field 1, wire LEN
	out = appendVarint(out, uint64(len(id)))
	out = append(out, id...)
	return out
}

// encodeCrxFileHeader serializes:
//
//	message CrxFileHeader {
//	  repeated AsymmetricKeyProof sha256_with_ecdsa = 3;
//	  optional bytes              signed_header_data = 10000;
//	}
//	message AsymmetricKeyProof {
//	  optional bytes public_key = 1;
//	  optional bytes signature  = 2;
//	}
func encodeCrxFileHeader(pubKey, sig, signedHeaderData []byte) []byte {
	proof := make([]byte, 0, 4+len(pubKey)+len(sig))
	proof = appendTag(proof, 1, 2)
	proof = appendVarint(proof, uint64(len(pubKey)))
	proof = append(proof, pubKey...)
	proof = appendTag(proof, 2, 2)
	proof = appendVarint(proof, uint64(len(sig)))
	proof = append(proof, sig...)

	out := make([]byte, 0, 8+len(proof)+len(signedHeaderData))
	out = appendTag(out, 3, 2)
	out = appendVarint(out, uint64(len(proof)))
	out = append(out, proof...)
	out = appendTag(out, 10000, 2)
	out = appendVarint(out, uint64(len(signedHeaderData)))
	out = append(out, signedHeaderData...)
	return out
}

func appendTag(b []byte, fieldNumber, wireType int) []byte {
	return appendVarint(b, uint64(fieldNumber)<<3|uint64(wireType))
}

func appendVarint(b []byte, v uint64) []byte {
	for v >= 0x80 {
		b = append(b, byte(v)|0x80)
		v >>= 7
	}
	return append(b, byte(v))
}
