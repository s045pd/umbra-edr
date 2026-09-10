package audiocodec

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"time"
)

var ErrNoFFmpeg = errors.New("ffmpeg not found")

func isWAV(raw []byte) bool {
	return len(raw) >= 12 && string(raw[0:4]) == "RIFF" && string(raw[8:12]) == "WAVE"
}

// ToWAV16k converts audio to 16 kHz mono PCM WAV for whisper.cpp.
// WAV input is returned as-is. WebM requires ffmpeg; MP3/OGG pass through
// when ffmpeg is missing because whisper-cli can decode those directly.
func ToWAV16k(raw []byte, maxSeconds int) ([]byte, error) {
	if len(raw) == 0 {
		return nil, nil
	}
	if isWAV(raw) {
		return raw, nil
	}
	bin, err := exec.LookPath("ffmpeg")
	if err != nil {
		if IsWebM(raw) {
			return nil, ErrNoFFmpeg
		}
		return raw, nil
	}
	in, err := os.CreateTemp("", "umbra-in-*")
	if err != nil {
		return nil, err
	}
	inPath := in.Name()
	defer func() { _ = os.Remove(inPath) }()
	if _, err := in.Write(raw); err != nil {
		_ = in.Close()
		return nil, err
	}
	if err := in.Close(); err != nil {
		return nil, err
	}
	out, err := os.CreateTemp("", "umbra-out-*.wav")
	if err != nil {
		return nil, err
	}
	outPath := out.Name()
	_ = out.Close()
	defer func() { _ = os.Remove(outPath) }()

	args := []string{"-hide_banner", "-loglevel", "error", "-y", "-i", inPath}
	if maxSeconds > 0 {
		args = append(args, "-t", strconv.Itoa(maxSeconds))
	}
	args = append(args, "-ac", "1", "-ar", "16000", "-f", "wav", outPath)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, args...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		if IsWebM(raw) {
			msg := stderr.String()
			if msg == "" {
				msg = err.Error()
			}
			return nil, fmt.Errorf("ffmpeg: %s", msg)
		}
		return raw, nil
	}
	return os.ReadFile(outPath)
}
