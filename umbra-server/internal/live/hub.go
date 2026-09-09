// Package live fans REALTIME_IMG ticks out to operator SSE subscribers.
package live

import (
	"sync"
	"time"

	"github.com/google/uuid"
)

// Frame is a lightweight notice that a bot has a fresh thumbnail.
// Subscribers refetch the image bytes themselves so the hub never
// copies base64 screenshots.
type Frame struct {
	BotID uuid.UUID
	At    time.Time
}

// Hub is an in-process pub/sub. Safe for concurrent use. A nil Hub
// is a no-op so tests and smoke mode need no extra wiring.
type Hub struct {
	mu   sync.Mutex
	subs map[uuid.UUID]map[chan Frame]struct{}
}

func NewHub() *Hub {
	return &Hub{subs: make(map[uuid.UUID]map[chan Frame]struct{})}
}

// Subscribe receives subsequent Publish calls for botID. The returned
// cancel function must be called to avoid leaking the buffer.
func (h *Hub) Subscribe(botID uuid.UUID) (<-chan Frame, func()) {
	if h == nil {
		ch := make(chan Frame)
		close(ch)
		return ch, func() {}
	}
	ch := make(chan Frame, 1)
	h.mu.Lock()
	if h.subs[botID] == nil {
		h.subs[botID] = make(map[chan Frame]struct{})
	}
	h.subs[botID][ch] = struct{}{}
	h.mu.Unlock()
	var once sync.Once
	cancel := func() {
		once.Do(func() {
			h.mu.Lock()
			if set, ok := h.subs[botID]; ok {
				delete(set, ch)
				if len(set) == 0 {
					delete(h.subs, botID)
				}
			}
			h.mu.Unlock()
			close(ch)
		})
	}
	return ch, cancel
}

// Publish delivers a frame to every current subscriber of botID.
// Slow subscribers are skipped rather than stalling the sensor path.
func (h *Hub) Publish(botID uuid.UUID, at time.Time) {
	if h == nil {
		return
	}
	frame := Frame{BotID: botID, At: at}
	h.mu.Lock()
	defer h.mu.Unlock()
	for ch := range h.subs[botID] {
		select {
		case ch <- frame:
		default:
		}
	}
}
