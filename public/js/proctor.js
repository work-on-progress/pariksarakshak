// public/js/proctor.js
// The camera stream never leaves the machine. MediaPipe runs in the browser and
// only the event name travels to the database — there is no video to store.
import { logIncident } from "./anticheat.js";
import { FACE_GRACE_MS } from "./config.js";

const VISION_CDN = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite";

const SAMPLE_MS = 500;   // two checks a second

let detector = null, video = null, running = false;
let state = "OK", stateSince = Date.now();
let onState = () => {};

export async function startProctoring(videoEl, cb = () => {}) {
  video = videoEl;
  onState = cb;

  const { FaceDetector, FilesetResolver } = await import(`${VISION_CDN}/vision_bundle.mjs`);
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
    } else if (state !== "OK" && Date.now() - stateSince > FACE_GRACE_MS) {
      await logIncident(state, `faces=${res.detections.length}`);
      stateSince = Date.now();      // keep reporting while it persists
    }
  } catch {
    /* the detector is still warming up — skip this frame */
  }
  setTimeout(loop, SAMPLE_MS);
}

export function stopProctoring() {
  running = false;
  video?.srcObject?.getTracks().forEach((t) => t.stop());
}

/** Used by the setup check: does a camera exist and can we open it? */
export async function cameraProbe() {
  const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
  stream.getTracks().forEach((t) => t.stop());
  return true;
}
