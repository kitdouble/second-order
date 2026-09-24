// Participant-facing API. Deployed separately from the researcher app so app
// deploys never interrupt participants. Reached via Firebase Hosting at
// https://2ndorder.live/api/ingest/...
import http from "node:http";
import { validateBatch, validateStart, MAX_BODY_BYTES } from "./validate.js";
import { dbConfigured, q } from "./db.js";
import { startSession, insertTrials, completeSession, UserFacing } from "./sessions.js";

const PORT = Number(process.env.PORT ?? 8080);

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("Body too large."), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(Object.assign(new Error("Body is not valid JSON."), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

const COMPLETE = /^\/api\/ingest\/sessions\/([A-Za-z0-9_-]{1,128})\/complete$/;

export const server = http.createServer(async (req, res) => {
  const path = new URL(req.url, "http://localhost").pathname.replace(/\/+$/, "");
  try {
    if (req.method === "GET" && path === "/api/ingest/health") {
      let db = "not configured";
      if (dbConfigured()) {
        try {
          await q("SELECT 1");
          db = "ok";
        } catch {
          db = "unreachable";
        }
      }
      return send(res, 200, { ok: true, service: "ingest", db, commit: process.env.GIT_COMMIT ?? "local" });
    }
    if (req.method !== "POST") return send(res, 404, { ok: false, error: "Not found." });
    if (!dbConfigured()) return send(res, 503, { ok: false, error: "Database not configured yet. See SETUP.md, step 7." });

    const body = await readJson(req);

    if (path === "/api/ingest/sessions") {
      const v = validateStart(body);
      if (!v.ok) return send(res, 400, { ok: false, error: v.error });
      return send(res, 200, { ok: true, ...(await startSession(v.start)) });
    }
    if (path === "/api/ingest/trials") {
      const v = validateBatch(body);
      if (!v.ok) return send(res, 400, { ok: false, error: v.error });
      return send(res, 200, { ok: true, ...(await insertTrials(v.batch)) });
    }
    const m = COMPLETE.exec(path);
    if (m) {
      const status = body.status === "declined" ? "declined" : "complete";
      const minutes = typeof body.minutes === "number" && body.minutes >= 0 && body.minutes < 1440 ? body.minutes : null;
      const meta = body.meta && typeof body.meta === "object" ? sanitiseMeta(body.meta) : {};
      return send(res, 200, { ok: true, ...(await completeSession(m[1], { status, minutes, meta })) });
    }
    return send(res, 404, { ok: false, error: "Not found." });
  } catch (err) {
    if (err instanceof UserFacing) return send(res, err.status, { ok: false, code: err.code, error: err.message });
    const status = err.status ?? 500;
    if (status === 500) console.error(err);
    return send(res, status, { ok: false, error: status === 500 ? "Server error." : err.message });
  }
});

// Only simple numeric timing fields are kept from the browser.
function sanitiseMeta(meta) {
  const out = {};
  for (const k of ["refresh_hz", "dropped_frame_prop", "hidden_count", "blur_count", "screen_w", "screen_h", "fullscreen_exits"]) {
    if (typeof meta[k] === "number" && Number.isFinite(meta[k])) out[k] = meta[k];
  }
  if (typeof meta.user_agent === "string") out.user_agent = meta.user_agent.slice(0, 300);
  return out;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  server.listen(PORT, () => console.log(`ingest listening on ${PORT}`));
}
