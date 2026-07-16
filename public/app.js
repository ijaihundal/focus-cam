const $ = (id) => document.getElementById(id);

// ---- Logout ----
$("logoutBtn")?.addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" });
  window.location.href = "/login";
});

// ---- View switching ----
document.querySelectorAll(".tab").forEach((t) => {
  t.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
    t.classList.add("active");
    const view = t.dataset.view;
    $("view-record").style.display = view === "record" ? "" : "none";
    $("view-library").style.display = view === "library" ? "" : "none";
    if (view === "library") loadLibrary();
  });
});

// ---- Recording state ----
let stream = null;
let recorder = null;
let sessionName = null;
let segmentIndex = 0;
let recording = false;
let segTimer = null;
let elapsedTimer = null;
let startedAt = 0;
let pickedMime = "video/webm";

const preview = $("preview");
const recBadge = $("recBadge");

function setStatus(msg, kind) {
  const el = $("status");
  el.textContent = msg || "";
  el.className = "status" + (kind ? " " + kind : "");
}

function fmtTime(ms) {
  const s = Math.floor(ms / 1000);
  const hh = String(Math.floor(s / 3600)).padStart(2, "0");
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function tickTimer() {
  $("timer").textContent = fmtTime(Date.now() - startedAt);
}

// Pick the best mime type the browser actually supports.
function pickMime() {
  const candidates = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
    "video/mp4",
  ];
  for (const c of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(c)) return c;
  }
  return "video/webm";
}

async function startSession() {
  if (!navigator.mediaDevices || !window.MediaRecorder) {
    setStatus("This browser can't record. Use Chrome or Safari.", "err");
    return;
  }
  const q = $("quality").value;
  const height = parseInt(q, 10);
  const width = Math.round((height * 16) / 9);
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: width }, height: { ideal: height }, facingMode: "user" },
      audio: true,
    });
  } catch (e) {
    // Retry without audio in case mic permission was denied.
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: width }, height: { ideal: height }, facingMode: "user" },
        audio: false,
      });
      setStatus("Recording video only (no mic permission).", "ok");
    } catch (e2) {
      setStatus("Could not access camera: " + e2.message, "err");
      return;
    }
  }

  pickedMime = pickMime();
  preview.srcObject = stream;
  $("placeholder").style.display = "none";
  recording = true;
  segmentIndex = 0;
  const now = new Date();
  const stamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  sessionName = `session_${stamp}`;
  startedAt = Date.now();
  tickTimer();
  elapsedTimer = setInterval(tickTimer, 1000);
  recBadge.classList.add("show");

  $("startBtn").disabled = true;
  $("stopBtn").disabled = false;
  $("quality").disabled = true;

  setStatus("Recording…", "ok");
  await startSegment();
}

async function startSegment() {
  if (!recording) return;
  segmentIndex++;
  $("recText").textContent = `REC · segment ${segmentIndex}`;

  // Each segment gets a fresh recorder so every saved file is independently playable.
  const chunks = [];
  try {
    recorder = new MediaRecorder(stream, { mimeType: pickedMime });
  } catch {
    recorder = new MediaRecorder(stream);
  }
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };
  recorder.onstop = async () => {
    const blob = new Blob(chunks, { type: pickedMime });
    if (blob.size > 0) await uploadSegment(blob, segmentIndex);
    if (recording) startSegment(); // roll into the next segment
  };
  recorder.start();

  const minutes = parseInt($("segLen").value, 10);
  segTimer = setTimeout(() => {
    if (recorder.state !== "inactive") recorder.stop();
  }, minutes * 60 * 1000);
}

