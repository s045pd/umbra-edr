package proxy

import (
	"bufio"
	"context"
	"crypto/tls"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"time"

	"gorm.io/gorm"

	"github.com/s045pd/umbra/internal/api"
)

// Server is the HTTP forward proxy.
type Server struct {
	DB     *gorm.DB
	RPC    api.BotRPC
	Logger *slog.Logger
	cache  *authCache
	// MITM signs leaf certs for HTTPS termination so HTTPS requests are
	// also forwarded via the bot. Optional — if nil we fall back to a
	// raw TCP tunnel direct from the proxy host (legacy behavior; the
	// bot is NOT used as the exit node in that fallback).
	MITM *MITM
}

// New creates a Server.
func New(gdb *gorm.DB, rpc api.BotRPC, logger *slog.Logger) *Server {
	return &Server{DB: gdb, RPC: rpc, Logger: logger, cache: newAuthCache()}
}

// Handler returns an http.Handler implementing the forward proxy.
func (s *Server) Handler() http.Handler {
	return http.HandlerFunc(s.serve)
}

func (s *Server) serve(w http.ResponseWriter, r *http.Request) {
	bot, err := authenticate(s.DB, s.cache, r.Header)
	if err != nil {
		w.Header().Set("Proxy-Authenticate", `Basic realm="umbra-proxy"`)
		http.Error(w, "Proxy Authentication Required", http.StatusProxyAuthRequired)
		return
	}

	if r.Method == http.MethodConnect {
		s.handleConnect(w, r, bot.BrowserID)
		return
	}
	s.handleHTTP(w, r, bot.BrowserID)
}

// handleHTTP forwards a regular request via the bot's browser.
func (s *Server) handleHTTP(w http.ResponseWriter, r *http.Request, browserID string) {
	bodyBytes, _ := io.ReadAll(io.LimitReader(r.Body, 32<<20))
	bodyB64 := base64.StdEncoding.EncodeToString(bodyBytes)

	headers := map[string]string{}
	for k, v := range r.Header {
		if isHopByHop(k) {
			continue
		}
		headers[k] = strings.Join(v, ", ")
	}

	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	resp, err := s.RPC.CallBot(ctx, browserID, "SEND_REQUEST_VIA_BROWSER", map[string]any{
		"method":  r.Method,
		"url":     fullURL(r),
		"headers": headers,
		"body":    bodyB64,
		// Tell the bot to send its own cookies on this fetch. Without
		// this the extension uses credentials:"omit" and the operator
		// effectively browses logged-out, defeating the whole point.
		"authenticated": true,
	})
	if err != nil {
		if errors.Is(err, api.ErrBotOffline) {
			http.Error(w, "Bot offline", http.StatusBadGateway)
			return
		}
		http.Error(w, err.Error(), http.StatusGatewayTimeout)
		return
	}

	// Bot reply shape: {status, headers{}, body(base64)}
	status, _ := resp["status"].(float64)
	if status == 0 {
		status = 200
	}
	if hdrs, ok := resp["headers"].(map[string]any); ok {
		for k, v := range hdrs {
			if isHopByHop(k) || strings.EqualFold(k, "content-encoding") {
				continue
			}
			w.Header().Set(k, fmt.Sprint(v))
		}
	}
	w.WriteHeader(int(status))
	if body, ok := resp["body"].(string); ok && body != "" {
		decoded, err := base64.StdEncoding.DecodeString(body)
		if err == nil {
			_, _ = w.Write(decoded)
		} else {
			_, _ = w.Write([]byte(body))
		}
	}
}

// handleConnect handles CONNECT (HTTPS).
//
// With MITM enabled (s.MITM != nil) we hijack the client TCP connection,
// answer 200 Connection established, then dynamically present a
// CA-signed certificate for the requested host so the browser believes
// it's talking to the real origin. The decrypted plaintext HTTP request
// flows through the same SEND_REQUEST_VIA_BROWSER RPC the cleartext
// path uses, meaning HTTPS now also goes through the bot's network and
// uses the bot's cookies.
//
// Without MITM (s.MITM == nil) we fall back to a raw TCP tunnel that
// goes directly from this proxy host to the upstream — the bot is
// NOT used. That's only useful as a stop-gap.
func (s *Server) handleConnect(w http.ResponseWriter, r *http.Request, browserID string) {
	hijacker, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "hijacking unsupported", http.StatusInternalServerError)
		return
	}
	clientConn, _, err := hijacker.Hijack()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	host := r.URL.Host
	if !strings.Contains(host, ":") {
		host += ":443"
	}

	if s.MITM == nil {
		s.tunnelDirect(clientConn, host)
		return
	}
	s.tunnelMITM(clientConn, host, browserID)
}

// tunnelDirect is the legacy fallback — just bridges TCP between the
// browser and the upstream host. Bot is not used.
func (s *Server) tunnelDirect(clientConn net.Conn, host string) {
	defer clientConn.Close()
	upstream, err := net.DialTimeout("tcp", host, 10*time.Second)
	if err != nil {
		_, _ = clientConn.Write([]byte("HTTP/1.1 502 Bad Gateway\r\n\r\n"))
		return
	}
	defer upstream.Close()
	_, _ = clientConn.Write([]byte("HTTP/1.1 200 Connection established\r\n\r\n"))
	tunnel(clientConn, upstream)
}

