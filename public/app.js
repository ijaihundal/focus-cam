const $ = (id) => document.getElementById(id);

// Kill pinch-zoom on iOS Safari (native feel).
document.addEventListener("gesturestart", (e) => e.preventDefault());

// ---- Tiny fetch wrapper: bounce to login on session loss ----
async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (res.status === 401 && !path.includes("/api/login")) {
    window.location.href = "/login";
    throw new Error("unauthenticated");
  }
  return res;
}

function setStatus(msg, kind) {
  const el = $("status");
  el.textContent = msg || "";
  el.className = "status show" + (kind ? " " + kind : "");
  clearTimeout(setStatus._t);
  if (msg) setStatus._t = setTimeout(() => (el.className = "status"), 2600);
}

// ---- View switching (bottom nav) ----
document.querySelectorAll(".navbtn").forEach((t) => {
  t.addEventListener("click", () => {
    document.querySelectorAll(".navbtn").forEach((x) => x.classList.remove("active"));
    t.classList.add("active");
    const view = t.dataset.view;
    $("view-record").style.display = view === "record" ? "" : "none";
    $("view-library").style.display = view === "library" ? "" : "none";
    if (view === "library") loadLibrary();
  });
});

// ---- Logout ----
$("logoutBtn").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" });
  window.location.href = "/login";
});

// ===================== LIVE STATE (SSE) =====================

let todos = [];
let judgeConfig = { judgeMode: "agent", judgeIntervalSec: 60 };

function activeTodo() {
  return todos.find((t) => t.status === "active") || todos.find((t) => t.status === "pending") || null;
}

function renderTodos() {
  const list = $("todoList");
  if (!todos.length) {
    list.innerHTML = '<li class="empty">No tasks yet — the agent sets them.</li>';
  } else {
    list.innerHTML = "";
    for (const t of todos) {
      const li = document.createElement("li");
      li.className = "todo" + (t.status === "done" ? " done" : "") + (t.status === "active" ? " active" : "");
      const box = document.createElement("button");
      box.className = "todo-check";
      box.textContent = t.status === "done" ? "✓" : "";
      box.addEventListener("click", async () => {
        const next = todos.map((x) =>
          x.id === t.id ? { ...x, status: x.status === "done" ? "pending" : "done" } : x
        );
        await api("/api/todos", { method: "PUT", body: JSON.stringify(next) });
        // SSE will echo the change back; render optimistically too.
        todos = next;
        renderTodos();
      });
      const body = document.createElement("div");
      body.className = "todo-body";
      const title = document.createElement("div");
      title.className = "todo-title";
      title.textContent = t.title;
      body.appendChild(title);
      if (t.note) {
        const note = document.createElement("div");
        note.className = "todo-note";
        note.textContent = t.note;
        body.appendChild(note);
      }
      li.appendChild(box);
      li.appendChild(body);
      list.appendChild(li);
    }
  }

  const now = activeTodo();
  $("nowTask").textContent = now ? now.title : "Nothing scheduled";
  const pending = todos.filter((t) => t.status === "pending").length;
  $("nowMeta").textContent = now
    ? pending > 1 ? `— ${pending - 0} in queue` : "— last one"
    : "—";
}

function verdictBadge(v) {
  if (v === "on_task") return '<span class="badge on">ON TASK</span>';
  if (v === "off_task") return '<span class="badge off">OFF TASK</span>';
  if (v === "message") return '<span class="badge msg">WORD</span>';
  return '<span class="badge unclear">UNCLEAR</span>';
}

function prependVerdict(v) {
  const box = $("verdicts");
  const empty = box.querySelector(".empty");
  if (empty) empty.remove();
  const el = document.createElement("div");
  el.className = "verdict";
  const time = new Date(v.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  el.innerHTML = `
    <div class="verdict-top">${verdictBadge(v.verdict)}<span class="verdict-time">${time} · ${v.source === "vlm" ? "on-device" : "agent"}</span></div>
    ${v.message ? `<div class="verdict-msg">${escapeHtml(v.message)}</div>` : ""}
    ${v.note ? `<div class="verdict-note">${escapeHtml(v.note)}</div>` : ""}`;
  box.prepend(el);
  while (box.children.length > 30) box.lastChild.remove();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function connectSSE() {
  const es = new EventSource("/api/events");
  const setLive = (ok) => {
    $("liveDot").classList.toggle("down", !ok);
    $("liveText").textContent = ok ? "live" : "reconnecting";
  };
  es.onopen = () => setLive(true);
  es.onerror = () => setLive(false);
  es.addEventListener("todos", (e) => {
    todos = JSON.parse(e.data);
    renderTodos();
    $("todosUpdated").textContent = "updated " + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  });
  es.addEventListener("verdict", (e) => prependVerdict(JSON.parse(e.data)));
  es.addEventListener("presence", (e) => {
    const p = JSON.parse(e.data);
    if (!p.recording && recording) return; // our own state rules
  });
}

async function loadInitialState() {
  try {
    const [cfgRes, todosRes, verdictsRes] = await Promise.all([
      api("/api/config"),
      api("/api/todos"),
      api("/api/verdicts"),
    ]);
    judgeConfig = await cfgRes.json();
    if (judgeConfig.judgeMode === "off") {
      document.querySelector(".feed-card")?.remove();
      document.querySelector(".cam-settings")?.closest(".cam-card")?.insertAdjacentElement(
        "afterend",
        document.querySelector(".todos-card")
      );
    }
    todos = await todosRes.json();
    renderTodos();
    for (const v of await verdictsRes.json()) prependVerdict(v);
  } catch (_) {}
}

// ===================== RECORDING =====================

let stream = null;
let recorder = null;
let sessionName = null;
let segmentIndex = 0;
let recording = false;
let segTimer = null;
let elapsedTimer = null;
let heartTimer = null;
let frameTimer = null;
let startedAt = 0;
let pickedMime = "video/webm";
let wakeLock = null;

const preview = $("preview");

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
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: width }, height: { ideal: height }, facingMode: "user" },
        audio: false,
      });
      setStatus("Video only (no mic permission).", "ok");
    } catch (e2) {
      setStatus("Camera access failed: " + e2.message, "err");
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
  document.body.classList.add("recording");
  $("startBtn").classList.add("rolling");

  setStatus("Recording — the warden is watching.", "ok");
  heartbeat();
  heartTimer = setInterval(heartbeat, 30000);
  startFrameLoop();
  try {
    wakeLock = await navigator.wakeLock.request("screen");
  } catch (_) {}
  await startSegment();
}

