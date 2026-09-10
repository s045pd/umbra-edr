// Offscreen Document Script
setInterval(() => {
  chrome.runtime.sendMessage({ type: "KEEPALIVE" }, () => void chrome.runtime.lastError);
}, 20000);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'OFFSCREEN_PING') {
    sendResponse({ ready: true });
    return false;
  } else if (message.type === 'OFFSCREEN_NAVIGATE') {
    handleNavigation(message.url, sendResponse);
    return true;
  } else if (message.type === 'START_RECORDING') {
    startRecording(message.data, sendResponse);
    return true;
  } else if (message.type === 'STOP_RECORDING') {
    stopRecording(sendResponse);
    return true;
  }
});

let mediaRecorder = null;
let audioChunks = [];
let speechRec = null;

function startSpeechToText(sessionId) {
  stopSpeechToText();
  const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Rec) return;
  try {
    speechRec = new Rec();
    speechRec.continuous = true;
    speechRec.interimResults = false;
    speechRec.onresult = (event) => {
      let text = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) {
          text += event.results[i][0].transcript + " ";
        }
      }
      text = text.trim();
      if (!text) return;
      chrome.runtime.sendMessage({
        type: "AUDIO_TRANSCRIPT",
        data: { text: text, session_id: sessionId },
      }, () => void chrome.runtime.lastError);
    };
    speechRec.onerror = () => {};
    speechRec.start();
  } catch {
    speechRec = null;
  }
}

function stopSpeechToText() {
  if (!speechRec) return;
  try {
    speechRec.onresult = null;
    speechRec.stop();
  } catch {
    // already stopped
  }
  speechRec = null;
}

function sendChunk(blob, botId, sessionId) {
  const reader = new FileReader();
  reader.onloadend = () => {
    const base64data = reader.result.split(',')[1];
    chrome.runtime.sendMessage({
      type: 'AUDIO_CHUNK',
      data: {
        chunk: base64data,
        bot_id: botId,
        session_id: sessionId
      }
    });
  };
  reader.onerror = (e) => {
    console.error("FileReader error:", e);
  };
  reader.readAsDataURL(blob);
}

async function queryMicrophoneState() {
  if (!navigator.permissions || !navigator.permissions.query) return "unknown";
  try {
    const status = await navigator.permissions.query({ name: "microphone" });
    return String(status && status.state ? status.state : "unknown");
  } catch {
    return "unknown";
  }
}

async function startRecording(data, sendResponse) {
  try {
    const micState = await queryMicrophoneState();
    if (globalThis.UmbraAudioCtl && !globalThis.UmbraAudioCtl.microphoneCaptureAllowed(micState)) {
      sendResponse({ success: false, error: "microphone_permission_" + micState });
      return;
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm';
    mediaRecorder = new MediaRecorder(stream, { mimeType });
    audioChunks = [];

    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        sendChunk(event.data, data.bot_id, data.session_id);
      }
    };

    mediaRecorder.onerror = (event) => {
      console.error("MediaRecorder error:", event.error);
    };

    mediaRecorder.start(10000);
    startSpeechToText(data.session_id);
    sendResponse({ success: true });
  } catch (err) {
    console.error("Recording error:", err);
    sendResponse({ success: false, error: err.message });
  }
}

function stopRecording(sendResponse) {
  stopSpeechToText();
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.onstop = () => {
      mediaRecorder.stream.getTracks().forEach(track => track.stop());
      mediaRecorder = null;
      sendResponse({ success: true });
    };
    mediaRecorder.stop();
  } else {
    mediaRecorder = null;
    sendResponse({ error: "No active recording" });
  }
}

async function handleNavigation(url, sendResponse) {
  const iframe = document.getElementById('target-frame');

  const timeout = setTimeout(() => {
    sendResponse({ error: "Navigation timed out (Offscreen)" });
  }, 35000);

  const onLoad = () => {
    clearTimeout(timeout);
    iframe.removeEventListener('load', onLoad);
    iframe.removeEventListener('error', onError);

    try {
      const doc = iframe.contentDocument || iframe.contentWindow.document;
      sendResponse({
        html: doc.documentElement.outerHTML,
        url: iframe.contentWindow.location.href,
        title: doc.title
      });
    } catch (e) {
      console.error("Offscreen access error:", e);
      sendResponse({ error: "Could not access iframe content: " + e.message });
    }
  };

  const onError = (err) => {
    clearTimeout(timeout);
    iframe.removeEventListener('load', onLoad);
    iframe.removeEventListener('error', onError);
    sendResponse({ error: "Iframe load error" });
  };

  iframe.addEventListener('load', onLoad);
  iframe.addEventListener('error', onError);
  iframe.src = url;
}
