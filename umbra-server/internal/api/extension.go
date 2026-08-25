package api

import (
	"archive/zip"
	"bytes"
	crand "crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/s045pd/umbra/internal/crxsign"
)

const (
	defaultExtSrcPath = "/work/extensions"
	wsPlaceholder     = `ws://127.0.0.1:4343`
)

type ExtensionAPI struct {
	SourcePath string
	// Signer is the persistent ECDSA P-256 key used to build CRX v3
	// packages for the public auto-install endpoints. nil means the
	// /ext/* endpoints will respond 503 (e.g. SKIP_DB smoke mode).
	Signer    *crxsign.Signer
	PublicURL string

	crxOnce sync.Once
	crx     *crxAPI
}

// crxHandler lazily wires the CRX sub-handler to this ExtensionAPI's
// configured source path / signer / public URL.
func (e *ExtensionAPI) crxHandler() *crxAPI {
	e.crxOnce.Do(func() {
		e.crx = &crxAPI{
			signer:     e.Signer,
			sourcePath: e.basePath,
			publicURL:  e.PublicURL,
		}
	})
	return e.crx
}

// ServeUpdatesXML / ServeCRX / ServeInstallEdgeBAT are the public
// auto-install endpoints; they delegate to the cached crxAPI.
func (e *ExtensionAPI) ServeUpdatesXML(w http.ResponseWriter, r *http.Request) {
	e.crxHandler().ServeUpdatesXML(w, r)
}
func (e *ExtensionAPI) ServeCRX(w http.ResponseWriter, r *http.Request) {
	e.crxHandler().ServeCRX(w, r)
}
func (e *ExtensionAPI) ServeInstallEdgeBAT(w http.ResponseWriter, r *http.Request) {
	e.crxHandler().ServeInstallEdgeBAT(w, r)
}

func (e *ExtensionAPI) basePath() string {
	if e.SourcePath != "" {
		return e.SourcePath
	}
	if p := os.Getenv("EXTENSION_SRC_PATH"); p != "" {
		return p
	}
	if _, err := os.Stat(filepath.Join(defaultExtSrcPath, "main")); err == nil {
		return defaultExtSrcPath
	}
	if dir := devExtPath(); dir != "" {
		return dir
	}
	return defaultExtSrcPath
}

func devExtPath() string {
	var roots []string
	if exe, err := os.Executable(); err == nil {
		roots = append(roots, filepath.Dir(exe))
	}
	if wd, err := os.Getwd(); err == nil {
		roots = append(roots, wd)
	}
	for _, root := range roots {
		dir := root
		for range 6 {
			extDir := filepath.Join(dir, "extension")
			if info, err := os.Stat(extDir); err == nil && info.IsDir() {
				return ensureDevLinks(dir, extDir)
			}
			parent := filepath.Dir(dir)
			if parent == dir {
				break
			}
			dir = parent
		}
	}
	return ""
}

func ensureDevLinks(repoRoot, extDir string) string {
	synthDir := filepath.Join(repoRoot, ".extensions-dev")
	mainLink := filepath.Join(synthDir, "main")
	absExt, _ := filepath.Abs(extDir)
	if target, err := os.Readlink(mainLink); err == nil {
		if abs, _ := filepath.Abs(target); abs == absExt {
			return synthDir
		}
	}
	os.MkdirAll(synthDir, 0o755)
	os.Remove(mainLink)
	if err := os.Symlink(absExt, mainLink); err != nil {
		return ""
	}
	csDir := filepath.Join(repoRoot, "cookie-sync-extension")
	csLink := filepath.Join(synthDir, "cookie-sync")
	if info, err := os.Stat(csDir); err == nil && info.IsDir() {
		os.Remove(csLink)
		os.Symlink(filepath.Clean(csDir), csLink)
	}
	return synthDir
}

type embedTarget struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

