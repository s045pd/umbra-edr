// Package totp implements RFC 6238 TOTP (HMAC-SHA1, 30s) for operator 2FA.
package totp

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base32"
	"encoding/binary"
	"fmt"
	"net/url"
	"strings"
	"time"
)

const (
	DefaultDigits = 6
	DefaultPeriod = 30
)

// GenerateSecret returns a base32 secret (no padding) and the raw bytes.
func GenerateSecret() (encoded string, raw []byte, err error) {
	raw = make([]byte, 20)
	if _, err = rand.Read(raw); err != nil {
		return "", nil, err
	}
	encoded = base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(raw)
	return encoded, raw, nil
}

// DecodeSecret parses a base32 TOTP secret.
func DecodeSecret(encoded string) ([]byte, error) {
	s := strings.ToUpper(strings.ReplaceAll(strings.TrimSpace(encoded), " ", ""))
	s = strings.TrimRight(s, "=")
	return base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(s)
}

// Code computes the TOTP value for t.
func Code(secret []byte, t time.Time, digits, period int) string {
	if digits <= 0 {
		digits = DefaultDigits
	}
	if period <= 0 {
		period = DefaultPeriod
	}
	counter := uint64(t.Unix()) / uint64(period)
	var buf [8]byte
	binary.BigEndian.PutUint64(buf[:], counter)
	mac := hmac.New(sha1.New, secret)
	_, _ = mac.Write(buf[:])
	sum := mac.Sum(nil)
	offset := sum[len(sum)-1] & 0x0f
	bin := (int(sum[offset])&0x7f)<<24 |
		(int(sum[offset+1])&0xff)<<16 |
		(int(sum[offset+2])&0xff)<<8 |
		(int(sum[offset+3]) & 0xff)
	mod := 1
	for i := 0; i < digits; i++ {
		mod *= 10
	}
	return fmt.Sprintf("%0*d", digits, bin%mod)
}

// Validate reports whether code matches the current, previous, or next window.
func Validate(secret []byte, code string, now time.Time, digits, period int) bool {
	code = strings.TrimSpace(code)
	if code == "" {
		return false
	}
	if period <= 0 {
		period = DefaultPeriod
	}
	windows := []time.Time{now, now.Add(-time.Duration(period) * time.Second), now.Add(time.Duration(period) * time.Second)}
	for _, w := range windows {
		if hmac.Equal([]byte(Code(secret, w, digits, period)), []byte(code)) {
			return true
		}
	}
	return false
}

// OTPAuthURL builds an otpauth:// URI for authenticator apps.
func OTPAuthURL(issuer, account, secret string) string {
	return "otpauth://totp/" + issuer + ":" + account +
		"?secret=" + url.QueryEscape(secret) +
		"&issuer=" + url.QueryEscape(issuer) +
		"&algorithm=SHA1&digits=6&period=30"
}
