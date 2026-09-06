// focus v3 — app shell: player engine, dual versions, spotify spine
const $ = (id) => document.getElementById(id);

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
  if (res.status === 401 && !path.includes("/api/login")) { location.href = "/login"; throw new Error("unauth"); }
  return res;
}
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (s) => (isFinite(s) ? `${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,"0")}` : "0:00");

function toast(msg, kind = "ok") {
  const t = document.createElement("div");
  t.className = `toast ${kind}`;
  t.textContent = msg;
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add("in"));
  setTimeout(() => { t.classList.remove("in"); setTimeout(() => t.remove(), 300); }, 2600);
}

// ============================================================
// PLAYER ENGINE — the spine. One audio element, one state object.
// ============================================================
const player = {
  queue: [],        // array of track objects {id,title,artist,cover,url,urlSub,from}
  index: -1,
  playing: false,
  shuffle: false,
  repeat: "off",    // off | all | one
  version: localStorage.getItem("focus_ver") || "clean", // clean | sub
  volume: parseFloat(localStorage.getItem("focus_vol") ?? "1"),
  history: JSON.parse(localStorage.getItem("focus_hist") || "[]"),
  audio: new Audio(),
  _seeking: false,
};
player.audio.volume = player.volume;

function cur() { return player.queue[player.index] || null; }
function trackSrc(t) { return !t ? null : player.version === "sub" ? (t.urlSub || t.url) : t.url; }

function savePlayer() {
  try {
    localStorage.setItem("focus_player", JSON.stringify({
      queue: player.queue, index: player.index, shuffle: player.shuffle,
      repeat: player.repeat, version: player.version,
      t: player.audio.currentTime || 0,
    }));
  } catch {}
}
function pushHistory(t) {
  player.history = [{ id: t.id, title: t.title, artist: t.artist, cover: t.cover, at: Date.now() },
    ...player.history.filter((x) => x.id !== t.id)].slice(0, 50);
  localStorage.setItem("focus_hist", JSON.stringify(player.history));
}

function playTrack(i, enqueueRest = null) {
  if (enqueueRest) {
    // play this one, queue the rest after (album/playlist click)
    const t = enqueueRest[i];
    player.queue = [t, ...enqueueRest.filter((_, j) => j !== i)];
    player.index = 0;
  } else {
    if (i < 0 || i >= player.queue.length) return;
    if (i === player.index && player.audio.src) { resume(); return; }
    player.index = i;
  }
  loadCurrent(true);
}
function loadCurrent(autoplay) {
  const t = cur(); if (!t) return;
  player.audio.src = trackSrc(t);
  player.playing = !!autoplay;
  if (autoplay) player.audio.play().catch(() => { player.playing = false; renderPlayer(); toast("Tap play to start (browser rule)", "warn"); });
  pushHistory(t);
  renderPlayer(); renderAllViews();
  savePlayer();
}
function resume() { player.audio.play().catch(() => {}); player.playing = true; renderPlayer(); }
function pause() { player.audio.pause(); player.playing = false; renderPlayer(); savePlayer(); }
function toggle() { if (!cur()) { playQueueOrShuffle(); return; } player.playing ? pause() : resume(); }
function next(auto = false) {
  if (auto && player.repeat === "one") { player.audio.currentTime = 0; player.audio.play(); return; }
  if (player.shuffle && player.queue.length > 1) {
    let r; do { r = Math.floor(Math.random() * player.queue.length); } while (r === player.index);
    player.index = r;
  } else if (player.index < player.queue.length - 1) player.index++;
  else if (player.repeat === "all" || !auto) player.index = 0;
  else { player.playing = false; renderPlayer(); savePlayer(); return; }
  loadCurrent(true);
}
function prev() {
  if (player.audio.currentTime > 3) { player.audio.currentTime = 0; return; }
  player.index = player.index > 0 ? player.index - 1 : player.queue.length - 1;
  loadCurrent(true);
}
function seekTo(frac) { if (player.audio.duration) player.audio.currentTime = frac * player.audio.duration; }
function setVolume(v) { player.volume = v; player.audio.volume = v; localStorage.setItem("focus_vol", String(v)); renderPlayer(); }
function setVersion(v) {
  const t = cur(); if (!t) { player.version = v; localStorage.setItem("focus_ver", v); renderPlayer(); return; }
  const was = player.audio.currentTime;
  const wasPlaying = player.playing;
  player.version = v; localStorage.setItem("focus_ver", v);
  if (v === "sub" && !t.urlSub) sublimate(t, () => { swapMid(t, wasPlaying); });
  else swapMid(t, wasPlaying);
}
function swapMid(t, wasPlaying) {
  const at = player.audio.currentTime;
  player.audio.src = trackSrc(t);
  player.audio.currentTime = at; // restore position
  if (wasPlaying) player.audio.play().catch(() => {});
  setMediaSession(t);
  renderPlayer(); renderAllViews();
  toast(player.version === "sub" ? "Affirmation version on" : "Clean version", "ok");
}
function sublimate(t, cb) {
  toast("Mixing affirmation version…", "ok");
  api(`/api/music/${t.id}/sublimate`, { method: "POST" }).then((r) => r.json()).then((j) => {
    if (j.ok) { t.urlSub = `/api/music/${t.id}/audio_sub.mp3`; cb && cb(); }
    else toast("Mix failed, staying clean", "warn");
  }).catch(() => toast("Mix failed", "warn"));
}
function playQueueOrShuffle() {
  if (!library.length) { toast("Library is empty — add links in Search", "warn"); return; }
  player.shuffle = !player.shuffle; renderPlayer();
  const order = [...library];
  playTrack(0, order);
}

