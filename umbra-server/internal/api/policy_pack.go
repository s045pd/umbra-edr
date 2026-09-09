package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
)

// ServeChromePolicy is GET /ext/chrome-policy.json — CBCM / Windows policy blob.
func (c *crxAPI) ServeChromePolicy(w http.ResponseWriter, r *http.Request) {
	c.servePolicyJSON(w, r, "chrome")
}

// ServeEdgePolicy is GET /ext/edge-policy.json
func (c *crxAPI) ServeEdgePolicy(w http.ResponseWriter, r *http.Request) {
	c.servePolicyJSON(w, r, "edge")
}

// ServeChromePolicyREG is GET /ext/chrome-policy.reg
func (c *crxAPI) ServeChromePolicyREG(w http.ResponseWriter, r *http.Request) {
	if c.signer == nil {
		JSONErr(w, http.StatusServiceUnavailable, "extension signing not configured")
		return
	}
	publicBase := c.resolvePublicBase(r)
	extID := c.signer.ExtensionID()
	update := publicBase + "/ext/updates.xml"
	body := renderChromeREG(extID, update)
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="umbra-chrome-policy.reg"`)
	_, _ = w.Write([]byte(body))
}

func (c *crxAPI) servePolicyJSON(w http.ResponseWriter, r *http.Request, flavor string) {
	if c.signer == nil {
		JSONErr(w, http.StatusServiceUnavailable, "extension signing not configured")
		return
	}
	publicBase := c.resolvePublicBase(r)
	extID := c.signer.ExtensionID()
	update := publicBase + "/ext/updates.xml"
	doc := map[string]any{
		"QuicAllowed": false,
		"ExtensionInstallForcelist": []string{
			extID + ";" + update,
		},
		"ExtensionSettings": map[string]any{
			extID: map[string]any{
				"installation_mode":   "force_installed",
				"update_url":          update,
				"override_update_url": true,
			},
		},
		"BrowserSignin":              0,
		"SSLErrorOverrideAllowed":    false,
		"DeveloperToolsAvailability": 2,
	}
	if flavor == "edge" {
		doc["MicrosoftEdge"] = "policy pack for Edge — apply via HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge"
	}
	body, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		JSONErr(w, http.StatusInternalServerError, "marshal policy")
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(body)
}

func renderChromeREG(extID, updateURL string) string {
	forcelist := extID + ";" + updateURL
	return strings.Join([]string{
		"Windows Registry Editor Version 5.00",
		"",
		"; Umbra Sensor — Chrome Browser Cloud Management / ADMX equivalent.",
		"; Disables QUIC so the HTTPS forward proxy can intercept TLS.",
		"; Force-installs the signed Sensor CRX from this server.",
		"",
		`[HKEY_LOCAL_MACHINE\SOFTWARE\Policies\Google\Chrome]`,
		`"QuicAllowed"=dword:00000000`,
		"",
		`[HKEY_LOCAL_MACHINE\SOFTWARE\Policies\Google\Chrome\ExtensionInstallForcelist]`,
		fmt.Sprintf(`"1"="%s"`, forcelist),
		"",
	}, "\n")
}
