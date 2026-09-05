// public/js/proctor.js
//
// PariksaRakshak — resilient local camera proctoring.
//
// Goals:
// - Camera opens FIRST so the preview appears quickly.
// - MediaPipe loads in the background and may retry without killing the camera.
// - Low-bandwidth/low-CPU camera settings for large labs.
// - Camera watchdog automatically reconnects an ended, muted, stalled or blank stream.
// - Camera glitches NEVER auto-submit an exam.
// - The camera stream never leaves the student's machine.
// - Only incident event names/details are written to Supabase.

import { logIncident } from "./anticheat.js";
import { FACE_GRACE_MS } from "./config.js";

const VISION_CDN =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";

const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite";

const SAMPLE_MS = 1500;
const WATCHDOG_MS = 5000;
const DETECTOR_RETRY_MS = 20000;
const CAMERA_RETRY_DELAYS = [0, 1500, 3000, 6000];

const CAMERA_CONSTRAINTS = {
  video: {
    width: { ideal: 320, max: 640 },
    height: { ideal: 240, max: 480 },
    frameRate: { ideal: 10, max: 15 },
    facingMode: "user",
  },
  audio: false,
};

let detector = null;
let detectorPromise = null;
let detectorRetryTimer = null;

let video = null;
let stream = null;
let running = false;

let loopTimer = null;
let watchdogTimer = null;
let recoveryPromise = null;

let faceState = "__RESET__";
let faceStateSince = Date.now();

let onFaceState = () => {};

function camUi(text, state = "") {
  const el = document.getElementById("camState");
  if (!el) return;

  el.textContent = text;

  if (state) {
    el.dataset.state = state;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function currentVideoTrack() {
  return stream?.getVideoTracks?.()[0] ?? null;
}

function cameraHealthy() {
  const track = currentVideoTrack();

  return Boolean(
    running &&
    video &&
    stream &&
    track &&
    track.readyState === "live" &&
    !track.muted &&
    video.srcObject === stream &&
    video.readyState >= 2 &&
    video.videoWidth > 0 &&
    video.videoHeight > 0
  );
}

async function waitForVideoFrame(videoEl, timeoutMs = 4500) {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    if (
      videoEl.readyState >= 2 &&
      videoEl.videoWidth > 0 &&
      videoEl.videoHeight > 0
    ) {
      return true;
    }

    await sleep(100);
  }

  return false;
}

function stopCurrentStream() {
  const old = stream;
  stream = null;

  if (old) {
    old.getTracks().forEach((track) => {
      try {
        track.stop();
      } catch {
        // Nothing else to do.
      }
    });
  }

  if (video?.srcObject === old) {
    video.srcObject = null;
  }
}

async function openCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("This browser does not provide camera access.");
  }

  stopCurrentStream();

  const next = await navigator.mediaDevices.getUserMedia(
    CAMERA_CONSTRAINTS,
  );

  if (!running) {
    next.getTracks().forEach((track) => track.stop());
    throw new Error("Proctoring was stopped.");
  }

  stream = next;

  video.muted = true;
  video.playsInline = true;
  video.autoplay = true;
  video.srcObject = stream;

  const track = currentVideoTrack();

  if (!track) {
    stopCurrentStream();
    throw new Error("No video track was returned by the camera.");
  }

  track.addEventListener("ended", () => {
    if (running) {
      scheduleCameraRecovery("camera track ended");
    }
  });

  track.addEventListener("mute", () => {
    // A very short mute can happen while a device changes state.
    // Give it a moment before treating it as a broken stream.
    setTimeout(() => {
      if (running && !cameraHealthy()) {
        scheduleCameraRecovery("camera track muted");
      }
    }, 1200);
  });

  video.onstalled = () => {
    if (running) {
      scheduleCameraRecovery("video stalled");
    }
  };

  video.onerror = () => {
    if (running) {
      scheduleCameraRecovery("video element error");
    }
  };

  await video.play();

  const gotFrame = await waitForVideoFrame(video);

  if (!gotFrame) {
    throw new Error("The camera opened but no video frames arrived.");
  }

  faceState = "__RESET__";
  faceStateSince = Date.now();

  return true;
}

