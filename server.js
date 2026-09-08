require("dotenv").config();
const express = require("express");
const multer = require("multer");
const cookieSession = require("cookie-session");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const https = require("https");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");

const app = express();
app.set("trust proxy", 1); // trust Traefik's X-Forwarded-* headers

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const RECORDINGS_DIR = path.join(__dirname, "recordings");
const DATA_DIR = path.join(__dirname, "data");

const TODOS_FILE = path.join(DATA_DIR, "todos.json");
const VERDICTS_FILE = path.join(DATA_DIR, "verdicts.json");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const TEACHINGS_FILE = path.join(DATA_DIR, "teachings.md");
const FRAME_FILE = path.join(DATA_DIR, "frame_latest.jpg");

for (const d of [RECORDINGS_DIR, DATA_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

// ---- Config from environment ----
const AUTH_USERNAME = process.env.AUTH_USERNAME || "admin";
const PASSWORD_HASH = process.env.AUTH_PASSWORD_HASH; // preferred (bcrypt)
const PASSWORD_PLAIN = process.env.AUTH_PASSWORD; // fallback
const SESSION_SECRET =
  process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const AGENT_TOKEN = process.env.AGENT_TOKEN || ""; // bearer token for the agent (KB side)
const JUDGE_MODE = process.env.JUDGE_MODE || "agent"; // agent | vlm | off
const JUDGE_INTERVAL_SEC = parseInt(process.env.JUDGE_INTERVAL_SEC || "60", 10);

if (!PASSWORD_HASH && !PASSWORD_PLAIN) {
  console.error(
    "\n  ERROR: No password configured.\n" +
      "  Set AUTH_PASSWORD (or AUTH_PASSWORD_HASH) in your environment / .env file.\n"
  );
  process.exit(1);
}
if (!process.env.SESSION_SECRET) {
  console.warn(
    "  WARNING: SESSION_SECRET not set. Using a random one — you'll be logged out on every restart.\n"
  );
}
if (!AGENT_TOKEN) {
  console.warn(
    "  WARNING: AGENT_TOKEN not set. The agent (live task updates, cron judging) cannot authenticate.\n"
  );
}

// Cross-origin isolation headers: required later for WebGPU/VLM (SharedArrayBuffer).
app.use((req, res, next) => {
  res.set("Cross-Origin-Opener-Policy", "same-origin");
  res.set("Cross-Origin-Embedder-Policy", "require-corp");
  next();
});

// ---- Tiny JSON file store (atomic writes) ----
function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
function writeJson(file, data) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

// ---- SSE hub ----
const sseClients = new Set();
const sseKeepAlive = setInterval(() => {
  for (const res of sseClients) {
    try {
      res.write(": ping\n\n");
    } catch {
      sseClients.delete(res);
    }
  }
}, 25000);

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
    }
  }
}

