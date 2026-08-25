package proxy

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha1" //nolint:gosec // SHA-1 is fine for SubjectKeyId per RFC 5280 §4.2.1.2
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"fmt"
	"log/slog"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// MITM is the certificate authority used to terminate HTTPS at the
// forward proxy and feed plaintext to the bot via SEND_REQUEST_VIA_BROWSER.
//
// On startup it loads (or generates if missing) an RSA root CA pair from
// disk. For every CONNECT host the proxy sees it dynamically signs a
// short-lived ECDSA leaf certificate, cached so repeated visits to the
// same host are cheap.
//
// The user has to import the root CA into their browser/OS trust store
// once, otherwise the browser will refuse the leaf cert. The /api/v1/
// download_ca endpoint serves it.
type MITM struct {
	caCert    *x509.Certificate
	caCertDER []byte // raw bytes used for the leaf chain
	caKey     *rsa.PrivateKey

	leafKey *ecdsa.PrivateKey

	mu    sync.RWMutex
	cache map[string]*tls.Certificate

	logger *slog.Logger

	// Where the certs live on disk (so the API can serve the public
	// cert via download_ca).
	CertPath string
	KeyPath  string
}

// NewMITM ensures a usable CA pair exists at certPath/keyPath. If the
// files don't exist a fresh self-signed RSA-2048 CA is generated and
// written. A single ECDSA P-256 leaf key is generated in-memory and
// reused across all signed leaves (keys are cheap to share; what matters
// is the per-host certificate).
func NewMITM(certPath, keyPath string, logger *slog.Logger) (*MITM, error) {
	if logger == nil {
		logger = slog.Default()
	}

	m := &MITM{
		cache:    make(map[string]*tls.Certificate),
		logger:   logger,
		CertPath: certPath,
		KeyPath:  keyPath,
	}

	if err := os.MkdirAll(filepath.Dir(certPath), 0o755); err != nil {
		return nil, fmt.Errorf("mkdir ca dir: %w", err)
	}

	loaded, err := m.loadFromDisk()
	if err != nil {
		return nil, err
	}
	if !loaded {
		logger.Info("MITM CA not found, generating fresh root", "cert", certPath, "key", keyPath)
		if err := m.generateAndPersist(); err != nil {
			return nil, err
		}
	}

	leafKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("leaf key: %w", err)
	}
	m.leafKey = leafKey

	return m, nil
}

// loadFromDisk returns (loaded, err). loaded=false means no usable pair
// existed (and no error happened — caller should generate fresh).
func (m *MITM) loadFromDisk() (bool, error) {
	certBytes, err := os.ReadFile(m.CertPath)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("read ca cert: %w", err)
	}
	keyBytes, err := os.ReadFile(m.KeyPath)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("read ca key: %w", err)
	}

	certBlock, _ := pem.Decode(certBytes)
	if certBlock == nil || certBlock.Type != "CERTIFICATE" {
		return false, errors.New("ca cert: bad PEM")
	}
	cert, err := x509.ParseCertificate(certBlock.Bytes)
	if err != nil {
		return false, fmt.Errorf("parse ca cert: %w", err)
	}

	keyBlock, _ := pem.Decode(keyBytes)
	if keyBlock == nil {
		return false, errors.New("ca key: bad PEM")
	}
	var key *rsa.PrivateKey
	switch keyBlock.Type {
	case "RSA PRIVATE KEY":
		key, err = x509.ParsePKCS1PrivateKey(keyBlock.Bytes)
	case "PRIVATE KEY":
		anyKey, e := x509.ParsePKCS8PrivateKey(keyBlock.Bytes)
		if e != nil {
			return false, fmt.Errorf("parse ca key (pkcs8): %w", e)
		}
		var ok bool
		key, ok = anyKey.(*rsa.PrivateKey)
		if !ok {
			return false, errors.New("ca key is not RSA")
		}
	default:
		return false, fmt.Errorf("ca key: unexpected PEM type %q", keyBlock.Type)
	}
	if err != nil {
		return false, fmt.Errorf("parse ca key: %w", err)
	}

	m.caCert = cert
	m.caCertDER = certBlock.Bytes
	m.caKey = key
	return true, nil
}

