package audiocodec

import (
	"bytes"
	"os"
	"os/exec"
	"sync"
)

const (
	// Fullband Opus: high-fidelity speech/ambient at a fraction of PCM size.
	OpusBitrate = "96k"
)

var (
	ffmpegOnce sync.Once
	ffmpegPath string
)

func FFmpegPath() string {
	ffmpegOnce.Do(func() {
		ffmpegPath, _ = exec.LookPath("ffmpeg")
	})
	return ffmpegPath
}

func IsWebM(raw []byte) bool {
	return len(raw) >= 4 && raw[0] == 0x1a && raw[1] == 0x45 && raw[2] == 0xdf && raw[3] == 0xa3
}

// CompactOpus remuxes a WebM MediaRecorder dump into a single mono Opus
// stream. Non-WebM input or a missing ffmpeg binary is returned unchanged.
func CompactOpus(raw []byte) ([]byte, error) {
	if len(raw) == 0 || !IsWebM(raw) {
		return raw, nil
	}
	bin := FFmpegPath()
	if bin == "" {
		return raw, nil
	}
	in, err := os.CreateTemp("", "umbra-in-*.webm")
	if err != nil {
		return raw, err
	}
	inPath := in.Name()
	defer func() { _ = os.Remove(inPath) }()
	if _, err := in.Write(raw); err != nil {
		_ = in.Close()
		return raw, err
	}
	if err := in.Close(); err != nil {
		return raw, err
	}
	out, err := os.CreateTemp("", "umbra-out-*.webm")
	if err != nil {
		return raw, err
	}
	outPath := out.Name()
	_ = out.Close()
	defer func() { _ = os.Remove(outPath) }()

	cmd := exec.Command(bin,
		"-hide_banner", "-loglevel", "error", "-y",
		"-i", inPath,
		"-map", "0:a:0",
		"-c:a", "libopus",
		"-b:a", OpusBitrate,
		"-vbr", "on",
		"-application", "audio",
		"-ac", "1",
		"-ar", "48000",
		"-f", "webm",
		outPath,
	)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return raw, nil
	}
	compacted, err := os.ReadFile(outPath)
	if err != nil || len(compacted) == 0 || !IsWebM(compacted) {
		return raw, nil
	}
	return compacted, nil
}