// Constant-time string comparison to resist timing attacks.
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) {
    crypto.timingSafeEqual(ab, ab);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

// ---- Failed-login rate limiting (in-memory, per IP) ----
const LOGIN_MAX_FAILS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_LOCK_MS = 5 * 60 * 1000;
const loginFails = new Map();

function clientIp(req) {
  return String(req.headers["x-forwarded-for"] || req.ip || "")
    .split(",")[0]
    .trim();
}
function loginRateState(ip) {
  const now = Date.now();
  const r = loginFails.get(ip);
  if (r && r.lockUntil && r.lockUntil > now) {
    return { locked: true, retryAfter: Math.ceil((r.lockUntil - now) / 1000) };
  }
  return { locked: false };
}
function loginRateFail(ip) {
  const now = Date.now();
  let r = loginFails.get(ip);
  if (!r || now - r.firstAt > LOGIN_WINDOW_MS) r = { count: 0, firstAt: now, lockUntil: 0 };
  r.count++;
  if (r.count >= LOGIN_MAX_FAILS) r.lockUntil = now + LOGIN_LOCK_MS;
  loginFails.set(ip, r);
}
function loginRateClear(ip) {
  loginFails.delete(ip);
}

// Session durations
const REMEMBER_MAXAGE = 30 * 24 * 60 * 60 * 1000;
const TEMP_MAXAGE = 24 * 60 * 60 * 1000;

async function checkPassword(submitted) {
  if (PASSWORD_HASH) {
    try {
      return await bcrypt.compare(submitted, PASSWORD_HASH);
    } catch {
      return false;
    }
  }
  return safeEqual(submitted, PASSWORD_PLAIN);
}

// Sanitize a name so it can't escape the recordings dir (no path traversal).
function safeName(value, fallback) {
  if (!value || typeof value !== "string") return fallback;
  const clean = value.replace(/[^a-zA-Z0-9_-]/g, "");
  return clean.length > 0 ? clean : fallback;
}

// ---- Sessions (signed cookie) ----
const isProd = process.env.NODE_ENV === "production";
app.use(
  cookieSession({
    name: "focuscam_session",
    keys: [SESSION_SECRET],
    maxAge: 7 * 24 * 60 * 60 * 1000,
    secure: isProd,
    httpOnly: true,
    sameSite: "lax",
  })
);

app.use(express.json({ limit: "1mb" }));

// ---- Public auth routes (not gated) ----
app.get("/login", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.post("/api/login", async (req, res) => {
  const ip = clientIp(req);
  const state = loginRateState(ip);
  if (state.locked) {
    res.set("Retry-After", String(state.retryAfter));
    return res
      .status(429)
      .json({ ok: false, error: `Too many attempts. Try again in ${state.retryAfter}s.` });
  }
  const { username, password, remember } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ ok: false, error: "Missing credentials" });
  }
  const userOk = safeEqual(username, AUTH_USERNAME);
  const passOk = await checkPassword(password);
  if (!userOk || !passOk) {
    loginRateFail(ip);
    await new Promise((r) => setTimeout(r, 400));
    return res.status(401).json({ ok: false, error: "Invalid username or password" });
  }
  loginRateClear(ip);
  req.session.user = AUTH_USERNAME;
  req.sessionOptions.maxAge = remember ? REMEMBER_MAXAGE : TEMP_MAXAGE;
  res.json({ ok: true });
});

app.post("/api/logout", (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

// ---- Auth gate: session cookie OR agent bearer token ----
function requireAuth(req, res, next) {
  // Agent path: Authorization: Bearer <AGENT_TOKEN>
  const header = req.headers.authorization || "";
  if (AGENT_TOKEN && header.startsWith("Bearer ") && safeEqual(header.slice(7), AGENT_TOKEN)) {
    req.isAgent = true;
    return next();
  }
  // Vision-tool path: the frame endpoint also accepts ?token= (URL-only clients).
  if (
    AGENT_TOKEN &&
    (req.path === "/api/frame/latest.jpg" || req.path.startsWith("/api/audio/")) &&
    safeEqual(req.query.token || "", AGENT_TOKEN)
  ) {
    req.isAgent = true;
    return next();
  }
  if (req.session && req.session.user) return next();
  if (req.path.startsWith("/api/") || req.method !== "GET") {
    return res.status(401).json({ ok: false, error: "Not authenticated" });
  }
  return res.redirect("/login");
}
app.use(requireAuth);

// ---- Protected static assets ----
app.use(express.static(path.join(__dirname, "public")));

// ===================== LIVE TASK SYSTEM =====================

// Client config for the phone UI.
app.get("/api/config", (req, res) => {
  res.json({ judgeMode: JUDGE_MODE, judgeIntervalSec: JUDGE_INTERVAL_SEC });
});

// ---- Todos (the live plan; agent writes, phone reads) ----
function sanitizeTodos(input) {
  if (!Array.isArray(input)) return null;
  return input.slice(0, 100).map((t, i) => ({
    id: String(t && t.id != null ? t.id : i),
    title: String(t && t.title != null ? t.title : "").slice(0, 200),
    status: ["pending", "active", "done"].includes(t && t.status) ? t.status : "pending",
    note: String(t && t.note != null ? t.note : "").slice(0, 300),
  }));
}

app.get("/api/todos", (req, res) => {
  res.json(readJson(TODOS_FILE, []));
});

app.put("/api/todos", (req, res) => {
  const todos = sanitizeTodos(req.body);
  if (!todos) return res.status(400).json({ ok: false, error: "Body must be an array of todos" });
  writeJson(TODOS_FILE, todos);
  broadcast("todos", todos);
  res.json({ ok: true, count: todos.length });
});

// ---- Teachings (the warden's doctrine; agent writes) ----
const DEFAULT_TEACHINGS =
  "# The Teachings\n\nPlaceholder doctrine. Everything in this file is injected into the warden's " +
  "judgment prompt — replace it with the real teachings and the warden speaks in their voice.\n";

app.get("/api/teachings", (req, res) => {
  let text = DEFAULT_TEACHINGS;
  try {
    text = fs.readFileSync(TEACHINGS_FILE, "utf8");
  } catch {}
  res.type("text/markdown").send(text);
});

app.put("/api/teachings", (req, res) => {
  const text = String((req.body || {}).text || "").slice(0, 20000);
  fs.writeFileSync(TEACHINGS_FILE, text);
  broadcast("teachings", { text });
  res.json({ ok: true });
});

// ---- Frames (one still per judge interval while recording) ----
const frameUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
});