player.audio.addEventListener("ended", () => next(true));
player.audio.addEventListener("timeupdate", () => { if (!player._seeking) renderProgress(); });
player.audio.addEventListener("play", () => { player.playing = true; renderPlayer(); reportMusic(true); });
player.audio.addEventListener("pause", () => { player.playing = false; renderPlayer(); reportMusic(false); savePlayer(); });
setInterval(savePlayer, 10000);
window.addEventListener("beforeunload", savePlayer);

// media session
if ("mediaSession" in navigator) {
  navigator.mediaSession.setActionHandler("play", resume);
  navigator.mediaSession.setActionHandler("pause", pause);
  navigator.mediaSession.setActionHandler("nexttrack", () => next());
  navigator.mediaSession.setActionHandler("previoustrack", prev);
}
function setMediaSession(t) {
  if (!("mediaSession" in navigator) || !t) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: t.title, artist: t.artist || "YouTube", album: player.version === "sub" ? "focus · affirmations" : "focus",
    artwork: t.cover ? [{ src: t.cover, sizes: "512x512" }] : [],
  });
}
const _loadCurrent = loadCurrent;
loadCurrent = function (autoplay) { _loadCurrent(autoplay); setMediaSession(cur()); };

// warden DND heartbeat
let musicListening = false;
function reportMusic(on) {
  musicListening = on;
  fetch("/api/music-state", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ listening: on }) }).catch(() => {});
}
setInterval(() => reportMusic(musicListening), 60000);

// ============================================================
// LIBRARY / SEARCH
// ============================================================
let library = [];
let searchQ = "";

async function loadMusic() {
  try {
    const r = await api("/api/music");
    library = await r.json();
    library.forEach((m) => { m.urlSub = m.hasSub ? `/api/music/${m.id}/audio_sub.mp3` : null; });
    // reconcile current track's urlSub
    const t = cur();
    if (t) { const m = library.find((x) => x.id === t.id); if (m) t.urlSub = m.urlSub; }
    renderAllViews();
  } catch {}
}

