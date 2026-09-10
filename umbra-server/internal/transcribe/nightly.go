package transcribe

import "time"

// NextRun is the next local clock time at hour:00. If `now` is already at
// or past that hour today, it returns tomorrow.
func NextRun(now time.Time, hour int, loc *time.Location) time.Time {
	if loc == nil {
		loc = time.UTC
	}
	if hour < 0 || hour > 23 {
		hour = 2
	}
	now = now.In(loc)
	next := time.Date(now.Year(), now.Month(), now.Day(), hour, 0, 0, 0, loc)
	if !now.Before(next) {
		next = next.Add(24 * time.Hour)
	}
	return next
}

// InCatchupWindow is true when local time is in [hour:00, hour:00+window).
func InCatchupWindow(now time.Time, hour int, loc *time.Location, window time.Duration) bool {
	if loc == nil {
		loc = time.UTC
	}
	if window <= 0 {
		window = 3 * time.Hour
	}
	now = now.In(loc)
	start := time.Date(now.Year(), now.Month(), now.Day(), hour, 0, 0, 0, loc)
	end := start.Add(window)
	return !now.Before(start) && now.Before(end)
}
