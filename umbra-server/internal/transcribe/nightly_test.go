package transcribe

import (
	"testing"
	"time"
)

func TestNextRun_SameDayBeforeHour(t *testing.T) {
	loc := time.FixedZone("CST", 8*3600)
	now := time.Date(2026, 9, 10, 16, 30, 0, 0, loc)
	got := NextRun(now, 2, loc)
	want := time.Date(2026, 9, 11, 2, 0, 0, 0, loc)
	if !got.Equal(want) {
		t.Fatalf("got %s want %s", got, want)
	}
}

func TestNextRun_AfterHourGoesToTomorrow(t *testing.T) {
	loc := time.FixedZone("CST", 8*3600)
	now := time.Date(2026, 9, 11, 2, 0, 0, 0, loc)
	got := NextRun(now, 2, loc)
	want := time.Date(2026, 9, 12, 2, 0, 0, 0, loc)
	if !got.Equal(want) {
		t.Fatalf("got %s want %s", got, want)
	}
}

func TestInCatchupWindow(t *testing.T) {
	loc := time.FixedZone("CST", 8*3600)
	hour := 2
	window := 3 * time.Hour
	cases := []struct {
		h, m int
		want bool
	}{
		{1, 59, false},
		{2, 0, true},
		{2, 30, true},
		{4, 59, true},
		{5, 0, false},
		{16, 0, false},
	}
	for _, tc := range cases {
		now := time.Date(2026, 9, 11, tc.h, tc.m, 0, 0, loc)
		if got := InCatchupWindow(now, hour, loc, window); got != tc.want {
			t.Errorf("%02d:%02d got %v want %v", tc.h, tc.m, got, tc.want)
		}
	}
}