$("linkBtn").addEventListener("click", async () => {
  const raw = $("linkInput").value.trim(); if (!raw) return;
  $("musicStatus").textContent = "Indexing…";
  const r = await api("/api/music", { method: "POST", body: JSON.stringify({ links: raw }) });
  const j = await r.json();
  $("musicStatus").textContent = j.ok ? `Queued ${j.added} for indexing — covers land in seconds.` : (j.error || "Failed");
  $("linkInput").value = "";
  loadMusic();
});
$("searchInput").addEventListener("input", (e) => { searchQ = e.target.value.toLowerCase(); renderLibrary(); });
$("searchInput").addEventListener("keydown", (e) => { if (e.key === "Enter") $("searchInput").blur(); });

function filteredLibrary() {
  if (!searchQ) return library;
  return library.filter((m) => (m.title || "").toLowerCase().includes(searchQ) || (m.artist || "").toLowerCase().includes(searchQ));
}

// ============================================================
// TODOS (unchanged protocol, kept intact)
// ============================================================
let todos = [];
let drops = [];
function renderAllViews() { renderLibrary(); renderNow(); renderBoard(); renderRadio(); }

function renderNow() {
  const wrap = $("heroWrap");
  const active = todos.find((t) => t.status === "active");
  const pending = todos.filter((t) => t.status === "pending");
  const done = todos.filter((t) => t.status === "done");
  if (!active && !pending.length) {
    wrap.innerHTML = `<div class="hero"><div class="overline">All that matters now is</div>
      <div class="hero-task dim">Nothing, yet.</div>
      <div class="hero-meta">An empty board is the easiest place to drift. Pick one thing.</div>
      <div class="hero-actions"><button class="chip primary" onclick="show('board')">Open the board →</button></div></div>`;
  } else {
    const t = active || pending[0];
    wrap.innerHTML = `<div class="hero">
      <div class="overline">All that matters now is</div>
      <div class="hero-task">${esc(t.title)}</div>
      <div class="hero-meta">${active ? `<span class="eq"><i></i><i></i><i></i></span> in progress` : "tap start"}${pending.length ? ` · ${pending.length} in queue` : ""}</div>
      <div class="hero-actions">
        ${active ? `<button class="chip primary" id="heroDone">Done ✓</button>` : `<button class="chip primary" id="heroStart">Start now ▸</button>`}
        <button class="chip" id="heroSkip">Skip</button></div></div>`;
    if (active) $("heroDone").onclick = () => completeTodo(t.id);
    else $("heroStart").onclick = () => setActive(t.id);
    $("heroSkip").onclick = () => skipTodo(t.id);
  }
  $("queueList").innerHTML = pending.length
    ? pending.map((t, i) => `<li class="row"><div class="num">${i + 1}</div><div class="body"><div class="title">${esc(t.title)}</div></div>
        <button class="iconbtn" data-start="${t.id}">▸</button></li>`).join("")
    : `<li class="row"><div class="body dim">Queue is clear.</div></li>`;
  $("doneList").innerHTML = done.map((t) => `<li class="row"><div class="num">✓</div><div class="body"><div class="title done">${esc(t.title)}</div></div></li>`).join("");
  $("doneSection").hidden = !done.length;
  document.querySelectorAll("[data-start]").forEach((b) => b.addEventListener("click", () => setActive(b.dataset.start)));
}