async function loadDetector() {
  if (detector) return detector;
  if (detectorPromise) return detectorPromise;

  detectorPromise = (async () => {
    camUi("camera live · loading face check", "ok");

    const { FaceDetector, FilesetResolver } =
      await import(`${VISION_CDN}/vision_bundle.mjs`);

    const files =
      await FilesetResolver.forVisionTasks(`${VISION_CDN}/wasm`);

    const created = await FaceDetector.createFromOptions(files, {
      baseOptions: {
        modelAssetPath: MODEL_URL,
      },
      runningMode: "VIDEO",
    });

    detector = created;

    if (cameraHealthy()) {
      camUi("camera live · face check ready", "ok");
    }

    return detector;
  })();

  try {
    return await detectorPromise;
  } catch (e) {
    console.warn("[proctor] face detector unavailable:", e);

    detector = null;

    if (cameraHealthy()) {
      camUi("camera live · face check retrying", "ok");
    }

    if (running) {
      clearTimeout(detectorRetryTimer);
      detectorRetryTimer = setTimeout(() => {
        detectorPromise = null;
        loadDetector().catch(() => {});
      }, DETECTOR_RETRY_MS);
    }

    return null;
  } finally {
    detectorPromise = null;
  }
}

function classify(count) {
  if (count === 0) return "NO_FACE_DETECTED";
  if (count > 1) return "MULTIPLE_FACES_DETECTED";
  return "OK";
}

async function detectionLoop() {
  if (!running) return;

  try {
    if (!cameraHealthy()) {
      scheduleCameraRecovery("camera watchdog detected no frames");
    } else if (detector) {
      const result =
        detector.detectForVideo(video, performance.now());

      const next = classify(result.detections.length);

      if (next !== faceState) {
        faceState = next;
        faceStateSince = Date.now();

        // A valid single face can be reported immediately.
        if (faceState === "OK") {
          onFaceState("OK");
        }
      } else if (
        faceState !== "OK" &&
        Date.now() - faceStateSince >= FACE_GRACE_MS
      ) {
        onFaceState(faceState);

        await logIncident(
          faceState,
          `faces=${result.detections.length}`,
        );

        // Keep reporting a persistent state only once per grace window.
        faceStateSince = Date.now();
      }
    }
  } catch (e) {
    // A detector can throw while video is changing or warming up.
    // Do not kill the stream for a transient detector error.
    console.debug("[proctor] frame skipped:", e);
  }

  if (running) {
    loopTimer = setTimeout(detectionLoop, SAMPLE_MS);
  }
}

function startWatchdog() {
  clearInterval(watchdogTimer);

  watchdogTimer = setInterval(() => {
    if (!running) return;

    if (!cameraHealthy()) {
      scheduleCameraRecovery("camera health check failed");
    }
  }, WATCHDOG_MS);
}

function scheduleCameraRecovery(reason) {
  if (!running || recoveryPromise) {
    return recoveryPromise;
  }

  recoveryPromise = recoverCamera(reason)
    .finally(() => {
      recoveryPromise = null;
    });

  recoveryPromise.then((ok) => {
    if (!ok && running) {
      setTimeout(() => {
        if (running && !cameraHealthy()) {
          scheduleCameraRecovery("automatic retry");
        }
      }, 10000);
    }
  });

  return recoveryPromise;
}

async function recoverCamera(reason) {
  console.warn("[proctor] camera recovery:", reason);

  camUi("camera reconnecting…", "bad");

  logIncident(
    "NO_FACE_DETECTED",
    `camera stream interrupted; recovery started (${reason})`,
  ).catch(() => {});

  for (let i = 0; i < CAMERA_RETRY_DELAYS.length; i++) {
    if (!running) return false;

    const delay = CAMERA_RETRY_DELAYS[i];

    if (delay) {
      await sleep(delay);
    }

    try {
      await openCamera();

      camUi(
        detector
          ? "camera restored · checking face"
          : "camera restored · loading face check",
        "ok",
      );

      loadDetector().catch(() => {});

      return true;
    } catch (e) {
      console.warn(
        `[proctor] camera retry ${i + 1} failed:`,
        e,
      );
    }
  }

  camUi("camera unavailable · retrying", "bad");

  return false;
}

