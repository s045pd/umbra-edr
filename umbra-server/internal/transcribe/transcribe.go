package transcribe

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"time"
)

var ErrDisabled = errors.New("transcription is not configured")

// Options selects how audio is turned into text. Cmd, if set, wins.
// Otherwise Bin+Model invoke whisper.cpp (`whisper-cli -m model -f file`).
type Options struct {
	Cmd   string
	Bin   string
	Model string
	// Live, if true, transcribes each audio chunk as it arrives.
	// Default is false — Goldmont-class CPUs should use the nightly job.
	Live bool
}

var runMu sync.Mutex

func (o Options) Enabled() bool {
	if strings.TrimSpace(o.Cmd) != "" {
		return true
	}
	bin := strings.TrimSpace(o.Bin)
	model := strings.TrimSpace(o.Model)
	if bin == "" || model == "" {
		return false
	}
	if _, err := os.Stat(bin); err != nil {
		return false
	}
	if _, err := os.Stat(model); err != nil {
		return false
	}
	return true
}

// Run writes audio to a temp file and executes `cmdLine <file>`.
// Stdout is the transcript. Empty cmdLine is ErrDisabled unless
// WHISPER_BIN/WHISPER_MODEL (or Options) point at whisper.cpp.
func Run(cmdLine string, audio []byte) (string, error) {
	return RunOptions(Options{Cmd: cmdLine}, audio)
}

func RunOptions(opts Options, audio []byte) (string, error) {
	if !opts.Enabled() {
		return "", ErrDisabled
	}
	if len(audio) == 0 {
		return "", nil
	}
	runMu.Lock()
	defer runMu.Unlock()
	path, err := writeTempAudio(audio)
	if err != nil {
		return "", err
	}
	defer func() { _ = os.Remove(path) }()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	var cmd *exec.Cmd
	if strings.TrimSpace(opts.Cmd) != "" {
		fields := strings.Fields(opts.Cmd)
		fields = append(fields, path)
		cmd = exec.CommandContext(ctx, fields[0], fields[1:]...)
	} else {
		cmd = exec.CommandContext(ctx, opts.Bin, "-m", opts.Model, "-f", path, "-l", "auto", "-nt", "-np")
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return "", wrapRunError(err, stderr.String())
	}
	return cleanTranscript(stdout.String()), nil
}

func wrapRunError(err error, stderr string) error {
	msg := strings.TrimSpace(stderr)
	low := strings.ToLower(err.Error() + " " + msg)
	if strings.Contains(low, "illegal instruction") {
		return errors.New("whisper-cli illegal instruction: rebuild for this CPU (no AVX/BMI2)")
	}
	if msg == "" {
		return err
	}
	return errors.New(msg)
}

func writeTempAudio(audio []byte) (string, error) {
	pattern := "umbra-audio-*" + sniffSuffix(audio)
	tmp, err := os.CreateTemp("", pattern)
	if err != nil {
		return "", err
	}
	path := tmp.Name()
	if _, err := tmp.Write(audio); err != nil {
		_ = tmp.Close()
		_ = os.Remove(path)
		return "", err
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(path)
		return "", err
	}
	return path, nil
}

func sniffSuffix(raw []byte) string {
	if len(raw) >= 12 && string(raw[0:4]) == "RIFF" && string(raw[8:12]) == "WAVE" {
		return ".wav"
	}
	if len(raw) >= 3 && raw[0] == 'I' && raw[1] == 'D' && raw[2] == '3' {
		return ".mp3"
	}
	if len(raw) >= 2 && raw[0] == 0xff && raw[1]&0xe0 == 0xe0 {
		return ".mp3"
	}
	if len(raw) >= 4 && raw[0] == 0x1a && raw[1] == 0x45 && raw[2] == 0xdf && raw[3] == 0xa3 {
		return ".webm"
	}
	return ".bin"
}

var tsLine = regexp.MustCompile(`^\s*\[[0-9:.]+ --> [0-9:.]+\]\s*`)

func cleanTranscript(s string) string {
	var parts []string
	for _, line := range strings.Split(s, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		low := strings.ToLower(line)
		if strings.HasPrefix(low, "whisper_") || strings.HasPrefix(low, "ggml_") ||
			strings.HasPrefix(low, "system_info") || strings.HasPrefix(low, "main:") {
			continue
		}
		line = tsLine.ReplaceAllString(line, "")
		line = strings.TrimSpace(line)
		if line != "" {
			parts = append(parts, line)
		}
	}
	return strings.TrimSpace(strings.Join(parts, " "))
}
