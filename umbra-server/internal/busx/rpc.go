package busx

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/google/uuid"
)

const (
	KindRequest = "req"
	KindReply   = "rep"
)

// RPCFrame is the JSON body published on TOBROWSER_ / TOPROXY_ channels.
type RPCFrame struct {
	ID     string          `json:"id"`
	Kind   string          `json:"kind"`
	Action string          `json:"action"`
	Data   json.RawMessage `json:"data,omitempty"`
	Error  string          `json:"error,omitempty"`
}

// CallRemote publishes an RPC request and waits for the matching reply.
// Used when the target bot's WebSocket lives on another process.
func CallRemote(ctx context.Context, bus Bus, browserID, action string, data map[string]any) (map[string]any, error) {
	if bus == nil {
		return nil, errors.New("bus not configured")
	}
	id := uuid.NewString()
	var raw json.RawMessage
	if data != nil {
		b, err := json.Marshal(data)
		if err != nil {
			return nil, err
		}
		raw = b
	}
	frame := RPCFrame{ID: id, Kind: KindRequest, Action: action, Data: raw}
	payload, err := json.Marshal(frame)
	if err != nil {
		return nil, err
	}
	sub, err := bus.Subscribe(ctx, ToProxyChan(browserID))
	if err != nil {
		return nil, err
	}
	defer sub.Close()
	if err := bus.Publish(ctx, ToBrowserChan(browserID), payload); err != nil {
		return nil, err
	}
	for {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case msg, ok := <-sub.Channel():
			if !ok {
				return nil, errors.New("bus subscription closed")
			}
			var reply RPCFrame
			if err := json.Unmarshal(msg.Payload, &reply); err != nil {
				continue
			}
			if reply.ID != id || reply.Kind != KindReply {
				continue
			}
			if reply.Error != "" {
				return nil, errors.New(reply.Error)
			}
			out := map[string]any{}
			if len(reply.Data) > 0 {
				if err := json.Unmarshal(reply.Data, &out); err != nil {
					return nil, fmt.Errorf("bad rpc reply: %w", err)
				}
			}
			return out, nil
		}
	}
}