// tunnelMITM terminates TLS on our side, decrypts each HTTP request,
// and forwards it through the bot just like the cleartext path.
func (s *Server) tunnelMITM(clientConn net.Conn, hostport, browserID string) {
	defer clientConn.Close()

	if _, err := clientConn.Write([]byte("HTTP/1.1 200 Connection established\r\n\r\n")); err != nil {
		return
	}

	tlsConn := tls.Server(clientConn, s.MITM.TLSConfig())
	defer tlsConn.Close()

	if err := tlsConn.HandshakeContext(context.Background()); err != nil {
		s.logger().Warn("MITM handshake failed", "host", hostport, "err", err)
		return
	}

	// Strip :443 if present — RFC 7230 Host header carries no scheme.
	host := hostport
	if h, _, err := net.SplitHostPort(hostport); err == nil {
		host = h
	}

	br := bufio.NewReader(tlsConn)
	for {
		req, err := http.ReadRequest(br)
		if err != nil {
			if !errors.Is(err, io.EOF) {
				// Not an error worth shouting about — clients close mid-loop all the time.
				_ = err
			}
			return
		}
		// http.ReadRequest leaves URL.Host empty (it parses the
		// request-target relative to the client's TLS sniff). Patch
		// it back so handleHTTPS can build a proper https://… URL.
		req.URL.Scheme = "https"
		req.URL.Host = host
		if req.Host == "" {
			req.Host = host
		}
		s.handleHTTPS(tlsConn, req, browserID)
		// HTTP/1.1 keep-alive: clients often reuse the connection for
		// subsequent requests inside the same CONNECT tunnel. We loop
		// until the client closes or the request asks us to.
		if req.Close || strings.EqualFold(req.Header.Get("Connection"), "close") {
			return
		}
	}
}

// handleHTTPS is the MITM-side analogue of handleHTTP — same RPC, same
// payload, but the response is written back into the TLS conn directly
// because we can't use a normal http.ResponseWriter (we're not in the
// http.Server's hands anymore once CONNECT has hijacked).
func (s *Server) handleHTTPS(out net.Conn, r *http.Request, browserID string) {
	bodyBytes, _ := io.ReadAll(io.LimitReader(r.Body, 32<<20))
	_ = r.Body.Close()
	bodyB64 := base64.StdEncoding.EncodeToString(bodyBytes)

	headers := map[string]string{}
	for k, v := range r.Header {
		if isHopByHop(k) {
			continue
		}
		headers[k] = strings.Join(v, ", ")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	resp, err := s.RPC.CallBot(ctx, browserID, "SEND_REQUEST_VIA_BROWSER", map[string]any{
		"method":        r.Method,
		"url":           r.URL.String(),
		"headers":       headers,
		"body":          bodyB64,
		"authenticated": true,
	})
	if err != nil {
		writeHTTPError(out, http.StatusBadGateway, err.Error())
		return
	}

	status, _ := resp["status"].(float64)
	if status == 0 {
		status = 200
	}
	respHeaders := http.Header{}
	if hdrs, ok := resp["headers"].(map[string]any); ok {
		for k, v := range hdrs {
			if isHopByHop(k) || strings.EqualFold(k, "content-encoding") {
				continue
			}
			respHeaders.Set(k, fmt.Sprint(v))
		}
	}

	var body []byte
	if b, ok := resp["body"].(string); ok && b != "" {
		decoded, err := base64.StdEncoding.DecodeString(b)
		if err == nil {
			body = decoded
		} else {
			body = []byte(b)
		}
	}
	// Force keep-alive friendly framing — set Content-Length explicitly
	// so the client knows where this response ends and the next request
	// in the tunnel can start cleanly.
	respHeaders.Set("Content-Length", fmt.Sprintf("%d", len(body)))
	respHeaders.Set("Connection", "keep-alive")

	if _, err := fmt.Fprintf(out, "HTTP/1.1 %d %s\r\n", int(status), http.StatusText(int(status))); err != nil {
		return
	}
	if err := respHeaders.Write(out); err != nil {
		return
	}
	if _, err := out.Write([]byte("\r\n")); err != nil {
		return
	}
	_, _ = out.Write(body)
}

func writeHTTPError(out net.Conn, code int, msg string) {
	body := []byte(msg)
	fmt.Fprintf(out, "HTTP/1.1 %d %s\r\n", code, http.StatusText(code))
	fmt.Fprintf(out, "Content-Type: text/plain; charset=utf-8\r\n")
	fmt.Fprintf(out, "Content-Length: %d\r\n", len(body))
	fmt.Fprintf(out, "Connection: close\r\n\r\n")
	out.Write(body)
}

func tunnel(a, b net.Conn) {
	done := make(chan struct{}, 2)
	go func() { _, _ = io.Copy(a, b); done <- struct{}{} }()
	go func() { _, _ = io.Copy(b, a); done <- struct{}{} }()
	<-done
}

func fullURL(r *http.Request) string {
	if r.URL.IsAbs() {
		return r.URL.String()
	}
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	return scheme + "://" + r.Host + r.URL.RequestURI()
}

func isHopByHop(name string) bool {
	switch strings.ToLower(name) {
	case "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
		"te", "trailer", "transfer-encoding", "upgrade":
		return true
	}
	return false
}

// logger returns the configured logger or the slog default.
func (s *Server) logger() *slog.Logger {
	if s.Logger != nil {
		return s.Logger
	}
	return slog.Default()
}