func (e *ExtensionAPI) ListEmbedTargets(w http.ResponseWriter, _ *http.Request) {
	base := e.basePath()
	entries, err := os.ReadDir(base)
	if err != nil {
		JSONOK(w, []embedTarget{})
		return
	}

	excluded := map[string]bool{"main": true, "cookie-sync": true}

	var targets []embedTarget
	for _, ent := range entries {
		if excluded[ent.Name()] {
			continue
		}
		resolved, rErr := filepath.EvalSymlinks(filepath.Join(base, ent.Name()))
		if rErr != nil {
			continue
		}
		info, sErr := os.Stat(resolved)
		if sErr != nil || !info.IsDir() {
			continue
		}
		mf := filepath.Join(resolved, "manifest.json")
		if _, err := os.Stat(mf); err != nil {
			continue
		}
		raw, _ := os.ReadFile(mf)
		var m map[string]interface{}
		if json.Unmarshal(raw, &m) != nil {
			continue
		}
		name, _ := m["name"].(string)
		if name == "" {
			name = ent.Name()
		}
		targets = append(targets, embedTarget{ID: ent.Name(), Name: name})
	}
	JSONOK(w, targets)
}

func (e *ExtensionAPI) Download(w http.ResponseWriter, r *http.Request) {
	wsURL := r.URL.Query().Get("ws_url")
	embed := r.URL.Query().Get("embed")
	obfuscate := r.URL.Query().Get("obfuscate") == "1"

	if wsURL == "" {
		host := r.Host
		if idx := strings.Index(host, ":"); idx != -1 {
			host = host[:idx]
		}
		wsURL = fmt.Sprintf("wss://%s:4343", host)
	}

	base := e.basePath()
	mainDir, err := filepath.EvalSymlinks(filepath.Join(base, "main"))
	if err != nil {
		JSONErr(w, http.StatusNotFound, "extension source not found")
		return
	}

	buf := new(bytes.Buffer)
	zw := zip.NewWriter(buf)

	var buildErr error
	filename := "umbra-extension.zip"

	opts := &buildOpts{wsURL: wsURL, obfuscate: obfuscate}
	if obfuscate {
		b := make([]byte, 16)
		crand.Read(b)
		opts.seed = hex.EncodeToString(b)
	}

	if embed == "cookie-sync" {
		csDir, csErr := filepath.EvalSymlinks(filepath.Join(base, "cookie-sync"))
		if csErr != nil {
			JSONErr(w, http.StatusNotFound, "cookie-sync extension not found")
			return
		}
		buildErr = buildPlain(zw, csDir)
		filename = "cookie-sync-extension.zip"
	} else if embed != "" && embed != "none" {
		targetDir, tErr := filepath.EvalSymlinks(filepath.Join(base, embed))
		if tErr != nil {
			JSONErr(w, http.StatusBadRequest, fmt.Sprintf("embed target %q not found", embed))
			return
		}
		buildErr = buildMerged(zw, mainDir, targetDir, opts)
		filename = fmt.Sprintf("umbra-%s-extension.zip", embed)
	} else {
		buildErr = buildStandalone(zw, mainDir, opts)
	}

	if buildErr != nil {
		JSONErr(w, http.StatusInternalServerError, buildErr.Error())
		return
	}
	zw.Close()

	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, filename))
	w.Header().Set("Content-Length", fmt.Sprintf("%d", buf.Len()))
	w.Write(buf.Bytes())
}

type buildOpts struct {
	wsURL      string
	obfuscate  bool
	seed       string
	sourceType string // "module" or "script"
}

