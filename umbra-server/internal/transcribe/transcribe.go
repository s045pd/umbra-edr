package transcribe

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"strings"
	"time"
)

var ErrDisabled = errors.New("transcription is not configured")

// Run writes audio to a temp file and executes `cmdLine <file>`.
// Stdout is the transcript. Empty cmdLine is ErrDisabled.
func Run(cmdLine string, audio []byte) (string, error) {
	cmdLine = strings.TrimSpace(cmdLine)
	if cmdLine == "" {
		return "", ErrDisabled
	}
	if len(audio) == 0 {
		return "", nil
	}
	tmp, err := os.CreateTemp("", "umbra-audio-*.webm")
	if err != nil {
		return "", err
	}
	path := tmp.Name()
	defer func() { _ = os.Remove(path) }()
	if _, err := tmp.Write(audio); err != nil {
		_ = tmp.Close()
		return "", err
	}
	if err := tmp.Close(); err != nil {
		return "", err
	}

	fields := strings.Fields(cmdLine)
	fields = append(fields, path)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, fields[0], fields[1:]...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
		return "", errors.New(msg)
	}
	return strings.TrimSpace(stdout.String()), nil
}