app.post("/api/frame", frameUpload.single("frame"), (req, res) => {
  if (!req.file || !req.file.buffer || req.file.buffer.length === 0) {
    return res.status(400).json({ ok: false, error: "Missing frame" });
  }
  fs.writeFileSync(FRAME_FILE, req.file.buffer);
  const state = readJson(STATE_FILE, {});
  state.lastFrameAt = Date.now();
  writeJson(STATE_FILE, state);
  broadcast("frame", { at: state.lastFrameAt });
  res.json({ ok: true, bytes: req.file.buffer.length });
});

app.get("/api/frame/latest.jpg", (req, res) => {
  if (!fs.existsSync(FRAME_FILE)) return res.status(404).json({ ok: false, error: "No frame yet" });
  res.set("Cache-Control", "no-store");
  res.type("image/jpeg").send(fs.readFileSync(FRAME_FILE));
});

// ---- Verdicts (judgments land here from the phone VLM or the agent) ----
function sanitizeVerdict(body) {
  const b = body || {};
  const allowed = ["on_task", "off_task", "unclear", "message"];
  return {
    source: b.source === "vlm" ? "vlm" : "agent",
    verdict: allowed.includes(b.verdict) ? b.verdict : "unclear",
    task: String(b.task || "").slice(0, 200),
    note: String(b.note || "").slice(0, 400),
    message: String(b.message || "").slice(0, 600),
    at: Date.now(),
  };
}

// ---- Radio audio (warden voice clips; agent writes, phone plays) ----
const RADIO_DIR = path.join(DATA_DIR, "radio");
if (!fs.existsSync(RADIO_DIR)) fs.mkdirSync(RADIO_DIR, { recursive: true });

app.post("/api/audio", (req, res) => {
  const b = req.body || {};
  if (!b.audio) return res.status(400).json({ ok: false, error: "Missing audio" });
  const mime = ["audio/ogg", "audio/mpeg", "audio/mp4", "audio/wav"].includes(b.mime) ? b.mime : "audio/ogg";
  const name = `clip_${Date.now()}.${mime === "audio/mpeg" ? "mp3" : mime === "audio/mp4" ? "m4a" : mime === "audio/wav" ? "wav" : "ogg"}`;
  fs.writeFileSync(path.join(RADIO_DIR, name), Buffer.from(b.audio, "base64"));
  // keep the last 40 clips
  const files = fs.readdirSync(RADIO_DIR).sort();
  while (files.length > 40) fs.unlinkSync(path.join(RADIO_DIR, files.shift()));
  const clip = { url: `/api/audio/${name}`, mime, task: String(b.task || "").slice(0, 200), message: String(b.message || "").slice(0, 600), at: Date.now() };
  writeJson(path.join(DATA_DIR, "last_audio_meta.json"), clip);
  const dropsLog = readJson(path.join(DATA_DIR, "drops.json"), []);
  dropsLog.push(clip);
  while (dropsLog.length > 100) dropsLog.shift();
  writeJson(path.join(DATA_DIR, "drops.json"), dropsLog);
  broadcast("audio", clip);
  res.json({ ok: true, clip });
});

// ---- Music (YouTube links -> indexed tracks; yt-dlp fetches metadata+audio) ----
const MUSIC_DIR = path.join(DATA_DIR, "music");
const MUSIC_META = path.join(MUSIC_DIR, "library.json");
for (const d of [MUSIC_DIR]) if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
const readMusic = () => readJson(MUSIC_META, []);
const writeMusic = (lib) => writeJson(MUSIC_META, lib);

app.get("/api/music", (req, res) => {
  const lib = readMusic().map((m) => ({
    id: m.id, title: m.title, artist: m.artist, cover: m.cover,
    url: m.file ? `/api/music/${m.id}/audio.mp3` : null, pending: !!m.pending && !m.file,
    hasSub: !!(m.file && require("fs").existsSync(path.join(MUSIC_DIR, m.id, "audio_sub.mp3"))),
    error: m.error || null, locked: !!m.locked,
  }));
  res.json(lib);
});