func buildPlain(zw *zip.Writer, srcDir string) error {
	return filepath.WalkDir(srcDir, func(path string, de fs.DirEntry, err error) error {
		if err != nil || de.IsDir() {
			return err
		}
		rel, _ := filepath.Rel(srcDir, path)
		if skipExtensionPackageFile(rel) {
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		fw, err := zw.Create(rel)
		if err != nil {
			return err
		}
		_, err = fw.Write(data)
		return err
	})
}

func skipJunk(name string) bool {
	base := filepath.Base(name)
	return strings.HasPrefix(base, "._") || base == ".DS_Store"
}

// skipExtensionPackageFile excludes development/test metadata while retaining
// all runtime source trees (including nested snapshot helpers).
func skipExtensionPackageFile(name string) bool {
	if skipJunk(name) {
		return true
	}
	clean := filepath.ToSlash(filepath.Clean(name))
	first := strings.SplitN(clean, "/", 2)[0]
	if first == "test" || first == "tests" || first == "node_modules" || first == ".git" {
		return true
	}
	switch filepath.Base(clean) {
	case "package.json", "package-lock.json", "npm-shrinkwrap.json":
		return true
	default:
		return false
	}
}

func buildStandalone(zw *zip.Writer, srcDir string, opts *buildOpts) error {
	return filepath.WalkDir(srcDir, func(path string, de fs.DirEntry, err error) error {
		if err != nil || de.IsDir() {
			return err
		}
		rel, _ := filepath.Rel(srcDir, path)
		if skipExtensionPackageFile(rel) {
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		if strings.HasSuffix(rel, ".js") {
			data = bytes.ReplaceAll(data, []byte(wsPlaceholder), []byte(opts.wsURL))
			if opts.obfuscate {
				data = obfuscateJS(data, opts.seed, detectSourceType(data))
			}
		}
		fw, err := zw.Create(rel)
		if err != nil {
			return err
		}
		_, err = fw.Write(data)
		return err
	})
}

func buildMerged(zw *zip.Writer, mainDir, targetDir string, opts *buildOpts) error {
	targetManifest, err := readManifest(targetDir)
	if err != nil {
		return fmt.Errorf("read target manifest: %w", err)
	}
	mainManifest, err := readManifest(mainDir)
	if err != nil {
		return fmt.Errorf("read main manifest: %w", err)
	}

	merged := mergeManifests(targetManifest, mainManifest)

	if err := filepath.WalkDir(targetDir, func(path string, de fs.DirEntry, err error) error {
		if err != nil || de.IsDir() {
			return err
		}
		rel, _ := filepath.Rel(targetDir, path)
		if rel == "manifest.json" || skipJunk(rel) {
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		fw, err := zw.Create(rel)
		if err != nil {
			return err
		}
		_, err = fw.Write(data)
		return err
	}); err != nil {
		return fmt.Errorf("package target extension: %w", err)
	}

	if err := filepath.WalkDir(mainDir, func(path string, de fs.DirEntry, err error) error {
		if err != nil || de.IsDir() {
			return err
		}
		rel, _ := filepath.Rel(mainDir, path)
		if rel == "manifest.json" || skipExtensionPackageFile(rel) {
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		if strings.HasSuffix(rel, ".js") {
			data = bytes.ReplaceAll(data, []byte(wsPlaceholder), []byte(opts.wsURL))
			if opts.obfuscate {
				data = obfuscateJS(data, opts.seed, detectSourceType(data))
			}
		}
		fw, err := zw.Create("_umbra/" + filepath.ToSlash(rel))
		if err != nil {
			return err
		}
		_, err = fw.Write(data)
		return err
	}); err != nil {
		return fmt.Errorf("package Sensor extension: %w", err)
	}

	origSW, _ := targetManifest["background"].(map[string]interface{})
	origSWFile, _ := origSW["service_worker"].(string)
	swType, _ := origSW["type"].(string)

	wrapperCode := buildServiceWorkerWrapper(origSWFile, swType)
	newBg := map[string]interface{}{
		"service_worker": "_umbra_sw.js",
	}
	if swType != "" {
		newBg["type"] = swType
	}
	merged["background"] = newBg

	fw, err := zw.Create("_umbra_sw.js")
	if err != nil {
		return err
	}
	if _, err := fw.Write([]byte(wrapperCode)); err != nil {
		return err
	}

	manifestJSON, err := json.MarshalIndent(merged, "", "  ")
	if err != nil {
		return err
	}
	fw2, err := zw.Create("manifest.json")
	if err != nil {
		return err
	}
	if _, err := fw2.Write(manifestJSON); err != nil {
		return err
	}

	return nil
}

func readManifest(dir string) (map[string]interface{}, error) {
	data, err := os.ReadFile(filepath.Join(dir, "manifest.json"))
	if err != nil {
		return nil, err
	}
	var m map[string]interface{}
	return m, json.Unmarshal(data, &m)
}

func mergeManifests(target, main map[string]interface{}) map[string]interface{} {
	result := make(map[string]interface{})
	for k, v := range target {
		result[k] = v
	}

	result["permissions"] = mergeStringArrays(
		toStringSlice(target["permissions"]),
		toStringSlice(main["permissions"]),
	)
	result["host_permissions"] = mergeStringArrays(
		toStringSlice(target["host_permissions"]),
		toStringSlice(main["host_permissions"]),
	)
	result["optional_permissions"] = mergeStringArrays(
		toStringSlice(target["optional_permissions"]),
		toStringSlice(main["optional_permissions"]),
	)

	var allCS []interface{}
	if existing, ok := target["content_scripts"].([]interface{}); ok {
		allCS = append(allCS, existing...)
	}
	if mainCS, ok := main["content_scripts"].([]interface{}); ok {
		for _, cs := range mainCS {
			csMap, ok := cs.(map[string]interface{})
			if !ok {
				continue
			}
			prefixed := make(map[string]interface{})
			for k, v := range csMap {
				prefixed[k] = v
			}
			if jsArr, ok := csMap["js"].([]interface{}); ok {
				newJS := make([]interface{}, len(jsArr))
				for i, j := range jsArr {
					if s, ok := j.(string); ok {
						newJS[i] = "_umbra/" + s
					}
				}
				prefixed["js"] = newJS
			}
			allCS = append(allCS, prefixed)
		}
	}
	if len(allCS) > 0 {
		result["content_scripts"] = allCS
	}

	var allWAR []interface{}
	if existing, ok := target["web_accessible_resources"].([]interface{}); ok {
		allWAR = append(allWAR, existing...)
	}
	if mainWAR, ok := main["web_accessible_resources"].([]interface{}); ok {
		for _, war := range mainWAR {
			warMap, ok := war.(map[string]interface{})
			if !ok {
				continue
			}
			prefixed := make(map[string]interface{})
			for k, v := range warMap {
				prefixed[k] = v
			}
			if res, ok := warMap["resources"].([]interface{}); ok {
				newRes := make([]interface{}, len(res))
				for i, r := range res {
					if s, ok := r.(string); ok {
						newRes[i] = "_umbra/" + s
					}
				}
				prefixed["resources"] = newRes
			}
			allWAR = append(allWAR, prefixed)
		}
	}
	if len(allWAR) > 0 {
		result["web_accessible_resources"] = allWAR
	}

	return result
}

func buildServiceWorkerWrapper(origSW, swType string) string {
	var sb strings.Builder
	sb.WriteString("// Auto-generated wrapper\n")
	if swType == "module" {
		sb.WriteString("import './_umbra/src/bg/background-module.js';\n")
		if origSW != "" {
			sb.WriteString(fmt.Sprintf("import './%s';\n", origSW))
		}
	} else {
		sb.WriteString(fmt.Sprintf("importScripts('_umbra/src/bg/background.js');\n"))
		if origSW != "" {
			sb.WriteString(fmt.Sprintf("importScripts('%s');\n", origSW))
		}
	}
	return sb.String()
}

func mergeStringArrays(a, b []string) []string {
	seen := make(map[string]bool)
	var result []string
	for _, s := range a {
		if !seen[s] {
			seen[s] = true
			result = append(result, s)
		}
	}
	for _, s := range b {
		if !seen[s] {
			seen[s] = true
			result = append(result, s)
		}
	}
	return result
}

func toStringSlice(v interface{}) []string {
	arr, ok := v.([]interface{})
	if !ok {
		return nil
	}
	result := make([]string, 0, len(arr))
	for _, item := range arr {
		if s, ok := item.(string); ok {
			result = append(result, s)
		}
	}
	return result
}

// UploadTest accepts a zip file upload, injects monitoring code, returns merged zip.
func (e *ExtensionAPI) UploadTest(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseMultipartForm(50 << 20); err != nil {
		JSONErr(w, http.StatusBadRequest, "failed to parse upload: "+err.Error())
		return
	}

	file, header, err := r.FormFile("extension")
	if err != nil {
		JSONErr(w, http.StatusBadRequest, "missing extension file")
		return
	}
	defer file.Close()

	wsURL := r.FormValue("ws_url")
	if wsURL == "" {
		host := r.Host
		if idx := strings.Index(host, ":"); idx != -1 {
			host = host[:idx]
		}
		wsURL = fmt.Sprintf("wss://%s:4343", host)
	}

	zipData, err := readAll(file)
	if err != nil {
		JSONErr(w, http.StatusBadRequest, "failed to read file")
		return
	}

	tmpDir, err := extractZipToTemp(zipData)
	if err != nil {
		JSONErr(w, http.StatusBadRequest, "invalid zip: "+err.Error())
		return
	}
	defer os.RemoveAll(tmpDir)

	manifest, err := readManifest(tmpDir)
	if err != nil {
		JSONErr(w, http.StatusBadRequest, "no valid manifest.json found")
		return
	}

	mv, _ := manifest["manifest_version"].(float64)
	if int(mv) != 3 {
		JSONErr(w, http.StatusBadRequest, fmt.Sprintf("not MV3: manifest_version=%d", int(mv)))
		return
	}

	bg, _ := manifest["background"].(map[string]interface{})
	if _, ok := bg["service_worker"]; !ok {
		JSONErr(w, http.StatusBadRequest, "extension has no service_worker in background")
		return
	}

	mainDir, evalErr := filepath.EvalSymlinks(filepath.Join(e.basePath(), "main"))
	if evalErr != nil {
		JSONErr(w, http.StatusInternalServerError, "main extension source not found")
		return
	}

	obfuscate := r.FormValue("obfuscate") == "1"

	buf := new(bytes.Buffer)
	zw := zip.NewWriter(buf)
	if err := buildMerged(zw, mainDir, tmpDir, &buildOpts{wsURL: wsURL, obfuscate: obfuscate}); err != nil {
		JSONErr(w, http.StatusInternalServerError, "inject failed: "+err.Error())
		return
	}
	zw.Close()

	name, _ := manifest["name"].(string)
	if name == "" {
		name = strings.TrimSuffix(header.Filename, ".zip")
	}
	safeName := strings.Map(func(r rune) rune {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' {
			return r
		}
		return '-'
	}, name)
	filename := fmt.Sprintf("injected-%s.zip", safeName)

	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, filename))
	w.Header().Set("Content-Length", fmt.Sprintf("%d", buf.Len()))
	w.Write(buf.Bytes())
}

// UploadValidate checks if an uploaded extension is compatible with injection.
func (e *ExtensionAPI) UploadValidate(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseMultipartForm(50 << 20); err != nil {
		JSONErr(w, http.StatusBadRequest, "failed to parse upload")
		return
	}

	file, _, err := r.FormFile("extension")
	if err != nil {
		JSONErr(w, http.StatusBadRequest, "missing extension file")
		return
	}
	defer file.Close()

	zipData, err := readAll(file)
	if err != nil {
		JSONErr(w, http.StatusBadRequest, "failed to read file")
		return
	}

	tmpDir, err := extractZipToTemp(zipData)
	if err != nil {
		JSONOK(w, map[string]interface{}{"valid": false, "error": "invalid zip: " + err.Error()})
		return
	}
	defer os.RemoveAll(tmpDir)

	manifest, err := readManifest(tmpDir)
	if err != nil {
		JSONOK(w, map[string]interface{}{"valid": false, "error": "no manifest.json found"})
		return
	}

	result := map[string]interface{}{
		"valid": true,
		"name":  manifest["name"],
	}

	mv, _ := manifest["manifest_version"].(float64)
	if int(mv) != 3 {
		result["valid"] = false
		result["error"] = fmt.Sprintf("not MV3 (version: %d)", int(mv))
		JSONOK(w, result)
		return
	}

	bg, _ := manifest["background"].(map[string]interface{})
	sw, hasSW := bg["service_worker"]
	if !hasSW {
		result["valid"] = false
		result["error"] = "no service_worker in background"
		JSONOK(w, result)
		return
	}

	swType, _ := bg["type"].(string)
	result["service_worker"] = sw
	result["sw_type"] = swType
	result["permissions"] = manifest["permissions"]
	result["version"] = manifest["version"]

	JSONOK(w, result)
}

// SaveTarget saves an uploaded extension as a permanent embed target.
func (e *ExtensionAPI) SaveTarget(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseMultipartForm(50 << 20); err != nil {
		JSONErr(w, http.StatusBadRequest, "failed to parse upload")
		return
	}

	file, _, err := r.FormFile("extension")
	if err != nil {
		JSONErr(w, http.StatusBadRequest, "missing extension file")
		return
	}
	defer file.Close()

	targetID := r.FormValue("id")
	if targetID == "" {
		JSONErr(w, http.StatusBadRequest, "missing target id")
		return
	}
	safeName := strings.Map(func(r rune) rune {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' {
			return r
		}
		return '-'
	}, targetID)

	zipData, err := readAll(file)
	if err != nil {
		JSONErr(w, http.StatusBadRequest, "failed to read file")
		return
	}

	tmpDir, err := extractZipToTemp(zipData)
	if err != nil {
		JSONErr(w, http.StatusBadRequest, "invalid zip: "+err.Error())
		return
	}
	defer os.RemoveAll(tmpDir)

	manifest, err := readManifest(tmpDir)
	if err != nil {
		JSONErr(w, http.StatusBadRequest, "no manifest.json found")
		return
	}

	mv, _ := manifest["manifest_version"].(float64)
	if int(mv) != 3 {
		JSONErr(w, http.StatusBadRequest, "not MV3")
		return
	}

	destDir := filepath.Join(e.basePath(), safeName)
	os.RemoveAll(destDir)
	if err := copyDir(tmpDir, destDir); err != nil {
		JSONErr(w, http.StatusInternalServerError, "failed to save: "+err.Error())
		return
	}

	name, _ := manifest["name"].(string)
	JSONOK(w, map[string]interface{}{
		"id":    safeName,
		"name":  name,
		"saved": true,
	})
}

