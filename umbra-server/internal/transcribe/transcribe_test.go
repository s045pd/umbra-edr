package transcribe

import (
	"errors"
	"runtime"
	"testing"
)

func TestRunDisabled(t *testing.T) {
	_, err := Run("", []byte("x"))
	if !errors.Is(err, ErrDisabled) {
		t.Fatalf("err=%v, want ErrDisabled", err)
	}
}

func TestRunCat(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("cat")
	}
	got, err := Run("cat", []byte("hello world"))
	if err != nil {
		t.Fatal(err)
	}
	if got != "hello world" {
		t.Fatalf("got %q", got)
	}
}