app.post("/api/music", async (req, res) => {
  const raw = String((req.body || {}).links || "");
  const links = raw.split(/\s+/).filter((l) => /^https?:\/\//.test(l)).slice(0, 50);
  if (!links.length) return res.status(400).json({ ok: false, error: "No links found" });
  const lib = readMusic();
  const added = [];
  for (const link of links) {
    if (lib.some((m) => m.link === link)) continue;
    const id = `yt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    lib.push({ id, link, title: link.slice(0, 80), artist: "YouTube", cover: null, file: null, pending: true });
    added.push(id);
    // index async: metadata + cover + audio
    indexYouTube(id, link);
  }
  writeMusic(lib);
  res.json({ ok: true, added: added.length });
});

function indexYouTube(id, link) {
  const dir = path.join(MUSIC_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  const done = (fields) => { const lib = readMusic(); const m = lib.find((x) => x.id === id); if (m) Object.assign(m, fields); writeMusic(lib); };
  // 1) instant metadata via oEmbed (never bot-walled): title + artist + cover, regardless of audio
  fetchOEmbed(link, (meta) => {
    if (meta) {
      done({ title: meta.title, artist: meta.artist, cover: meta.cover ? `/api/music/${id}/cover.jpg` : null });
      if (meta.cover) {
        downloadFile(meta.cover, path.join(dir, "cover.jpg"), () => broadcast("music", {}));
      }
    } else {
      done({ pending: false, error: "could not read link" });
      return;
    }
    // 2) audio via yt-dlp (needs cookies on datacenter IPs)
    exec(`yt-dlp --no-playlist --cookies "${MUSIC_DIR}/cookies.txt" --remote-components ejs:github -x --audio-format mp3 --audio-quality 4 -o "${dir}/audio.%(ext)s" --print-json "${link}"`,
      { timeout: 10 * 60 * 1000, maxBuffer: 50 * 1024 * 1024 }, (err, stdout) => {
        if (err) { done({ pending: false, error: "locked", locked: true }); broadcast("music", {}); return; }
        try {
          const info = JSON.parse(stdout.split("\n").filter(Boolean).pop());
          done({ title: String(info.title || id).slice(0, 120), artist: String(info.uploader || info.channel || "YouTube").slice(0, 80), duration: info.duration || null, pending: false, file: true, error: null, locked: false });
          broadcast("music", {});
        } catch { done({ pending: false, error: "parse failed" }); }
      });
  });
}

function downloadFile(url, dest, cb) {
  const get = (u, redirects) => https.get(u, { timeout: 20000 }, (r) => {
    if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && redirects < 4) {
      get(r.headers.location, redirects + 1); return;
    }
    if (r.statusCode !== 200) { cb(false); return; }
    const ws = fs.createWriteStream(dest);
    r.pipe(ws);
    ws.on("finish", () => cb(true));
    ws.on("error", () => cb(false));
  }).on("error", () => cb(false));
  get(url, 0);
}

function fetchOEmbed(link, cb) {
  const url = `https://www.youtube.com/oembed?url=${encodeURIComponent(link)}&format=json`;
  https.get(url, { timeout: 10000 }, (r) => {
    if (r.statusCode !== 200) { cb(null); return; }
    let body = "";
    r.on("data", (c) => (body += c));
    r.on("end", () => {
      try {
        const o = JSON.parse(body);
        // video id for hi-res cover
        const m = link.match(/(?:v=|youtu\.be\/|shorts\/)([A-Za-z0-9_-]{11})/);
        // maxres doesn't exist for older videos; oEmbed thumbnail_url always works
        const cover = o.thumbnail_url && o.thumbnail_url.startsWith("http") ? o.thumbnail_url : (m ? `https://i.ytimg.com/vi/${m[1]}/hqdefault.jpg` : null);
        cb({ title: String(o.title || "").slice(0, 120), artist: String(o.author_name || "YouTube").slice(0, 80), cover });
      } catch { cb(null); }
    });
  }).on("error", () => cb(null));
}

app.get("/api/music/:id/:file", (req, res) => {
  const { id, file } = req.params;
  if (!/^yt_[0-9]+_[a-z0-9]+$/.test(id) || !["audio.mp3", "audio_sub.mp3", "cover.jpg"].includes(file)) return res.status(404).send("Not found");
  let p = path.join(MUSIC_DIR, id, file);
  // sub version falls back to clean mix if the nightly bed hasn't rendered yet
  if (file === "audio_sub.mp3" && !fs.existsSync(p)) p = path.join(MUSIC_DIR, id, "audio.mp3");
  if (!fs.existsSync(p)) return res.status(404).send("Not found");
  res.type("audio/mpeg");
  res.set("Cache-Control", "public, max-age=300");
  res.sendFile(p);
});

// ---- dual versions: affirmation bed (0.24) mixed under full track, server-side ----
const { exec: execFfmpeg } = require("child_process");
function subVersionReady(id) { return fs.existsSync(path.join(MUSIC_DIR, id, "audio_sub.mp3")); }

app.post("/api/music/:id/sublimate", (req, res) => {
  const { id } = req.params;
  if (!/^yt_[0-9]+_[a-z0-9]+$/.test(id)) return res.status(400).json({ ok: false });
  const src = path.join(MUSIC_DIR, id, "audio.mp3");
  if (!fs.existsSync(src)) return res.status(404).json({ ok: false, error: "no audio" });
  if (subVersionReady(id)) return res.json({ ok: true, cached: true });
  const bed = path.join(MUSIC_DIR, "aff_bed.mp3");
  if (!fs.existsSync(bed)) return res.status(503).json({ ok: false, error: "no bed" });
  const out = path.join(MUSIC_DIR, id, "audio_sub.mp3");
  execFfmpeg(`ffmpeg -y -loglevel error -i "${src}" -stream_loop -1 -i "${bed}" -filter_complex "[1:a]volume=0.24[voice];[0:a][voice]amix=inputs=2:duration=first:dropout_transition=0:weights=1 1" -t 3600 "${out}"`, { timeout: 5 * 60 * 1000 }, (err) => {
    res.json({ ok: !err });
    if (!err) broadcast("music", {});
  });
});

app.get("/api/drops", (req, res) => {
  const meta = readJson(path.join(DATA_DIR, "drops.json"), []);
  res.json(meta.slice(-25).reverse());
});

// ---- Music-listening state (client tells backend to hold warden fire) ----
const MUSIC_STATE = path.join(DATA_DIR, "music_state.json");
app.post("/api/music-state", (req, res) => {
  const listening = !!(req.body || {}).listening;
  writeJson(MUSIC_STATE, { listening, at: Date.now() });
  res.json({ ok: true });
});
app.get("/api/music-state", (req, res) => res.json(readJson(MUSIC_STATE, { listening: false, at: 0 })));

// ---- Chores inbox (UI events the warden should acknowledge / act on) ----
const CHORES = path.join(DATA_DIR, "chores.json");
app.post("/api/chores", (req, res) => {
  const b = req.body || {};
  const log = readJson(CHORES, []);
  log.push({ type: String(b.type || "").slice(0, 40), title: String(b.title || "").slice(0, 200), at: Date.now(), done: false });
  while (log.length > 100) log.shift();
  writeJson(CHORES, log);
  res.json({ ok: true });
});
app.get("/api/chores", (req, res) => {
  const log = readJson(CHORES, []);
  res.json(log.filter((c) => !c.done));
});
app.post("/api/chores/ack", (req, res) => {
  const log = readJson(CHORES, []);
  for (const c of log) if (!c.done) c.done = true;
  writeJson(CHORES, log);
  res.json({ ok: true });
});

app.get("/api/audio/latest", (req, res) => {
  const files = fs.readdirSync(RADIO_DIR).sort();
  if (!files.length) return res.status(404).json({ ok: false, error: "No clips yet" });
  const name = files[files.length - 1];
  const meta = readJson(path.join(DATA_DIR, "last_audio_meta.json"), {});
  res.json({ url: `/api/audio/${name}`, ...meta });
});

app.get("/api/audio/:file", (req, res) => {
  const m = String(req.params.file || "").match(/^clip_\d+\.(ogg|mp3|m4a|wav)$/);
  if (!m) return res.status(404).send("Not found");
  const p = path.join(RADIO_DIR, m[0]);
  if (!fs.existsSync(p)) return res.status(404).send("Not found");
  res.set("Cache-Control", "no-store");
  res.type(m[1] === "mp3" ? "audio/mpeg" : m[1] === "m4a" ? "audio/mp4" : m[1] === "wav" ? "audio/wav" : "audio/ogg");
  res.sendFile(p);
});

app.post("/api/verdict", (req, res) => {
  const v = sanitizeVerdict(req.body);
  const all = readJson(VERDICTS_FILE, []);
  all.push(v);
  while (all.length > 200) all.shift();
  writeJson(VERDICTS_FILE, all);
  broadcast("verdict", v);
  res.json({ ok: true });
});

app.get("/api/verdicts", (req, res) => {
  res.json(readJson(VERDICTS_FILE, []).slice(-50).reverse());
});

// ---- Presence / heartbeat ----
app.post("/api/heartbeat", (req, res) => {
  const b = req.body || {};
  const state = readJson(STATE_FILE, {});
  state.recording = !!b.recording;
  state.session = b.session ? String(b.session).slice(0, 80) : null;
  state.lastHeartbeat = Date.now();
  writeJson(STATE_FILE, state);
  broadcast("presence", { recording: state.recording, session: state.session, at: state.lastHeartbeat });
  res.json({ ok: true });
});

app.get("/api/state", (req, res) => {
  res.json({
    ...readJson(STATE_FILE, {}),
    clients: sseClients.size,
    judgeMode: JUDGE_MODE,
    judgeIntervalSec: JUDGE_INTERVAL_SEC,
    now: Date.now(),
  });
});

// ---- SSE stream (todos, verdicts, presence — live to every open screen) ----
app.get("/api/events", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
  });
  res.flushHeaders();
  res.write("retry: 3000\n\n");
  sseClients.add(res);
  req.on("close", () => sseClients.delete(res));
});

