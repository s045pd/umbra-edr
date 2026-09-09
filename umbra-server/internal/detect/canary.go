package detect

import (
	"crypto/rand"
	"encoding/hex"
)

// CookieName is planted by the Sensor on visited HTTPS origins.
const CookieName = "__umbra_canary"

// Sighting is a canary cookie observed on an endpoint that does not own it.
type Sighting struct {
	Name   string
	Value  string
	Domain string
}

// NewToken returns a 128-bit hex canary.
func NewToken() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}

// ForeignCanary returns a canary cookie whose value is not selfToken.
func ForeignCanary(cookies []map[string]any, selfToken string) *Sighting {
	if selfToken == "" {
		return nil
	}
	for _, c := range cookies {
		name, _ := c["name"].(string)
		if name != CookieName {
			continue
		}
		val, _ := c["value"].(string)
		if val == "" || val == selfToken {
			continue
		}
		domain, _ := c["domain"].(string)
		return &Sighting{Name: name, Value: val, Domain: domain}
	}
	return nil
}

// LookupOwner returns the bot id that owns token, if any.
func LookupOwner(owners map[string]string, token string) string {
	if token == "" {
		return ""
	}
	return owners[token]
}
