package audiocodec

import "testing"

func TestIsWebM(t *testing.T) {
	if IsWebM(nil) || IsWebM([]byte("abcd")) {
		t.Fatal("rejected non-webm")
	}
	if !IsWebM([]byte{0x1a, 0x45, 0xdf, 0xa3, 0x00}) {
		t.Fatal("EBML header should be WebM")
	}
}

func TestCompactOpusPassthroughNonWebM(t *testing.T) {
	in := []byte("not a container")
	got, err := CompactOpus(in)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(in) {
		t.Fatalf("passthrough mutated non-webm input")
	}
}