async function uploadSegment(blob, seg) {
  const ext = pickedMime.includes("mp4") ? "mp4" : "webm";
  const form = new FormData();
  form.append("video", blob, `seg_${seg}.${ext}`);
  let attempt = 0;
  while (attempt < 5) {
    try {
      const r = await fetch(`/api/upload/${sessionName}/${seg}?ext=${ext}`, {
        method: "POST",
        body: form,
      });
      if (r.ok) {
        setStatus(`Saved segment ${seg} (${(blob.size / 1048576).toFixed(1)} MB)`, "ok");
        return;
      }
    } catch (_) {}
    attempt++;
    setStatus(`Retrying segment ${seg}… (attempt ${attempt})`, "err");
    await new Promise((res) => setTimeout(res, 2000 * attempt));
  }
  setStatus(`Failed to save segment ${seg}.`, "err");
}

function stopSession() {
  recording = false;
  clearTimeout(segTimer);
  clearInterval(elapsedTimer);
  // The active segment's onstop handler will still upload its chunk,
  // then see recording===false and NOT start a new segment. That's our final save.
  if (recorder && recorder.state !== "inactive") recorder.stop();
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  preview.srcObject = null;
  $("placeholder").style.display = "";
  recBadge.classList.remove("show");
  $("startBtn").disabled = false;
  $("stopBtn").disabled = true;
  $("quality").disabled = false;
  setStatus("Session saved. Check the Library.", "ok");
  loadDisk();
}

$("startBtn").addEventListener("click", startSession);
$("stopBtn").addEventListener("click", stopSession);

// ---- Library ----
async function loadLibrary() {
  const box = $("sessions");
  box.innerHTML = '<div class="empty">Loading…</div>';
  try {
    const res = await fetch("/api/recordings");
    const data = await res.json();
    if (!data.length) {
      box.innerHTML = '<div class="empty">No sessions yet. Go record your first study session!</div>';
      return;
    }
    box.innerHTML = "";
    for (const s of data) {
      const det = document.createElement("details");
      det.className = "session";
      const sum = document.createElement("summary");
      const mb = (s.size / 1048576).toFixed(1);
      sum.innerHTML = `
        <div>
          <div class="s-title">Session ${s.created || s.session}</div>
          <div class="s-meta">${s.segments} segment${s.segments !== 1 ? "s" : ""} · ${mb} MB</div>
        </div>`;
      const del = document.createElement("button");
      del.className = "s-del";
      del.textContent = "Delete";
      del.onclick = async (e) => {
        e.preventDefault();
        if (!confirm("Delete this whole session?")) return;
        await fetch(`/api/recordings/${s.session}`, { method: "DELETE" });
        loadLibrary();
        loadDisk();
      };
      sum.appendChild(del);
      det.appendChild(sum);

      const segWrap = document.createElement("div");
      segWrap.className = "segs";
      for (const f of s.files) {
        const row = document.createElement("div");
        row.className = "seg";
        const idx = (f.match(/seg_(\d+)/) || [, "?"])[1];
        const v = document.createElement("video");
        v.src = `/api/recordings/${s.session}/${f}`;
        v.controls = true;
        v.preload = "metadata";
        const lab = document.createElement("div");
        lab.className = "s-meta";
        lab.textContent = `Segment ${idx}`;
        row.appendChild(v);
        row.appendChild(lab);
        segWrap.appendChild(row);
      }
      det.appendChild(segWrap);
      box.appendChild(det);
    }
  } catch (e) {
    box.innerHTML = '<div class="empty">Could not load sessions.</div>';
  }
}

async function loadDisk() {
  try {
    const r = await fetch("/api/stats");
    const d = await r.json();
    const mb = d.bytes / 1048576;
    const txt = mb >= 1024 ? (mb / 1024).toFixed(2) + " GB" : mb.toFixed(0) + " MB";
    $("disk").textContent = `${d.files} files · ${txt}`;
  } catch (_) {}
}

loadDisk();

// Keep screen awake during recording (best effort).
let wakeLock = null;
document.getElementById("startBtn").addEventListener("click", async () => {
  try {
    wakeLock = await navigator.wakeLock.request("screen");
  } catch (_) {}
});
document.getElementById("stopBtn").addEventListener("click", () => {
  if (wakeLock) { wakeLock.release(); wakeLock = null; }
});
