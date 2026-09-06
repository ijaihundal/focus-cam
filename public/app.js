// focus — "All that matters now" revamp (Spotify-minimal)
const $ = (id) => document.getElementById(id);

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
  if (res.status === 401 && !path.includes("/api/login")) { location.href = "/login"; throw new Error("unauth"); }
  return res;
}
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------------- state ----------------
let todos = [];
let music = [];
let drops = [];

// ---------------- views ----------------
const views = ["now", "radio", "board", "music"];
function show(v) {
  views.forEach((x) => { $("view-" + x).hidden = x !== v; });
  document.querySelectorAll("#nav button").forEach((b) => b.classList.toggle("active", b.dataset.v === v));
}
document.querySelectorAll("#nav button").forEach((b) => b.addEventListener("click", () => show(b.dataset.v)));

// ---------------- NOW ----------------
function renderNow() {
  const wrap = $("heroWrap");
  const active = todos.find((t) => t.status === "active");
  const pending = todos.filter((t) => t.status === "pending");
  const done = todos.filter((t) => t.status === "done");

  if (!active && !pending.length) {
    wrap.innerHTML = `<div class="empty-hero panel" style="margin:22px 16px 0;padding:26px 20px">
      <div class="overline" style="margin-bottom:8px">All that matters now is</div>
      <div class="empty-title">Nothing, yet.</div>
      <div style="color:var(--text-dim);margin-top:8px;font-size:14px">An empty board is the easiest place to drift. Pick one thing.</div>
      <button class="chip primary" style="margin-top:16px" onclick="show('board')">Open the board →</button></div>`;
  } else {
    const t = active || pending[0];
    wrap.innerHTML = `<div class="hero">
      <div class="overline">All that matters now is</div>
      <div class="hero-task">${esc(t.title)}</div>
      <div class="hero-meta">${active ? `<span class="eq"><i></i><i></i><i></i></span> in progress` : "tap the chip to start"}
        ${pending.length ? ` · ${pending.length} in queue` : ""}</div>
      <div class="hero-actions">
        ${active ? `<button class="chip primary" id="heroDone">Done ✓</button>` : `<button class="chip primary" id="heroStart">Start now ▸</button>`}
        <button class="chip" id="heroSkip">Skip</button>
      </div></div>`;
    if (active) $("heroDone").onclick = () => completeTodo(t.id);
    else $("heroStart").onclick = () => setActive(t.id);
    $("heroSkip").onclick = () => skipTodo(t.id);
  }

  $("queueList").innerHTML = pending.length
    ? pending.map((t, i) => `<li class="track" data-id="${t.id}"><div class="num">${i + 1}</div>
        <div class="body"><div class="title">${esc(t.title)}</div></div>
        <button class="check" data-start="${t.id}" aria-label="start">▶</button></li>`).join("")
    : `<li class="track"><div class="body" style="color:var(--text-dim)">Queue is clear.</div></li>`;

  $("doneList").innerHTML = done.length
    ? done.map((t) => `<li class="track done"><div class="num">✓</div><div class="body"><div class="title">${esc(t.title)}</div></div></li>`).join("")
    : "";
  $("doneList").closest(".section").hidden = !done.length;
  document.querySelectorAll("[data-start]").forEach((b) => b.addEventListener("click", () => setActive(b.dataset.start)));
  // board nav visibility
  const navOK = todos.length > 0;
  $("nav").classList.add("show");
}

// ---------------- BOARD ----------------
function renderBoard() {
  const order = { active: 0, pending: 1, done: 2 };
  const sorted = [...todos].sort((a, b) => order[a.status] - order[b.status]);
  $("boardList").innerHTML = sorted.length
    ? sorted.map((t) => `<li class="track ${t.status === "done" ? "done" : ""} ${t.status === "active" ? "np" : ""}">
        <div class="num">${t.status === "active" ? `<span class="eq"><i></i><i></i><i></i></span>` : t.status === "done" ? "✓" : sorted.indexOf(t) + 1}</div>
        <div class="body"><div class="title">${esc(t.title)}</div><div class="sub">${t.status === "active" ? "all that matters now" : t.status === "done" ? "done" : "queued"}</div></div>
        <button class="check" data-toggle="${t.id}">${t.status === "done" ? "↺" : t.status === "active" ? "■" : "▶"}</button></li>`).join("")
    : `<li class="track"><div class="body" style="color:var(--text-dim)">Nothing here. Add the first thing above.</div></li>`;
  $("boardSub").textContent = `${todos.filter((t) => t.status !== "done").length} live · ${todos.filter((t) => t.status === "done").length} done today`;
  document.querySelectorAll("[data-toggle]").forEach((b) => b.addEventListener("click", () => {
    const id = b.dataset.toggle; const t = todos.find((x) => x.id === id); if (!t) return;
    if (t.status === "pending") setActive(id);
    else if (t.status === "active") completeTodo(id);
    else reopenTodo(id);
  }));
}

