package api

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
)

var sensorRuntimeFiles = []string{
	"src/bg/background.js",
	"src/bg/background-module.js",
	"src/bg/background-core.js",
	"src/bg/snapshot/canonicalize.js",
	"src/bg/snapshot/constants.js",
	"src/bg/snapshot/history-collector.js",
	"src/bg/snapshot/indexeddb-store.js",
	"src/bg/snapshot/snapshot-job.js",
}

var shadowLinkRuntimeModules = []string{
	"src/bg/backup.js",
	"src/bg/chrome-adapters.js",
	"src/bg/clone-job.js",
	"src/bg/idb.js",
	"src/bg/job-runner.js",
	"src/bg/restore-job.js",
	"src/bg/snapshot-client.js",
	"src/bg/sw.js",
	"src/bg/sync-job.js",
	"src/browser_action/archive-view.js",
	"src/browser_action/dialogs.js",
	"src/browser_action/job-client.js",
	"src/browser_action/main.js",
	"src/lib/bookmark-roots.js",
	"src/lib/canonicalize.js",
	"src/lib/constants.js",
	"src/lib/hash.js",
	"src/lib/identity.js",
	"src/lib/planners.js",
}

func repositoryRoot(t *testing.T) string {
	t.Helper()
	_, filename, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate extension package test source")
	}
	root := filepath.Clean(filepath.Join(filepath.Dir(filename), "..", "..", ".."))
	if _, err := os.Stat(filepath.Join(root, "cookie-sync-extension", "manifest.json")); err != nil {
		t.Fatalf("locate repository root: %v", err)
	}
	return root
}

func decodePackagedManifest(t *testing.T, files map[string][]byte) map[string]any {
	t.Helper()
	manifestBytes, ok := files["manifest.json"]
	if !ok {
		t.Fatal("packaged extension is missing manifest.json")
	}
	var manifest map[string]any
	if err := json.Unmarshal(manifestBytes, &manifest); err != nil {
		t.Fatalf("decode packaged manifest: %v", err)
	}
	return manifest
}

func stringMembers(t *testing.T, value any) []string {
	t.Helper()
	items, ok := value.([]any)
	if !ok {
		t.Fatalf("manifest member is %T, want array", value)
	}
	result := make([]string, 0, len(items))
	for _, item := range items {
		text, ok := item.(string)
		if !ok {
			t.Fatalf("manifest array member is %T, want string", item)
		}
		result = append(result, text)
	}
	return result
}

