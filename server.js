const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const RECORDINGS_DIR = path.join(__dirname, "recordings");

if (!fs.existsSync(RECORDINGS_DIR)) fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

// Sanitize a name so it can't escape the recordings dir (no path traversal).
function safeName(value, fallback) {
  if (!value || typeof value !== "string") return fallback;
  const clean = value.replace(/[^a-zA-Z0-9_-]/g, "");
  return clean.length > 0 ? clean : fallback;
}

// Where each uploaded segment lands: recordings/<session>/seg_<n>.<ext>
// NOTE: session/segment/ext are read from URL params/query, NOT req.body,
// because multer's disk callbacks fire before multipart text fields are parsed.
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

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Upload one recorded segment.
app.post("/api/upload/:session/:seg", upload.single("video"), (req, res) => {
  const session = safeName(req.params.session, "unknown");
  const seg = String(parseInt(req.params.seg, 10) || 0);
  const ext = safeName(req.query.ext || "webm", "webm");
  res.json({
    ok: true,
    url: `/api/recordings/${session}/seg_${seg}.${ext}`,
  });
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
    // Session timestamp from the folder name: session_YYYY-MM-DDTHH-mm-ss-...
    let created = null;
    const m = dir.match(/session_(.+)$/);
    if (m) created = m[1];
    sessions.push({
      session: dir,
      segments: files.length,
      files,
      size,
      created,
    });
  }
  sessions.sort((a, b) => (a.created && b.created ? (a.created < b.created ? 1 : -1) : 0));
  res.json(sessions);
});

// Stream a recording file (supports range requests for seeking).
app.get("/api/recordings/:session/:file", (req, res) => {
  const session = safeName(req.params.session, "unknown");
  const file = safeName(path.parse(req.params.file).name, "seg") + ".webm";
  const filePath = path.join(RECORDINGS_DIR, session, file);
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
  console.log(`  Recordings save to: ${RECORDINGS_DIR}\n`);
  console.log(`  Tip: to use your PHONE camera you need an HTTPS url.`);
  console.log(`  Open a tunnel:  npx localtunnel --port ${PORT}`);
  console.log(`     (or)  cloudflared tunnel --url http://localhost:${PORT}\n`);
});
