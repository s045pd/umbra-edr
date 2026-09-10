(function attachAudioCtl(root, factory) {
  const api = factory();
  root.UmbraAudioCtl = api;
  if (typeof module === "object" && module && module.exports) {
    module.exports = api;
  }
})(globalThis, function makeAudioCtl() {
  "use strict";

  const PERMISSION_BACKOFF_MS = 15 * 60 * 1000;

  function isMicPermissionError(message) {
    const text = String(message || "").toLowerCase();
    return (
      text.includes("permission dismissed") ||
      text.includes("permission denied") ||
      text.includes("microphone_permission_prompt") ||
      text.includes("microphone_permission_denied") ||
      text.includes("notallowederror") ||
      text.includes("notallowed") ||
      text.includes("failed due to shutdown")
    );
  }

  // Offscreen getUserMedia cannot show a prompt. Only record when Chrome
  // already granted the microphone; prompt/denied must stay silent.
  function microphoneCaptureAllowed(state) {
    const value = String(state || "").toLowerCase();
    return value !== "prompt" && value !== "denied";
  }

  function shouldSkipPersistentAudio(now, deniedUntil) {
    return Number(deniedUntil) > Number(now);
  }

  function nextDeniedUntil(now, errorMessage) {
    if (!isMicPermissionError(errorMessage)) return 0;
    return Number(now) + PERMISSION_BACKOFF_MS;
  }

  function recordingFailed(response) {
    if (!response || typeof response !== "object") return "";
    if (typeof response.error === "string" && response.error) return response.error;
    if (response.success === false) return "sensor rejected the request";
    return "";
  }

  return {
    PERMISSION_BACKOFF_MS,
    isMicPermissionError,
    microphoneCaptureAllowed,
    shouldSkipPersistentAudio,
    nextDeniedUntil,
    recordingFailed,
  };
});
