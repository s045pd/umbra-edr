package live

import (
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestHub_PublishReachesSubscriber(t *testing.T) {
	t.Parallel()
	h := NewHub()
	bot := uuid.New()
	ch, cancel := h.Subscribe(bot)
	defer cancel()

	at := time.Now().UTC()
	h.Publish(bot, at)

	select {
	case frame := <-ch:
		if frame.BotID != bot {
			t.Fatalf("bot = %s, want %s", frame.BotID, bot)
		}
		if !frame.At.Equal(at) {
			t.Fatalf("at = %s, want %s", frame.At, at)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for frame")
	}
}

func TestHub_PublishDropsWhenBufferFull(t *testing.T) {
	t.Parallel()
	h := NewHub()
	bot := uuid.New()
	ch, cancel := h.Subscribe(bot)
	defer cancel()

	// Fill the 1-deep buffer then publish again — must not block.
	h.Publish(bot, time.Now())
	done := make(chan struct{})
	go func() {
		h.Publish(bot, time.Now())
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("publish blocked on full subscriber")
	}
	select {
	case <-ch:
	default:
		t.Fatal("expected at least one queued frame")
	}
}

func TestHub_UnsubscribeStopsDelivery(t *testing.T) {
	t.Parallel()
	h := NewHub()
	bot := uuid.New()
	ch, cancel := h.Subscribe(bot)
	cancel()
	h.Publish(bot, time.Now())
	select {
	case _, ok := <-ch:
		if ok {
			t.Fatal("expected closed channel")
		}
	case <-time.After(200 * time.Millisecond):
		t.Fatal("unsubscribe did not close channel")
	}
}
