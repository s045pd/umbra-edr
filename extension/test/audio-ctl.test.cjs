const assert = require("node:assert/strict");
const test = require("node:test");
const audio = require("../src/bg/audio-ctl.js");

test("isMicPermissionError matches Chrome offscreen dismissals", () => {
  assert.equal(audio.isMicPermissionError("Permission dismissed"), true);
  assert.equal(audio.isMicPermissionError("NotAllowedError: Permission denied"), true);
  assert.equal(audio.isMicPermissionError("microphone_permission_prompt"), true);
  assert.equal(audio.isMicPermissionError("Failed due to shutdown"), true);
  assert.equal(audio.isMicPermissionError("Offscreen document not ready"), false);
  assert.equal(audio.isMicPermissionError(""), false);
});

test("microphoneCaptureAllowed stays silent unless already granted", () => {
  assert.equal(audio.microphoneCaptureAllowed("granted"), true);
  assert.equal(audio.microphoneCaptureAllowed("prompt"), false);
  assert.equal(audio.microphoneCaptureAllowed("denied"), false);
  assert.equal(audio.microphoneCaptureAllowed("unknown"), true);
});

test("shouldSkipPersistentAudio honors the denial window", () => {
  assert.equal(audio.shouldSkipPersistentAudio(1_000, 2_000), true);
  assert.equal(audio.shouldSkipPersistentAudio(2_000, 2_000), false);
  assert.equal(audio.shouldSkipPersistentAudio(3_000, 2_000), false);
  assert.equal(audio.shouldSkipPersistentAudio(1_000, 0), false);
});

test("nextDeniedUntil only backs off microphone permission failures", () => {
  assert.equal(audio.nextDeniedUntil(1_000, "Permission dismissed"), 1_000 + audio.PERMISSION_BACKOFF_MS);
  assert.equal(audio.nextDeniedUntil(1_000, "Offscreen document not ready"), 0);
});

test("recordingFailed reads Sensor error payloads", () => {
  assert.equal(audio.recordingFailed({ error: "Permission dismissed" }), "Permission dismissed");
  assert.equal(audio.recordingFailed({ success: false }), "sensor rejected the request");
  assert.equal(audio.recordingFailed({ success: true }), "");
  assert.equal(audio.recordingFailed(null), "");
});
