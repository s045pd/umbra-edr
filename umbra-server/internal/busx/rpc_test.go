package busx

import (
	"context"
	"encoding/json"
	"testing"
	"time"
)

func TestCallRemote_RoundTrip(t *testing.T) {
	bus := NewMemoryBus()
	defer bus.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	ready := make(chan struct{})
	go func() {
		sub, err := bus.Subscribe(ctx, ToBrowserChan("bot-1"))
		if err != nil {
			return
		}
		defer sub.Close()
		close(ready)
		select {
		case msg := <-sub.Channel():
			var frame RPCFrame
			if err := json.Unmarshal(msg.Payload, &frame); err != nil {
				return
			}
			reply := RPCFrame{ID: frame.ID, Kind: KindReply, Action: frame.Action, Data: []byte(`{"ok":true}`)}
			raw, _ := json.Marshal(reply)
			_ = bus.Publish(ctx, ToProxyChan("bot-1"), raw)
		case <-ctx.Done():
		}
	}()
	<-ready

	out, err := CallRemote(ctx, bus, "bot-1", "PING", map[string]any{"n": 1})
	if err != nil {
		t.Fatal(err)
	}
	if out["ok"] != true {
		t.Fatalf("out=%v", out)
	}
}

func TestCallRemote_Timeout(t *testing.T) {
	bus := NewMemoryBus()
	defer bus.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	_, err := CallRemote(ctx, bus, "missing", "PING", nil)
	if err == nil {
		t.Fatal("expected timeout")
	}
}

func TestCallRemote_RemoteError(t *testing.T) {
	bus := NewMemoryBus()
	defer bus.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	ready := make(chan struct{})
	go func() {
		sub, _ := bus.Subscribe(ctx, ToBrowserChan("bot-err"))
		defer sub.Close()
		close(ready)
		msg := <-sub.Channel()
		var frame RPCFrame
		_ = json.Unmarshal(msg.Payload, &frame)
		raw, _ := json.Marshal(RPCFrame{ID: frame.ID, Kind: KindReply, Error: "nope"})
		_ = bus.Publish(ctx, ToProxyChan("bot-err"), raw)
	}()
	<-ready
	_, err := CallRemote(ctx, bus, "bot-err", "X", nil)
	if err == nil || err.Error() != "nope" {
		t.Fatalf("err=%v", err)
	}
}