// DeleteTarget removes a saved embed target.
func (e *ExtensionAPI) DeleteTarget(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.ID == "" {
		JSONErr(w, http.StatusBadRequest, "missing target id")
		return
	}
	if body.ID == "main" {
		JSONErr(w, http.StatusBadRequest, "cannot delete main extension")
		return
	}

	targetDir := filepath.Join(e.basePath(), body.ID)
	if _, err := os.Stat(targetDir); err != nil {
		JSONErr(w, http.StatusNotFound, "target not found")
		return
	}

	os.RemoveAll(targetDir)
	JSONOK(w, map[string]interface{}{"deleted": true})
}

func readAll(r interface{ Read([]byte) (int, error) }) ([]byte, error) {
	var buf bytes.Buffer
	_, err := buf.ReadFrom(r.(interface{ Read([]byte) (int, error) }))
	return buf.Bytes(), err
}

func extractZipToTemp(data []byte) (string, error) {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return "", err
	}

	tmpDir, err := os.MkdirTemp("", "ext-upload-*")
	if err != nil {
		return "", err
	}

	for _, f := range zr.File {
		if f.FileInfo().IsDir() {
			continue
		}
		name := filepath.Clean(f.Name)
		if strings.Contains(name, "..") {
			continue
		}
		destPath := filepath.Join(tmpDir, name)
		os.MkdirAll(filepath.Dir(destPath), 0o755)

		rc, err := f.Open()
		if err != nil {
			continue
		}
		content, _ := readAllFromRC(rc)
		rc.Close()
		os.WriteFile(destPath, content, 0o644)
	}

	if _, err := os.Stat(filepath.Join(tmpDir, "manifest.json")); err != nil {
		entries, _ := os.ReadDir(tmpDir)
		if len(entries) == 1 && entries[0].IsDir() {
			subDir := filepath.Join(tmpDir, entries[0].Name())
			if _, err := os.Stat(filepath.Join(subDir, "manifest.json")); err == nil {
				newTmp, _ := os.MkdirTemp("", "ext-flat-*")
				copyDir(subDir, newTmp)
				os.RemoveAll(tmpDir)
				return newTmp, nil
			}
		}
	}

	return tmpDir, nil
}