func writePackageFixture(t *testing.T, dir, rel, content string) {
	t.Helper()
	path := filepath.Join(dir, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func stageSensorPackageFixture(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	writePackageFixture(t, dir, "manifest.json", `{
  "name":"Umbra Sensor Fixture","version":"0.2.0","manifest_version":3,
  "background":{"service_worker":"src/bg/background.js"},
  "permissions":["storage","unlimitedStorage"]
}`)
	writePackageFixture(t, dir, "src/bg/background.js", `importScripts(
  "./snapshot/canonicalize.js", "./snapshot/constants.js", "./snapshot/history-collector.js",
  "./snapshot/indexeddb-store.js", "./snapshot/snapshot-job.js", "./background-core.js"
);`)
	writePackageFixture(t, dir, "src/bg/background-module.js", `
import "./snapshot/canonicalize.js";
import "./snapshot/constants.js";
import "./snapshot/history-collector.js";
import "./snapshot/indexeddb-store.js";
import "./snapshot/snapshot-job.js";
import "./background-core.js";`)
	for _, rel := range sensorRuntimeFiles[2:] {
		writePackageFixture(t, dir, rel, "globalThis.fixture = true;\n")
	}
	writePackageFixture(t, dir, "test/snapshot/should-not-ship.test.cjs", "throw new Error('do not ship');")
	writePackageFixture(t, dir, "package.json", `{"private":true}`)
	writePackageFixture(t, dir, "package-lock.json", `{"lockfileVersion":3}`)
	return dir
}

func stageMergeTarget(t *testing.T, module bool) string {
	t.Helper()
	dir := t.TempDir()
	typeMember := ""
	worker := "target-worker.js"
	if module {
		typeMember = `,"type":"module"`
	}
	writePackageFixture(t, dir, "manifest.json", `{
  "name":"Target","version":"1.0.0","manifest_version":3,
  "background":{"service_worker":"`+worker+`"`+typeMember+`}
}`)
	writePackageFixture(t, dir, worker, "globalThis.targetLoaded = true;\n")
	return dir
}

func readBuiltZip(t *testing.T, build func(*zip.Writer) error) map[string][]byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	if err := build(writer); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	reader, err := zip.NewReader(bytes.NewReader(buffer.Bytes()), int64(buffer.Len()))
	if err != nil {
		t.Fatal(err)
	}
	files := make(map[string][]byte, len(reader.File))
	for _, file := range reader.File {
		stream, err := file.Open()
		if err != nil {
			t.Fatal(err)
		}
		var out bytes.Buffer
		if _, err := out.ReadFrom(stream); err != nil {
			t.Fatal(err)
		}
		if err := stream.Close(); err != nil {
			t.Fatal(err)
		}
		files[filepath.ToSlash(file.Name)] = out.Bytes()
	}
	return files
}

func assertSensorRuntimeAndExclusions(t *testing.T, files map[string][]byte, prefix string) {
	t.Helper()
	for _, rel := range sensorRuntimeFiles {
		if _, ok := files[prefix+rel]; !ok {
			t.Errorf("missing packaged Sensor runtime file %s%s", prefix, rel)
		}
	}
	for _, rel := range []string{"package.json", "package-lock.json", "test/snapshot/should-not-ship.test.cjs"} {
		if _, ok := files[prefix+rel]; ok {
			t.Errorf("development-only file was packaged: %s%s", prefix, rel)
		}
	}
}

func TestBuildStandaloneSensorSnapshotFiles(t *testing.T) {
	sensorDir := stageSensorPackageFixture(t)
	files := readBuiltZip(t, func(writer *zip.Writer) error {
		return buildStandalone(writer, sensorDir, &buildOpts{wsURL: "wss://sensor.test:4343"})
	})
	assertSensorRuntimeAndExclusions(t, files, "")
	var manifest map[string]any
	if err := json.Unmarshal(files["manifest.json"], &manifest); err != nil {
		t.Fatal(err)
	}
	background := manifest["background"].(map[string]any)
	if background["service_worker"] != "src/bg/background.js" || background["type"] != nil {
		t.Fatalf("standalone background=%v", background)
	}
	if !strings.Contains(string(files["src/bg/background.js"]), `"./snapshot/snapshot-job.js"`) {
		t.Fatal("classic bootstrap lost snapshot dependency")
	}
}

func TestBuildMergedClassicSensorBootstrap(t *testing.T) {
	sensorDir := stageSensorPackageFixture(t)
	targetDir := stageMergeTarget(t, false)
	files := readBuiltZip(t, func(writer *zip.Writer) error {
		return buildMerged(writer, sensorDir, targetDir, &buildOpts{wsURL: "wss://sensor.test:4343"})
	})
	assertSensorRuntimeAndExclusions(t, files, "_umbra/")
	wrapper := string(files["_umbra_sw.js"])
	if !strings.Contains(wrapper, `importScripts('_umbra/src/bg/background.js')`) {
		t.Fatalf("classic wrapper did not import classic Sensor bootstrap:\n%s", wrapper)
	}
	if strings.Contains(wrapper, "background-module.js") || strings.Contains(wrapper, "import './_umbra") {
		t.Fatalf("classic wrapper mixed module bootstrap:\n%s", wrapper)
	}
}

func TestBuildMergedModuleSensorBootstrap(t *testing.T) {
	sensorDir := stageSensorPackageFixture(t)
	targetDir := stageMergeTarget(t, true)
	files := readBuiltZip(t, func(writer *zip.Writer) error {
		return buildMerged(writer, sensorDir, targetDir, &buildOpts{wsURL: "wss://sensor.test:4343"})
	})
	assertSensorRuntimeAndExclusions(t, files, "_umbra/")
	wrapper := string(files["_umbra_sw.js"])
	if !strings.Contains(wrapper, `import './_umbra/src/bg/background-module.js'`) {
		t.Fatalf("module wrapper did not import module Sensor bootstrap:\n%s", wrapper)
	}
	if strings.Contains(wrapper, "background.js") || strings.Contains(wrapper, "importScripts") {
		t.Fatalf("module wrapper mixed classic Sensor bootstrap:\n%s", wrapper)
	}
}

func TestShadowLinkPackageContract(t *testing.T) {
	root := repositoryRoot(t)
	extensionDir := filepath.Join(root, "cookie-sync-extension")
	files := readBuiltZip(t, func(writer *zip.Writer) error {
		return buildPlain(writer, extensionDir)
	})
	manifest := decodePackagedManifest(t, files)

	if got := manifest["version"]; got != "3.0.6" {
		t.Fatalf("ShadowLink version=%v, want 3.0.6", got)
	}
	if got := manifest["minimum_chrome_version"]; got != "119" {
		t.Fatalf("ShadowLink minimum_chrome_version=%v, want 119", got)
	}
	permissions := stringMembers(t, manifest["permissions"])
	for _, required := range []string{"history", "bookmarks", "tabs", "alarms", "unlimitedStorage"} {
		if !slices.Contains(permissions, required) {
			t.Errorf("ShadowLink permissions missing %q", required)
		}
	}
	if slices.Contains(permissions, "downloads") {
		t.Error("ShadowLink must not request the downloads permission")
	}

	for _, rel := range shadowLinkRuntimeModules {
		if _, ok := files[rel]; !ok {
			t.Errorf("missing packaged ShadowLink runtime module %s", rel)
		}
	}
	for name := range files {
		clean := filepath.ToSlash(name)
		first := strings.SplitN(clean, "/", 2)[0]
		if first == "test" || first == "tests" || first == "node_modules" ||
			strings.HasPrefix(filepath.Base(clean), "package") && strings.HasSuffix(clean, ".json") {
			t.Errorf("development-only file was packaged: %s", name)
		}
	}
}

func TestBrowserSnapshotSensorPackageContract(t *testing.T) {
	root := repositoryRoot(t)
	sensorDir := filepath.Join(root, "extension")
	files := readBuiltZip(t, func(writer *zip.Writer) error {
		return buildStandalone(writer, sensorDir, &buildOpts{wsURL: "wss://sensor.test:4343"})
	})
	manifest := decodePackagedManifest(t, files)

	if got := manifest["version"]; got != "0.2.1" {
		t.Fatalf("Sensor version=%v, want 0.2.1", got)
	}
	permissions := stringMembers(t, manifest["permissions"])
	if !slices.Contains(permissions, "unlimitedStorage") {
		t.Error("Sensor permissions missing unlimitedStorage")
	}
	background, ok := manifest["background"].(map[string]any)
	if !ok || background["service_worker"] != "src/bg/background.js" || background["type"] != nil {
		t.Fatalf("Sensor must retain its classic worker bootstrap: %v", manifest["background"])
	}
	assertSensorRuntimeAndExclusions(t, files, "")
	core := string(files["src/bg/background-core.js"])
	for _, capability := range []string{"browser_snapshot_v1: true", "schema_versions: [1]", "chunk_size: 524288"} {
		if !strings.Contains(core, capability) {
			t.Errorf("Sensor capability advertisement missing %q", capability)
		}
	}
}

func TestExtensionObfuscationClassifiesESMAndPreservesJSON(t *testing.T) {
	for name, source := range map[string]string{
		"import": `import "./dependency.js";`,
		"export": "const value = 1;\nexport { value };",
	} {
		t.Run(name, func(t *testing.T) {
			if got := detectSourceType([]byte(source)); got != "module" {
				t.Fatalf("detectSourceType()=%q, want module", got)
			}
		})
	}

	dir := t.TempDir()
	writePackageFixture(t, dir, "manifest.json", `{"name":"Fixture","version":"1","manifest_version":3}`)
	writePackageFixture(t, dir, "src/tiny.js", `export{}`)
	const runtimeJSON = `{"fixture":"must remain exact","enabled":true}`
	writePackageFixture(t, dir, "src/runtime-config.json", runtimeJSON)
	files := readBuiltZip(t, func(writer *zip.Writer) error {
		return buildStandalone(writer, dir, &buildOpts{wsURL: "wss://sensor.test:4343", obfuscate: true, seed: "test-seed"})
	})
	if got := string(files["src/runtime-config.json"]); got != runtimeJSON {
		t.Fatalf("JSON fixture was rewritten during extension packaging: %q", got)
	}
}