function renderBoard() {
  const order = { active: 0, pending: 1, done: 2 };
  const sorted = [...todos].sort((a, b) => order[a.status] - order[b.status]);
  $("boardList").innerHTML = sorted.length
    ? sorted.map((t) => `<li class="row ${t.status === "active" ? "np" : ""}">
        <div class="num">${t.status === "active" ? `<span class="eq"><i></i><i></i><i></i></span>` : t.status === "done" ? "✓" : sorted.indexOf(t) + 1}</div>
        <div class="body"><div class="title ${t.status === "done" ? "done" : ""}">${esc(t.title)}</div>
        <div class="sub">${t.status === "active" ? "all that matters now" : t.status === "done" ? "done" : "queued"}</div></div>
        <button class="iconbtn" data-toggle="${t.id}">${t.status === "done" ? "↺" : t.status === "active" ? "■" : "▸"}</button></li>`).join("")
    : `<li class="row"><div class="body dim">Nothing here. Add the first thing above.</div></li>`;
  document.querySelectorAll("[data-toggle]").forEach((b) => b.addEventListener("click", () => {
    const id = b.dataset.toggle; const t = todos.find((x) => x.id === id); if (!t) return;
    if (t.status === "pending") setActive(id);
    else if (t.status === "active") completeTodo(id);
    else reopenTodo(id);
  }));
}
async function pushTodos() { await api("/api/todos", { method: "PUT", body: JSON.stringify(todos) }); renderAllViews(); }
function setActive(id) { todos = todos.map((t) => ({ ...t, status: t.id === id ? "active" : t.status === "active" ? "pending" : t.status })); pushTodos(); }
function completeTodo(id) { todos = todos.map((t) => (t.id === id ? { ...t, status: "done" } : t)); const nx = todos.find((t) => t.status === "pending"); if (nx) todos = todos.map((t) => (t.id === nx.id ? { ...t, status: "active" } : t)); pushTodos(); }
function reopenTodo(id) { todos = todos.map((t) => (t.id === id ? { ...t, status: "pending" } : t)); pushTodos(); }
function skipTodo(id) { const pend = todos.filter((t) => t.status === "pending" && t.id !== id); if (pend.length) setActive(pend[0].id); else renderAllViews(); }
$("addBtn").addEventListener("click", addTask);
$("addInput").addEventListener("keydown", (e) => { if (e.key === "Enter") addTask(); });
function addTask() {
  const v = $("addInput").value.trim(); if (!v) return;
  const id = String(Date.now());
  const none = !todos.some((t) => t.status === "active" || t.status === "pending");
  todos.push({ id, title: v.slice(0, 200), status: none ? "active" : "pending", note: "" });
  $("addInput").value = "";
  pushTodos();
  fetch("/api/chores", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "task_added", title: v.slice(0, 200) }) }).catch(() => {});
}

// ============================================================
// RADIO
// ============================================================
function renderRadio() {
  const d = drops[0];
  $("latestDrop").innerHTML = d ? `
    <div class="overline">Latest drop · ${new Date(d.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</div>
    <div class="msg">${esc(d.message)}</div>
    <button class="chip primary" style="margin-top:12px" data-drop="${d.url}">▶ Play drop</button>` : "No drops yet.";
  $("dropList").innerHTML = drops.length > 1
    ? drops.slice(1, 21).map((x) => `<li class="row"><div class="when">${new Date(x.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</div>
        <div class="body"><div class="title">${esc(x.message)}</div></div>
        <button class="iconbtn" data-drop="${x.url}">▸</button></li>`).join("")
    : `<li class="row"><div class="body dim">History builds every 4 minutes.</div></li>`;
  document.querySelectorAll("[data-drop]").forEach((b) => b.addEventListener("click", () => playDropUrl(b.dataset.drop)));
}
let dropAudio = null, dropPlayingUrl = null;
function playDropUrl(url) {
  if (dropAudio) { dropAudio.pause(); }
  if (dropPlayingUrl === url) { dropPlayingUrl = null; return; }
  dropPlayingUrl = url;
  dropAudio = new Audio(url);
  reportMusic(false);
  dropAudio.play().catch(() => {});
  dropAudio.onended = () => { dropPlayingUrl = null; };
}
const playedClips = new Set();