async function startSegment() {
  if (!recording) return;
  segmentIndex++;
  $("recText").textContent = `REC · ${segmentIndex}`;

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
    if (recording) startSegment();
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
    setStatus(`Retrying segment ${seg}… (${attempt})`, "err");
    await new Promise((res) => setTimeout(res, 2000 * attempt));
  }
  setStatus(`Failed to save segment ${seg}.`, "err");
}

// ---- Frame loop: one still per judge interval while recording ----
const frameCanvas = document.createElement("canvas");

function startFrameLoop() {
  const interval = (judgeConfig.judgeIntervalSec || 60) * 1000;
  captureFrame(); // immediate first frame
  frameTimer = setInterval(captureFrame, interval);
}

async function captureFrame() {
  if (!recording || !stream) return;
  const trackSettings = stream.getVideoTracks()[0]?.getSettings?.();
  const vw = trackSettings?.width || 640;
  const vh = trackSettings?.height || 480;
  const w = 480;
  const h = Math.round((vh / vw) * w);
  frameCanvas.width = w;
  frameCanvas.height = h;
  const ctx = frameCanvas.getContext("2d");
  ctx.drawImage(preview, 0, 0, w, h);
  const blob = await new Promise((r) => frameCanvas.toBlob(r, "image/jpeg", 0.72));
  if (!blob) return;
  const form = new FormData();
  form.append("frame", blob, "frame.jpg");
  try {
    const r = await fetch("/api/frame", { method: "POST", body: form });
    if (!r.ok) throw new Error();
  } catch {
    setStatus("Frame upload failed — will retry next tick.", "err");
    return;
  }
  // On-device VLM path (graft point, ships separately). When judge mode is
  // "vlm" the phone itself judges the frame; otherwise the agent does it
  // server-side off the stored frame.
  if (judgeConfig.judgeMode === "vlm" && typeof window.runLocalJudge === "function") {
    try {
      const verdict = await window.runLocalJudge(blob);
      if (verdict) await api("/api/verdict", { method: "POST", body: JSON.stringify(verdict) });
    } catch (_) {}
  }
}

async function heartbeat() {
  try {
    await api("/api/heartbeat", {
      method: "POST",
      body: JSON.stringify({ recording, session: sessionName }),
    });
  } catch (_) {}
}

function stopSession() {
  recording = false;
  clearTimeout(segTimer);
  clearInterval(elapsedTimer);
  clearInterval(heartTimer);
  clearInterval(frameTimer);
  if (recorder && recorder.state !== "inactive") recorder.stop();
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  preview.srcObject = null;
  $("placeholder").style.display = "";
  document.body.classList.remove("recording");
  $("startBtn").classList.remove("rolling");
  heartbeat();
  if (wakeLock) {
    wakeLock.release();
    wakeLock = null;
  }
  setStatus("Session saved. Check the Library.", "ok");
  loadDisk();
}

$("startBtn").addEventListener("click", () => (recording ? stopSession() : startSession()));

// ===================== LIBRARY =====================

async function loadLibrary() {
  const box = $("sessions");
  box.innerHTML = '<div class="empty">Loading…</div>';
  try {
    const res = await api("/api/recordings");
    const data = await res.json();
    if (!data.length) {
      box.innerHTML = '<div class="empty">No sessions yet.</div>';
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
        await api(`/api/recordings/${s.session}`, { method: "DELETE" });
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
        v.playsInline = true;
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
    const r = await api("/api/stats");
    const d = await r.json();
    const mb = d.bytes / 1048576;
    const txt = mb >= 1024 ? (mb / 1024).toFixed(2) + " GB" : mb.toFixed(0) + " MB";
    $("disk").textContent = `${d.files} files · ${txt}`;
  } catch (_) {}
}

// ---- Boot ----
loadDisk();
loadInitialState();
connectSSE();