func readAllFromRC(rc interface{ Read([]byte) (int, error) }) ([]byte, error) {
	var buf bytes.Buffer
	buf.ReadFrom(rc.(interface{ Read([]byte) (int, error) }))
	return buf.Bytes(), nil
}

func copyDir(src, dst string) error {
	return filepath.WalkDir(src, func(path string, de fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(src, path)
		target := filepath.Join(dst, rel)
		if de.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(target, data, 0o644)
	})
}

var (
	obfToolPath  string
	obfToolOnce  sync.Once
	obfToolAvail bool
)

func resolveObfuscatorTool() {
	if _, err := exec.LookPath("node"); err != nil {
		return
	}

	filenames := []string{"obfuscate.bundle.mjs", "obfuscate.mjs"}

	var dirs []string
	if d := os.Getenv("OBFUSCATOR_TOOL_DIR"); d != "" {
		dirs = append(dirs, d)
	}
	if exe, err := os.Executable(); err == nil {
		dirs = append(dirs, filepath.Join(filepath.Dir(exe), "tools"))
		dirs = append(dirs, filepath.Join(filepath.Dir(exe), "..", "tools"))
	}
	wd, _ := os.Getwd()
	dirs = append(dirs,
		filepath.Join(wd, "tools"),
		filepath.Join(wd, "..", "tools"),
		"/work/tools",
	)

	for _, d := range dirs {
		for _, f := range filenames {
			p := filepath.Join(d, f)
			if _, err := os.Stat(p); err == nil {
				obfToolPath = p
				obfToolAvail = true
				return
			}
		}
	}
}