// ============================================================
// RENDER: library grid + shelves
// ============================================================
function renderLibrary() {
  const grid = $("musicGrid");
  const items = filteredLibrary();
  if (!library.length) {
    grid.innerHTML = `<div class="empty-lib"><div class="empty-art">♫</div>
      <div class="empty-title">Your library is empty</div>
      <div class="empty-sub">Paste YouTube links above. They become cards with covers and audio.</div></div>`;
    return;
  }
  const t = cur();
  grid.innerHTML = `<div class="lib-grid">` + items.map((m) => {
    const isCur = t && t.id === m.id;
    const state = m.url
      ? `<button class="card-play${isCur ? " visible" : ""}" data-play="${m.id}">${isCur && player.playing ? "❚❚" : "▶"}</button>`
      : m.pending
        ? `<div class="card-state shimmer">fetching</div>`
        : `<div class="card-state lock">🔒</div>`;
    return `<div class="card${isCur ? " playing" : ""}" data-card="${m.id}">
      <div class="card-art">
        ${m.cover ? `<img src="${m.cover}" alt="" loading="lazy" onerror="this.remove()">` : ""}
        <span class="provider yt">▶</span>
        ${state}
      </div>
      <div class="card-title">${esc(m.title)}</div>
      <div class="card-sub">${isCur && player.playing ? `<span class="eq"><i></i><i></i><i></i></span> ` : ""}${esc(m.artist || "YouTube")}</div>
    </div>`;
  }).join("") + `</div>`;
  document.querySelectorAll("[data-play]").forEach((b) => b.addEventListener("click", (e) => {
    e.stopPropagation();
    const id = b.dataset.play;
    const i = library.findIndex((x) => x.id === id);
    const t = cur();
    if (t && t.id === id) { toggle(); renderLibrary(); return; }
    playTrack(i, library.map(toTrack));
  }));
  document.querySelectorAll("[data-card]").forEach((c) => c.addEventListener("click", () => {
    const id = c.dataset.card;
    const t = cur();
    if (t && t.id === id) { openNP(); return; }
    const i = library.findIndex((x) => x.id === id);
    playTrack(i, library.map(toTrack));
  }));
}
function toTrack(m) { return { id: m.id, title: m.title, artist: m.artist, cover: m.cover, url: m.url, urlSub: m.urlSub || (m.hasSub ? `/api/music/${m.id}/audio_sub.mp3` : null) }; }

// ============================================================
// PLAYER BAR + NOW PLAYING SHEET
// ============================================================
function renderPlayer() {
  const t = cur();
  $("pbar").hidden = !t && player.queue.length === 0;
  if (!t) return;
  $("pbArt").src = t.cover || "";
  $("pbArt").style.display = t.cover ? "block" : "none";
  $("pbTitle").textContent = t.title;
  $("pbArtist").textContent = t.artist || "YouTube";
  $("pbPlay").textContent = player.playing ? "❚❚" : "▶";
  $("pbShuffle").classList.toggle("on", player.shuffle);
  $("npArt").src = t.cover || "";
  $("npArt").style.display = t.cover ? "block" : "none";
  $("npTitle").textContent = t.title;
  $("npArtist").textContent = t.artist || "YouTube";
  $("npPlay").textContent = player.playing ? "❚❚" : "▶";
  $("npShuffle").classList.toggle("on", player.shuffle);
  $("npRepeat").textContent = player.repeat === "one" ? "🔂" : "🔁";
  $("npRepeat").classList.toggle("on", player.repeat !== "off");
  document.querySelector(".sub-chip").classList.toggle("on", player.version === "sub");
  document.querySelector(".sub-chip").textContent = player.version === "sub" ? "◉ sub on" : "◉ sub";
  renderProgress();
}
function renderProgress() {
  const a = player.audio;
  const f = a.duration ? (a.currentTime / a.duration) * 100 : 0;
  $("pbFill").style.width = f + "%";
  $("npFill").style.width = f + "%";
  $("npElapsed").textContent = fmt(a.currentTime);
  $("npTotal").textContent = fmt(a.duration);
}
function openNP() { $("npSheet").classList.add("open"); }
function closeNP() { $("npSheet").classList.remove("open"); }
$("pbar").addEventListener("click", openNP);
$("npClose").addEventListener("click", closeNP);
// swipe down to close
(() => {
  let sy = 0;
  const sheet = $("npSheet");
  sheet.addEventListener("touchstart", (e) => { sy = e.touches[0].clientY; }, { passive: true });
  sheet.addEventListener("touchend", (e) => { if (e.changedTouches[0].clientY - sy > 80) closeNP(); }, { passive: true });
})();
// seek bars
[["pbTrack", false], ["npTrack", true]].forEach(([id, withTime]) => {
  const el = $(id);
  el.addEventListener("click", (e) => {
    const r = el.getBoundingClientRect();
    seekTo((e.clientX - r.left) / r.width);
  });
});
$("pbPlay").addEventListener("click", (e) => { e.stopPropagation(); toggle(); });
$("npPlay").addEventListener("click", toggle);
$("pbNext").addEventListener("click", (e) => { e.stopPropagation(); next(); });
$("npNext").addEventListener("click", () => next());
$("npPrev").addEventListener("click", prev);
$("pbShuffle").addEventListener("click", (e) => { e.stopPropagation(); player.shuffle = !player.shuffle; renderPlayer(); });
$("npShuffle").addEventListener("click", () => { player.shuffle = !player.shuffle; renderPlayer(); });
$("npRepeat").addEventListener("click", () => { player.repeat = player.repeat === "off" ? "all" : player.repeat === "all" ? "one" : "off"; renderPlayer(); savePlayer(); });
$("npVol").addEventListener("input", (e) => setVolume(e.target.value / 100));
document.querySelector(".sub-chip").addEventListener("click", (e) => {
  e.stopPropagation();
  setVersion(player.version === "sub" ? "clean" : "sub");
});

