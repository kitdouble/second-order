// Trial data ingest service. Deployed separately from the researcher app so
// app deploys never interrupt participants. Reached via Firebase Hosting at
// https://2ndorder.live/api/ingest/...
import http from "node:http";
import { validateBatch, MAX_BODY_BYTES } from "./validate.js";
import { dbConfigured, insertBatch, ping } from "./db.js";

const PORT = Number(process.env.PORT ?? 8080);

function send(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
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
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(Object.assign(new Error("Body is not valid JSON."), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

export const server = http.createServer(async (req, res) => {
  const path = new URL(req.url, "http://localhost").pathname.replace(/\/+$/, "");

  try {
    if (req.method === "GET" && path === "/api/ingest/health") {
      let db = "not configured";
      if (dbConfigured()) {
        try {
          await ping();
          db = "ok";
        } catch {
          db = "unreachable";
        }
      }
      return send(res, 200, {
        ok: true,
        service: "ingest",
        db,
        commit: process.env.GIT_COMMIT ?? "local",
      });
    }

    if (req.method === "POST" && path === "/api/ingest/trials") {
      const body = await readJson(req);
      const check = validateBatch(body);
      if (!check.ok) return send(res, 400, { ok: false, error: check.error });
      if (!dbConfigured()) {
        return send(res, 503, {
          ok: false,
          error: "Database not configured yet. See SETUP.md, step 7.",
        });
      }
      const result = await insertBatch(check.batch);
      return send(res, 200, { ok: true, ...result });
    }

    return send(res, 404, { ok: false, error: "Not found." });
  } catch (err) {
    const status = err.status ?? 500;
    if (status === 500) console.error(err);
    return send(res, status, {
      ok: false,
      error: status === 500 ? "Server error." : err.message,
    });
  }
});

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  server.listen(PORT, () => console.log(`ingest listening on ${PORT}`));
}
