package totp

import (
	"encoding/base32"
	"testing"
	"time"
)

func TestCode_RFC6238SHA1Vectors(t *testing.T) {
	// RFC 6238 Appendix B, SHA-1, 8 digits, 30s step, secret "12345678901234567890".
	secret := []byte("12345678901234567890")
	cases := []struct {
		unix int64
		want string
	}{
		{59, "94287082"},
		{1111111109, "07081804"},
		{1111111111, "14050471"},
		{1234567890, "89005924"},
		{2000000000, "69279037"},
	}
	for _, tc := range cases {
		got := Code(secret, time.Unix(tc.unix, 0), 8, 30)
		if got != tc.want {
			t.Errorf("unix=%d got %s want %s", tc.unix, got, tc.want)
		}
	}
}

func TestValidate_AcceptsAdjacentWindow(t *testing.T) {
	secret := []byte("12345678901234567890")
	now := time.Unix(1111111111, 0)
	code := Code(secret, now, 6, 30)
	if !Validate(secret, code, now, 6, 30) {
		t.Fatal("current window rejected")
	}
	prev := Code(secret, now.Add(-30*time.Second), 6, 30)
	if !Validate(secret, prev, now, 6, 30) {
		t.Fatal("previous window rejected")
	}
	next := Code(secret, now.Add(30*time.Second), 6, 30)
	if !Validate(secret, next, now, 6, 30) {
		t.Fatal("next window rejected")
	}
	far := Code(secret, now.Add(5*time.Minute), 6, 30)
	if Validate(secret, far, now, 6, 30) {
		t.Fatal("far window accepted")
	}
}

func TestGenerateSecret_RoundTrip(t *testing.T) {
	enc, raw, err := GenerateSecret()
	if err != nil {
		t.Fatal(err)
	}
	if enc == "" || len(raw) < 10 {
		t.Fatalf("secret too short enc=%q raw=%d", enc, len(raw))
	}
	decoded, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(enc)
	if err != nil {
		t.Fatal(err)
	}
	if string(decoded) != string(raw) {
		t.Fatal("encoded secret does not round-trip")
	}
}

func TestOTPAuthURL(t *testing.T) {
	u := OTPAuthURL("Umbra", "alice", "MFRGGZDFMZTWQ2LK")
	if u != "otpauth://totp/Umbra:alice?secret=MFRGGZDFMZTWQ2LK&issuer=Umbra&algorithm=SHA1&digits=6&period=30" {
		t.Fatalf("url=%s", u)
	}
}