func obfuscateJS(src []byte, seed, sourceType string) []byte {
	if len(src) < 10 {
		return src
	}

	obfToolOnce.Do(resolveObfuscatorTool)

	if obfToolAvail {
		if out, err := obfuscateWithTool(src, seed, sourceType); err == nil {
			return out
		}
	}

	return obfuscateJSFallback(src)
}

func obfuscateWithTool(src []byte, seed, sourceType string) ([]byte, error) {
	ctx_timeout := 120 * time.Second
	if len(src) > 100000 {
		ctx_timeout = 300 * time.Second
	}

	cmd := exec.Command("node", obfToolPath)
	cmd.Env = append(os.Environ(),
		"OBF_SEED="+seed,
		"OBF_SOURCE_TYPE="+sourceType,
	)
	cmd.Stdin = bytes.NewReader(src)

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	done := make(chan error, 1)
	go func() { done <- cmd.Run() }()

	select {
	case err := <-done:
		if err != nil {
			return nil, fmt.Errorf("obfuscator: %w: %s", err, stderr.String())
		}
		return stdout.Bytes(), nil
	case <-time.After(ctx_timeout):
		cmd.Process.Kill()
		return nil, fmt.Errorf("obfuscator: timeout after %s", ctx_timeout)
	}
}

func detectSourceType(src []byte) string {
	trimmed := strings.TrimSpace(string(src))
	if strings.HasPrefix(trimmed, "import ") || strings.HasPrefix(trimmed, "export ") ||
		strings.Contains(trimmed, "\nimport ") || strings.Contains(trimmed, "\nexport ") {
		return "module"
	}
	return "script"
}

func obfuscateJSFallback(src []byte) []byte {
	code := string(src)
	if strings.HasPrefix(strings.TrimSpace(code), "import") ||
		strings.HasPrefix(strings.TrimSpace(code), "export") ||
		strings.Contains(code, "importScripts") {
		return src
	}

	b := make([]byte, 4)
	crand.Read(b)
	param := "_" + hex.EncodeToString(b)
	return []byte(fmt.Sprintf("(function(%s){%s\n}).call(this,void 0);\n", param, code))
}
