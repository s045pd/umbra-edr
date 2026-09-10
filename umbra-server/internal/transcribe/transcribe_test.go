package transcribe

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestRunDisabled(t *testing.T) {
	_, err := Run("", []byte("x"))
	if !errors.Is(err, ErrDisabled) {
		t.Fatalf("err=%v, want ErrDisabled", err)
	}
	if (Options{}).Enabled() {
		t.Fatal("empty options should be disabled")
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

func TestCleanTranscript(t *testing.T) {
	in := "whisper_init: loading\n[00:00:00.000 --> 00:00:02.000]  你好\n[00:00:02.000 --> 00:00:04.000]  world\n"
	if got := cleanTranscript(in); got != "你好 world" {
		t.Fatalf("got %q", got)
	}
}

func TestWrapRunErrorSIGILL(t *testing.T) {
	err := wrapRunError(errors.New("signal: illegal instruction"), "")
	if err == nil || !strings.Contains(err.Error(), "rebuild for this CPU") {
		t.Fatalf("got %v", err)
	}
	err = wrapRunError(errors.New("exit status 1"), "model load failed")
	if err == nil || err.Error() != "model load failed" {
		t.Fatalf("got %v", err)
	}
}

func TestRunOptionsWhisperCLI(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("sh")
	}
	dir := t.TempDir()
	bin := filepath.Join(dir, "whisper-cli")
	model := filepath.Join(dir, "ggml-tiny.bin")
	if err := os.WriteFile(model, []byte("model"), 0o644); err != nil {
		t.Fatal(err)
	}
	script := "#!/bin/sh\necho '[00:00:00.000 --> 00:00:01.000]  hello there'\n"
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	got, err := RunOptions(Options{Bin: bin, Model: model}, []byte("RIFF....WAVE....pcm"))
	if err != nil {
		t.Fatal(err)
	}
	if got != "hello there" {
		t.Fatalf("got %q", got)
	}
}
