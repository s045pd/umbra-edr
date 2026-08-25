package api

import (
	"encoding/binary"
	"encoding/xml"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/s045pd/umbra/internal/crxsign"
)

// stageExtensionSrc lays out a minimal extension/main directory tree under
// a temp dir, mirroring the on-disk layout the production code reads.
// Returns the base path that ExtensionAPI.SourcePath should be pointed at.
func stageExtensionSrc(t *testing.T, version string) string {
	t.Helper()
	base := t.TempDir()
	mainDir := filepath.Join(base, "main")
	if err := os.MkdirAll(mainDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	manifest := `{
  "name": "Umbra Sensor Test",
  "version": "` + version + `",
  "manifest_version": 3,
  "background": {"service_worker": "src/bg/background.js"}
}`
	if err := os.WriteFile(filepath.Join(mainDir, "manifest.json"), []byte(manifest), 0o644); err != nil {
		t.Fatalf("write manifest: %v", err)
	}
	bgDir := filepath.Join(mainDir, "src", "bg")
	if err := os.MkdirAll(bgDir, 0o755); err != nil {
		t.Fatalf("mkdir bg: %v", err)
	}
	bg := []byte("const WS = 'ws://127.0.0.1:4343';\nconsole.log(WS);\n")
	if err := os.WriteFile(filepath.Join(bgDir, "background.js"), bg, 0o644); err != nil {
		t.Fatalf("write bg: %v", err)
	}
	return base
}

func newTestExtensionAPI(t *testing.T, version, publicURL string) *ExtensionAPI {
	t.Helper()
	keyPath := filepath.Join(t.TempDir(), "extkey.pem")
	signer, err := crxsign.LoadOrGenerate(keyPath)
	if err != nil {
		t.Fatalf("signer: %v", err)
	}
	return &ExtensionAPI{
		SourcePath: stageExtensionSrc(t, version),
		Signer:     signer,
		PublicURL:  publicURL,
	}
}

func TestServeUpdatesXML_HasIDAndCRXURL(t *testing.T) {
	t.Parallel()
	api := newTestExtensionAPI(t, "0.4.2", "https://umbra.example.test")

	rr := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/ext/updates.xml", nil)
	api.ServeUpdatesXML(rr, req)

	if rr.Code != 200 {
		t.Fatalf("status = %d, want 200", rr.Code)
	}
	if ct := rr.Header().Get("Content-Type"); !strings.HasPrefix(ct, "application/xml") {
		t.Fatalf("Content-Type = %q", ct)
	}

	var doc struct {
		XMLName xml.Name `xml:"gupdate"`
		App     struct {
			AppID       string `xml:"appid,attr"`
			UpdateCheck struct {
				Codebase string `xml:"codebase,attr"`
				Version  string `xml:"version,attr"`
			} `xml:"updatecheck"`
		} `xml:"app"`
	}
	if err := xml.Unmarshal(rr.Body.Bytes(), &doc); err != nil {
		t.Fatalf("unmarshal: %v\nbody:\n%s", err, rr.Body.String())
	}

	if got := len(doc.App.AppID); got != 32 {
		t.Fatalf("appid len = %d, want 32 (a-p chars)", got)
	}
	if doc.App.AppID != api.Signer.ExtensionID() {
		t.Fatalf("appid = %q, signer = %q", doc.App.AppID, api.Signer.ExtensionID())
	}
	if want := "https://umbra.example.test/ext/umbra-sensor.crx"; doc.App.UpdateCheck.Codebase != want {
		t.Fatalf("codebase = %q, want %q", doc.App.UpdateCheck.Codebase, want)
	}
	if doc.App.UpdateCheck.Version != "0.4.2" {
		t.Fatalf("version = %q, want %q", doc.App.UpdateCheck.Version, "0.4.2")
	}
}

func TestServeCRX_ReturnsValidCRX3(t *testing.T) {
	t.Parallel()
	api := newTestExtensionAPI(t, "1.0.0", "https://umbra.example.test")

	rr := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/ext/umbra-sensor.crx", nil)
	api.ServeCRX(rr, req)

	if rr.Code != 200 {
		t.Fatalf("status = %d, body = %s", rr.Code, rr.Body.String())
	}
	if got := rr.Header().Get("Content-Type"); got != "application/x-chrome-extension" {
		t.Fatalf("Content-Type = %q", got)
	}

	body := rr.Body.Bytes()
	if len(body) < 12 || string(body[:4]) != "Cr24" {
		t.Fatalf("missing CRX magic: % x", body[:min(8, len(body))])
	}
	if v := binary.LittleEndian.Uint32(body[4:8]); v != 3 {
		t.Fatalf("version = %d, want 3", v)
	}
}

func TestServeCRX_CachesAcrossRequests(t *testing.T) {
	t.Parallel()
	api := newTestExtensionAPI(t, "1.0.0", "https://umbra.example.test")

	rr1 := httptest.NewRecorder()
	api.ServeCRX(rr1, httptest.NewRequest("GET", "/ext/umbra-sensor.crx", nil))
	rr2 := httptest.NewRecorder()
	api.ServeCRX(rr2, httptest.NewRequest("GET", "/ext/umbra-sensor.crx", nil))

	if rr1.Body.Len() == 0 || rr2.Body.Len() == 0 {
		t.Fatal("empty body")
	}
	// Cache hit means identical CRX bytes; obfuscation is off in
	// this code path so this is a tight equality check.
	if !bytesEqual(rr1.Body.Bytes(), rr2.Body.Bytes()) {
		t.Fatal("CRX bytes differ across requests; cache not engaged")
	}
}

func TestServeInstallEdgeBAT_BakesIDAndURL(t *testing.T) {
	t.Parallel()
	api := newTestExtensionAPI(t, "1.0.0", "https://umbra.example.test")

	rr := httptest.NewRecorder()
	api.ServeInstallEdgeBAT(rr, httptest.NewRequest("GET", "/ext/install-edge.bat", nil))

	if rr.Code != 200 {
		t.Fatalf("status = %d", rr.Code)
	}
	body := rr.Body.String()
	if !strings.Contains(body, api.Signer.ExtensionID()) {
		t.Fatal("BAT does not contain extension id")
	}
	if !strings.Contains(body, "https://umbra.example.test/ext/updates.xml") {
		t.Fatal("BAT does not contain updates.xml URL")
	}
	if !strings.Contains(body, `HKLM\Software\Policies\Microsoft\Edge\ExtensionInstallForcelist`) {
		t.Fatal("BAT missing Edge force-install registry path")
	}
	if !strings.Contains(body, "Start-Process -Verb RunAs") {
		t.Fatal("BAT missing UAC self-elevation block")
	}
}

func TestServeUpdatesXML_503WithoutSigner(t *testing.T) {
	t.Parallel()
	api := &ExtensionAPI{} // no signer

	rr := httptest.NewRecorder()
	api.ServeUpdatesXML(rr, httptest.NewRequest("GET", "/ext/updates.xml", nil))
	if rr.Code != 503 {
		t.Fatalf("status = %d, want 503", rr.Code)
	}
}

func bytesEqual(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
