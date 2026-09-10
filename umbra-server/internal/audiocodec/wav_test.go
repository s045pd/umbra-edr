package audiocodec

import "testing"

func TestToWAV16k_PassthroughWav(t *testing.T) {
	in := []byte("RIFF....WAVEfmt ")
	got, err := ToWAV16k(in, 300)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(in) {
		t.Fatal("wav input should pass through")
	}
}

func TestToWAV16k_WebMWithoutFFmpegErrors(t *testing.T) {
	t.Setenv("PATH", "/nonexistent")
	webm := []byte{0x1a, 0x45, 0xdf, 0xa3, 0x00}
	_, err := ToWAV16k(webm, 300)
	if err == nil {
		t.Fatal("webm without ffmpeg should error")
	}
}