// generateAndPersist creates a fresh root CA and writes both PEM files.
func (m *MITM) generateAndPersist() error {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return fmt.Errorf("gen ca key: %w", err)
	}

	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return fmt.Errorf("ca serial: %w", err)
	}

	pubBytes, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		return fmt.Errorf("ca pub: %w", err)
	}
	skid := sha1.Sum(pubBytes) //nolint:gosec // RFC 5280 SubjectKeyId hash

	tmpl := &x509.Certificate{
		SerialNumber: serial,
		Subject: pkix.Name{
			Organization: []string{"Umbra MITM"},
			CommonName:   "Umbra MITM Root CA",
		},
		NotBefore:             time.Now().Add(-1 * time.Hour),
		NotAfter:              time.Now().AddDate(10, 0, 0),
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign | x509.KeyUsageDigitalSignature,
		BasicConstraintsValid: true,
		IsCA:                  true,
		MaxPathLen:            1,
		MaxPathLenZero:        false,
		SubjectKeyId:          skid[:],
	}

	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		return fmt.Errorf("self-sign ca: %w", err)
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		return fmt.Errorf("parse new ca: %w", err)
	}

	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	if err := os.WriteFile(m.CertPath, certPEM, 0o644); err != nil { //nolint:gosec // public cert
		return fmt.Errorf("write ca cert: %w", err)
	}

	keyDER := x509.MarshalPKCS1PrivateKey(key)
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: keyDER})
	if err := os.WriteFile(m.KeyPath, keyPEM, 0o600); err != nil {
		return fmt.Errorf("write ca key: %w", err)
	}

	m.caCert = cert
	m.caCertDER = der
	m.caKey = key
	return nil
}

// CertForHost returns a tls.Certificate signed by our CA whose SAN
// covers `host`. Caches per host so repeat visits are O(1).
func (m *MITM) CertForHost(host string) (*tls.Certificate, error) {
	// Strip any port the caller carried over.
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}

	m.mu.RLock()
	if c, ok := m.cache[host]; ok {
		m.mu.RUnlock()
		return c, nil
	}
	m.mu.RUnlock()

	cert, err := m.signLeaf(host)
	if err != nil {
		return nil, err
	}

	m.mu.Lock()
	m.cache[host] = cert
	m.mu.Unlock()
	return cert, nil
}

func (m *MITM) signLeaf(host string) (*tls.Certificate, error) {
	if m.caCert == nil || m.caKey == nil || m.leafKey == nil {
		return nil, errors.New("MITM: not initialized")
	}

	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return nil, fmt.Errorf("leaf serial: %w", err)
	}

	tmpl := &x509.Certificate{
		SerialNumber: serial,
		Subject: pkix.Name{
			CommonName: host,
		},
		NotBefore:             time.Now().Add(-1 * time.Hour),
		NotAfter:              time.Now().AddDate(1, 0, 0),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
	}
	if ip := net.ParseIP(host); ip != nil {
		tmpl.IPAddresses = []net.IP{ip}
	} else {
		tmpl.DNSNames = []string{host}
	}

	der, err := x509.CreateCertificate(rand.Reader, tmpl, m.caCert, &m.leafKey.PublicKey, m.caKey)
	if err != nil {
		return nil, fmt.Errorf("sign leaf: %w", err)
	}

	return &tls.Certificate{
		Certificate: [][]byte{der, m.caCertDER},
		PrivateKey:  m.leafKey,
		Leaf:        nil,
	}, nil
}

// TLSConfig returns a *tls.Config whose GetCertificate dispatches to
// the leaf cache. Callers wrap the hijacked client conn with this.
func (m *MITM) TLSConfig() *tls.Config {
	return &tls.Config{
		MinVersion: tls.VersionTLS12,
		GetCertificate: func(hello *tls.ClientHelloInfo) (*tls.Certificate, error) {
			host := hello.ServerName
			if host == "" {
				host = "localhost"
			}
			return m.CertForHost(host)
		},
	}
}