/**
 * Starts local camera proctoring.
 *
 * IMPORTANT:
 * Camera acquisition happens before MediaPipe loading. Therefore a slow CDN
 * cannot leave the preview blank while the detector downloads.
 */
export async function startProctoring(
  videoEl,
  cb = () => {},
) {
  stopProctoring();

  video = videoEl;
  onFaceState = cb;
  running = true;

  camUi("starting camera…", "bad");

  try {
    await openCamera();
  } catch (e) {
    running = false;
    stopCurrentStream();
    camUi("camera unavailable", "bad");
    throw e;
  }

  camUi("camera live · loading face check", "ok");

  // Detector failure does NOT turn off the camera.
  loadDetector().catch(() => {});

  detectionLoop();
  startWatchdog();

  return true;
}

export function stopProctoring() {
  running = false;

  clearTimeout(loopTimer);
  clearInterval(watchdogTimer);
  clearTimeout(detectorRetryTimer);

  loopTimer = null;
  watchdogTimer = null;
  detectorRetryTimer = null;
  recoveryPromise = null;

  stopCurrentStream();

  if (video) {
    video.onstalled = null;
    video.onerror = null;
  }

  try {
    detector?.close?.();
  } catch {
    // MediaPipe versions differ; close is optional.
  }

  detector = null;
  detectorPromise = null;
  video = null;

  faceState = "__RESET__";
  faceStateSince = Date.now();
}

/**
 * Preloads the large remote assets into the browser cache.
 * This does not open the camera and does not create a detector instance.
 */
export async function warmupProctorAssets() {
  // Import the JS bundle and ask MediaPipe to resolve the WASM files now.
  // The browser can then reuse those cached resources in exam.html.
  const moduleTask =
    import(`${VISION_CDN}/vision_bundle.mjs`)
      .then(async ({ FilesetResolver }) => {
        await FilesetResolver.forVisionTasks(
          `${VISION_CDN}/wasm`,
        );
        return true;
      })
      .catch(() => false);

  // Consume the model body so the complete model can enter the HTTP cache.
  const modelTask =
    fetch(MODEL_URL, {
      method: "GET",
      cache: "force-cache",
    })
      .then(async (res) => {
        if (!res.ok) return false;
        await res.arrayBuffer();
        return true;
      })
      .catch(() => false);

  const [moduleOk, modelOk] =
    await Promise.all([moduleTask, modelTask]);

  return {
    ok: moduleOk && modelOk,
    module: moduleOk,
    model: modelOk,
  };
}

/**
 * Used before the exam starts.
 * Opens a temporary local camera stream and verifies that real frames arrive.
 */
export async function cameraProbe() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Camera access is not supported by this browser.");
  }

  const testStream =
    await navigator.mediaDevices.getUserMedia(
      CAMERA_CONSTRAINTS,
    );

  const testVideo = document.createElement("video");

  testVideo.muted = true;
  testVideo.playsInline = true;
  testVideo.autoplay = true;

  // Keep it outside the visible viewport while frames are verified.
  testVideo.style.cssText =
    "position:fixed;width:1px;height:1px;left:-9999px;top:-9999px;opacity:0;pointer-events:none";

  document.body.appendChild(testVideo);
  testVideo.srcObject = testStream;

  try {
    await testVideo.play();

    const gotFrame =
      await waitForVideoFrame(testVideo, 4500);

    if (!gotFrame) {
      throw new Error(
        "The camera opened but no video frames arrived.",
      );
    }

    return true;
  } finally {
    testStream.getTracks().forEach((track) => track.stop());
    testVideo.srcObject = null;
    testVideo.remove();
  }
}
