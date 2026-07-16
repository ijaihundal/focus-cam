require("dotenv").config();
const express = require("express");
const multer = require("multer");
const cookieSession = require("cookie-session");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();
app.set("trust proxy", 1); // trust Traefik's X-Forwarded-* headers

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const RECORDINGS_DIR = path.join(__dirname, "recordings");

if (!fs.existsSync(RECORDINGS_DIR)) fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

// ---- Auth config from environment ----
const AUTH_USERNAME = process.env.AUTH_USERNAME || "admin";
const PASSWORD_HASH = process.env.AUTH_PASSWORD_HASH; // preferred (bcrypt)
const PASSWORD_PLAIN = process.env.AUTH_PASSWORD; // fallback
const SESSION_SECRET =
  process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");

if (!PASSWORD_HASH && !PASSWORD_PLAIN) {
  console.error(
    "\n  ERROR: No password configured.\n" +
      "  Set AUTH_PASSWORD (or AUTH_PASSWORD_HASH) in your environment / .env file.\n"
  );
  process.exit(1);
}
if (!process.env.SESSION_SECRET) {
  console.warn(
    "  WARNING: SESSION_SECRET not set. Using a random one — you'll be logged out on every restart.\n" +
      "  Set SESSION_SECRET in your environment for persistent sessions.\n"
  );
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
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    secure: isProd, // HTTPS-only in production
    httpOnly: true,
    sameSite: "lax",
  })
);

app.use(express.json());

// ---- Public auth routes (not gated) ----
app.get("/login", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.post("/api/login", async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ ok: false, error: "Missing credentials" });
  }
  const userOk = safeEqual(username, AUTH_USERNAME);
  const passOk = await checkPassword(password);
  if (!userOk || !passOk) {
    await new Promise((r) => setTimeout(r, 400)); // slow brute force
    return res.status(401).json({ ok: false, error: "Invalid username or password" });
  }
  req.session.user = AUTH_USERNAME;
  res.json({ ok: true });
});

app.post("/api/logout", (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

// ---- Auth gate for everything below ----
function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  if (req.path.startsWith("/api/") || req.method !== "GET") {
    return res.status(401).json({ ok: false, error: "Not authenticated" });
  }
  return res.redirect("/login");
}
app.use(requireAuth);

// ---- Protected static assets & API ----
app.use(express.static(path.join(__dirname, "public")));

// Where each uploaded segment lands: recordings/<session>/seg_<n>.<ext>
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

// Upload one recorded segment.
app.post("/api/upload/:session/:seg", upload.single("video"), (req, res) => {
  const session = safeName(req.params.session, "unknown");
  const seg = String(parseInt(req.params.seg, 10) || 0);
  const ext = safeName(req.query.ext || "webm", "webm");
  res.json({ ok: true, url: `/api/recordings/${session}/seg_${seg}.${ext}` });
});

// List every session with its segment count and total size.
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

// Stream a recording file (supports range requests for seeking).
app.get("/api/recordings/:session/:file", (req, res) => {
  const session = safeName(req.params.session, "unknown");
  const parsed = path.parse(req.params.file);
  const base = safeName(parsed.name, "seg");
  const ext = safeName(parsed.ext.replace(".", ""), "webm");
  const filePath = path.join(RECORDINGS_DIR, session, `${base}.${ext}`);
  if (!fs.existsSync(filePath)) return res.status(404).send("Not found");
  res.sendFile(filePath);
});

// Delete a whole session folder.
app.delete("/api/recordings/:session", (req, res) => {
  const session = safeName(req.params.session, "unknown");
  const dir = path.join(RECORDINGS_DIR, session);
  fs.rmSync(dir, { recursive: true, force: true });
  res.json({ ok: true });
});

// Total disk usage of all recordings.
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
  console.log(`\n  Focus Cam is running:`);
  console.log(`    http://localhost:${PORT}`);
  console.log(`  Recordings save to: ${RECORDINGS_DIR}`);
  console.log(`  Login required as: ${AUTH_USERNAME}\n`);
});