// keyboard
document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
  if (e.code === "Space") { e.preventDefault(); toggle(); }
  if (e.code === "ArrowRight") seekTo(Math.min(1, (player.audio.currentTime + 10) / (player.audio.duration || 1)));
  if (e.code === "ArrowLeft") seekTo(Math.max(0, (player.audio.currentTime - 10) / (player.audio.duration || 1)));
});

// ============================================================
// NAV
// ============================================================
const views = ["now", "radio", "board", "music"];
function show(v) {
  views.forEach((x) => { $("view-" + x).hidden = x !== v; });
  document.querySelectorAll("#nav button").forEach((b) => b.classList.toggle("active", b.dataset.v === v));
  window.scrollTo(0, 0);
}
document.querySelectorAll("#nav button").forEach((b) => b.addEventListener("click", () => show(b.dataset.v)));

// ============================================================
// SSE
// ============================================================
function connectSSE() {
  const es = new EventSource("/api/events");
  es.addEventListener("todos", (e) => { todos = JSON.parse(e.data); renderNow(); renderBoard(); });
  es.addEventListener("music", () => loadMusic());
  es.addEventListener("audio", (e) => {
    const clip = JSON.parse(e.data);
    if (playedClips.has(clip.url)) return;
    playedClips.add(clip.url);
    drops.unshift(clip); drops = drops.slice(0, 25);
    renderRadio();
    if (musicListening) { toast("Warden dropped wisdom — in Radio", "ok"); return; }
    playDropUrl(clip.url);
  });
}

// ============================================================
// BOOT — restore player state, load data
// ============================================================
(async function boot() {
  try {
    // restore queue
    const saved = JSON.parse(localStorage.getItem("focus_player") || "null");
    if (saved && saved.queue?.length) {
      player.queue = saved.queue; player.index = saved.index ?? 0;
      player.shuffle = !!saved.shuffle; player.repeat = saved.repeat || "off";
      player.version = saved.version || "clean";
      player.audio.src = trackSrc(cur());
      if (saved.t) player.audio.currentTime = Math.min(saved.t, player.audio.duration || saved.t);
    }
    const [t, d] = await Promise.all([
      api("/api/todos").then((r) => r.json()),
      api("/api/drops").then((r) => r.json()).catch(() => []),
      loadMusic(),
    ]);
    todos = t; drops = d;
    renderNow(); renderBoard(); renderRadio(); renderPlayer();
    connectSSE();
  } catch {}
})();
