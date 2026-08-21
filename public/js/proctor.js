// public/js/proctor.js
// The camera stream never leaves the machine. MediaPipe runs in the browser;
// only the event name travels to the database.
import { logIncident } from "./anticheat.js";

const VISION_CDN = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite";

const GRACE_MS = 4000;   // a condition must hold this long before it is logged
const SAMPLE_MS = 500;   // two checks a second

let detector = null, video = null, running = false;
let state = "OK", stateSince = Date.now();
let onState = () => {};

/**
 * @param {HTMLVideoElement} videoEl
 * @param {(state: 'OK'|'NO_FACE_DETECTED'|'MULTIPLE_FACES_DETECTED') => void} cb
 */
export async function startProctoring(videoEl, cb = () => {}) {
  video = videoEl;
  onState = cb;

  const { FaceDetector, FilesetResolver } =
    await import(`${VISION_CDN}/vision_bundle.mjs`);
  const files = await FilesetResolver.forVisionTasks(`${VISION_CDN}/wasm`);
  detector = await FaceDetector.createFromOptions(files, {
    baseOptions: { modelAssetPath: MODEL_URL },
    runningMode: "VIDEO",
  });

  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: 320, height: 240 }, audio: false,
  });
  video.srcObject = stream;
  await video.play();

  running = true;
  loop();
}

function classify(count) {
  if (count === 0) return "NO_FACE_DETECTED";
  if (count > 1) return "MULTIPLE_FACES_DETECTED";
  return "OK";
}

async function loop() {
  if (!running) return;
  try {
    const res = detector.detectForVideo(video, performance.now());
    const now = classify(res.detections.length);

    if (now !== state) {
      state = now;
      stateSince = Date.now();
      onState(state);
    } else if (state !== "OK" && Date.now() - stateSince > GRACE_MS) {
      await logIncident(state, `faces=${res.detections.length}`);
      stateSince = Date.now();   // keep reporting while the condition persists
    }
  } catch {
    /* detector still warming up — ignore this frame */
  }
  setTimeout(loop, SAMPLE_MS);
}

export function stopProctoring() {
  running = false;
  video?.srcObject?.getTracks().forEach((t) => t.stop());
}