// ===================== RECORDINGS (unchanged core) =====================

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const session = safeName(req.params.session, "unknown");
    const dir = path.join(RECORDINGS_DIR, session);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const seg = String(parseInt(req.params.seg, 10) || 0);
    const ext = safeName(req.query.ext || "webm", "webm");
    cb(null, `seg_${seg}.${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 1024 * 1024 * 1024 } });

app.post("/api/upload/:session/:seg", upload.single("video"), (req, res) => {
  const session = safeName(req.params.session, "unknown");
  const seg = String(parseInt(req.params.seg, 10) || 0);
  const ext = safeName(req.query.ext || "webm", "webm");
  res.json({ ok: true, url: `/api/recordings/${session}/seg_${seg}.${ext}` });
});

app.get("/api/recordings", (req, res) => {
  const sessions = [];
  for (const dir of fs.readdirSync(RECORDINGS_DIR)) {
    const full = path.join(RECORDINGS_DIR, dir);
    if (!fs.statSync(full).isDirectory()) continue;
    const files = fs
      .readdirSync(full)
      .filter((f) => /^seg_\d+\.[a-z0-9]+$/i.test(f))
      .sort(new Intl.Collator(undefined, { numeric: true }).compare);
    let size = 0;
    for (const f of files) size += fs.statSync(path.join(full, f)).size;
    let created = null;
    const m = dir.match(/session_(.+)$/);
    if (m) created = m[1];
    sessions.push({ session: dir, segments: files.length, files, size, created });
  }
  sessions.sort((a, b) =>
    a.created && b.created ? (a.created < b.created ? 1 : -1) : 0
  );
  res.json(sessions);
});

app.get("/api/recordings/:session/:file", (req, res) => {
  const session = safeName(req.params.session, "unknown");
  const parsed = path.parse(req.params.file);
  const base = safeName(parsed.name, "seg");
  const ext = safeName(parsed.ext.replace(".", ""), "webm");
  const filePath = path.join(RECORDINGS_DIR, session, `${base}.${ext}`);
  if (!fs.existsSync(filePath)) return res.status(404).send("Not found");
  res.sendFile(filePath);
});

app.delete("/api/recordings/:session", (req, res) => {
  const session = safeName(req.params.session, "unknown");
  const dir = path.join(RECORDINGS_DIR, session);
  fs.rmSync(dir, { recursive: true, force: true });
  res.json({ ok: true });
});

app.get("/api/stats", (req, res) => {
  let total = 0;
  let count = 0;
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        total += fs.statSync(full).size;
        count++;
      }
    }
  }
  walk(RECORDINGS_DIR);
  res.json({ bytes: total, files: count });
});

app.listen(PORT, HOST, () => {
  console.log(`\n  Focus Cam (warden edition) is running:`);
  console.log(`    http://localhost:${PORT}`);
  console.log(`    judge mode: ${JUDGE_MODE} · interval: ${JUDGE_INTERVAL_SEC}s`);
  console.log(`    agent token: ${AGENT_TOKEN ? "configured" : "NOT SET"}\n`);
});