async function pushTodos() {
  await api("/api/todos", { method: "PUT", body: JSON.stringify(todos) });
  renderAll();
}
function setActive(id) { todos = todos.map((t) => ({ ...t, status: t.id === id ? "active" : t.status === "active" ? "pending" : t.status })); pushTodos(); }
function completeTodo(id) { todos = todos.map((t) => (t.id === id ? { ...t, status: "done" } : t)); const next = todos.find((t) => t.status === "pending"); if (next) todos = todos.map((t) => (t.id === next.id ? { ...t, status: "active" } : t)); pushTodos(); }
function reopenTodo(id) { todos = todos.map((t) => (t.id === id ? { ...t, status: "pending" } : t)); pushTodos(); }
function skipTodo(id) { const i = todos.findIndex((t) => t.id === id); const pend = todos.filter((t) => t.status === "pending" && t.id !== id); if (pend.length) setActive(pend[0].id); else renderAll(); }
function renderAll() { renderNow(); renderBoard(); renderMusic(); }

$("addBtn").addEventListener("click", addTask);
$("addInput").addEventListener("keydown", (e) => { if (e.key === "Enter") addTask(); });
// task added from UI → flag for the warden's next 4-min chore window
let choreNote = null;
function addTask() {
  const v = $("addInput").value.trim(); if (!v) return;
  const id = String(Date.now());
  const none = !todos.some((t) => t.status === "active" || t.status === "pending");
  todos.push({ id, title: v.slice(0, 200), status: none ? "active" : "pending", note: "" });
  choreNote = v.slice(0, 200); // warden will acknowledge next drop
  $("addInput").value = "";
  pushTodos();
  fetch("/api/chores", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "task_added", title: choreNote }) }).catch(() => {});
}

// ---------------- RADIO ----------------
function renderRadio() {
  const d = drops[0];
  $("latestDrop").innerHTML = d ? `
    <div class="overline">Latest drop · ${new Date(d.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</div>
    <div class="msg">${esc(d.message)}</div>
    <audio controls preload="none" src="${d.url}${d.mime === "audio/mpeg" ? "" : ""}" id="radioAudio"></audio>` : "No drops yet.";
  $("dropList").innerHTML = drops.length > 1
    ? drops.slice(1, 21).map((x) => `<li class="track drop"><div class="when">${new Date(x.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</div>
        <div class="body"><div class="title" style="font-weight:500">${esc(x.message)}</div></div></li>`).join("")
    : `<li class="track"><div class="body" style="color:var(--text-dim)">History builds every 4 minutes.</div></li>`;
}

// ---------------- MUSIC ----------------
function renderMusic() {
  $("musicList").innerHTML = music.length
    ? music.map((m, i) => `<li class="track mt ${m.playing ? "playing" : ""}">
        ${m.cover ? `<img class="art" src="${m.cover}" alt="">` : `<div class="art" style="display:flex;align-items:center;justify-content:center">♪</div>`}
        <div class="body"><div class="title">${esc(m.title)}</div><div class="sub">${esc(m.artist || "YouTube")}</div></div>
        <button class="check" data-play="${i}">${m.playing ? "❚❚" : "▶"}</button></li>`).join("")
    : `<li class="track"><div class="body" style="color:var(--text-dim)">Paste a YouTube link above, or a list of them, one per line. Covers and titles index automatically.</div></li>`;
  document.querySelectorAll("[data-play]").forEach((b) => b.addEventListener("click", () => playMusic(music[b.dataset.play])));
}

// ---------------- persistent player ----------------
let curAudio = null, curMode = null; // mode: 'drop' | 'music'
const playedClips = new Set();
let musicListening = false;
let musicStoppedAt = 0;

// tell backend we're listening to music (warden stays quiet)
function reportMusicState() {
  fetch("/api/music-state", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ listening: musicListening }) }).catch(() => {});
}
setInterval(reportMusicState, 60000);
function stopCurrent() { if (curAudio) { curAudio.pause(); if (curMode === "music") music.forEach((m) => (m.playing = false)); } }
function setBar(label, what, playing, icon) {
  $("pbar").hidden = false; $("pbLabel").textContent = label; $("pbWhat").textContent = what;
  $("pbArt").textContent = icon; $("pbPlay").textContent = playing ? "❚❚" : "▶";
}
function playDrop(d) {
  stopCurrent(); curMode = "drop";
  curAudio = new Audio(d.url);
  curAudio.play().catch(() => {});
  setBar("Warden radio", d.message || "orientation", true, "🎙");
  curAudio.onended = () => setBar("Warden radio", d.message, false, "🎙");
  $("pbPlay").onclick = () => { if (curAudio.paused) { curAudio.play(); setBar("Warden radio", d.message, true, "🎙"); } else { curAudio.pause(); setBar("Warden radio", d.message, false, "🎙"); } };
  if ("mediaSession" in navigator) navigator.mediaSession.metadata = new MediaMetadata({ title: d.message?.slice(0, 60) || "Warden radio", artist: "Sam · the warden", album: "focus" });
}
function playMusic(m) {
  if (!m || !m.url) return;
  stopCurrent(); curMode = "music";
  music.forEach((x) => (x.playing = false)); m.playing = true; renderMusic();
  musicListening = true; reportMusicState(); // warden: hold your fire
  curAudio = new Audio(m.url);
  curAudio.play().catch(() => {});
  setBar("Music", m.title, true, "♫");
  curAudio.onended = () => nextMusic(m);
  $("pbPlay").onclick = () => {
    if (curAudio.paused) { curAudio.play(); m.playing = true; setBar("Music", m.title, true, "♫"); }
    else { curAudio.pause(); m.playing = false; setBar("Music", m.title, false, "♫"); }
    musicListening = m.playing;
    if (!m.playing) musicStoppedAt = Date.now();
    reportMusicState();
    renderMusic();
  };
  if ("mediaSession" in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({ title: m.title, artist: m.artist || "YouTube", album: "focus", artwork: m.cover ? [{ src: m.cover, sizes: "512x512" }] : [] });
    navigator.mediaSession.setActionHandler("nexttrack", () => nextMusic(m));
  }
}
function nextMusic(cur) {
  cur.playing = false;
  const i = music.indexOf(cur); const next = music[(i + 1) % music.length];
  if (next) playMusic(next);
  else { musicListening = false; musicStoppedAt = Date.now(); reportMusicState(); }
}

// ---------------- SSE ----------------
function connectSSE() {
  const es = new EventSource("/api/events");
  es.addEventListener("todos", (e) => { todos = JSON.parse(e.data); renderNow(); renderBoard(); });
  es.addEventListener("audio", (e) => {
    const clip = JSON.parse(e.data);
    if (playedClips.has(clip.url)) return; // dedupe — never double-play
    playedClips.add(clip.url);
    drops.unshift(clip); drops = drops.slice(0, 25);
    renderRadio();
    if (curMode === "music" && musicListening) {
      // don't interrupt music; it lands in Radio history instead
      setStatus("Warden dropped wisdom — find it in Radio.", "ok");
      return;
    }
    playDrop(clip);
  });
}

// ---------------- music indexing ----------------
$("linkBtn").addEventListener("click", async () => {
  const raw = $("linkInput").value.trim(); if (!raw) return;
  $("musicStatus").textContent = "Indexing…";
  const r = await api("/api/music", { method: "POST", body: JSON.stringify({ links: raw }) });
  const j = await r.json();
  $("musicStatus").textContent = j.ok ? `Queued ${j.added} item${j.added === 1 ? "" : "s"} for indexing — covers and titles land in a minute.` : (j.error || "Failed");
  $("linkInput").value = "";
  loadMusic();
});

async function loadMusic() {
  try { const r = await api("/api/music"); music = await r.json(); renderMusic(); } catch (_) {}
}

// ---------------- boot ----------------
(async function boot() {
  try {
    const [t, d, m] = await Promise.all([
      api("/api/todos").then((r) => r.json()),
      api("/api/drops").then((r) => r.json()).catch(() => []),
      loadMusic(),
    ]);
    todos = t; drops = d; renderNow(); renderBoard(); renderRadio();
    connectSSE();
    $("nav").classList.add("show");
  } catch (_) {}
})();
