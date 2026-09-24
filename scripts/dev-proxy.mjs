// Local stand-in for Firebase Hosting: serves hosting/public with the same
// rewrites as firebase.json and proxies the two services.
//   node scripts/dev-proxy.mjs  (PORT=5000 WEB=3000 INGEST=8080)
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "hosting", "public");
const PORT = Number(process.env.PORT ?? 5000);
const WEB = Number(process.env.WEB ?? 3000);
const INGEST = Number(process.env.INGEST ?? 8080);
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

function proxy(req, res, port) {
  const p = http.request(
    { host: "127.0.0.1", port, path: req.url, method: req.method, headers: { ...req.headers, "x-forwarded-host": req.headers.host, "x-forwarded-proto": "http" } },
    (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    },
  );
  p.on("error", () => {
    res.writeHead(502);
    res.end("upstream down");
  });
  req.pipe(p);
}

async function serveFile(res, file) {
  const body = await readFile(file);
  res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
  res.end(body);
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname.startsWith("/api/ingest/")) return proxy(req, res, INGEST);
    if (url.pathname.startsWith("/s/")) return serveFile(res, path.join(root, "s", "index.html"));
    const file = path.join(root, path.normalize(url.pathname));
    if (file.startsWith(root)) {
      try {
        if ((await stat(file)).isFile()) return serveFile(res, file);
      } catch {}
    }
    return proxy(req, res, WEB);
  })
  .listen(PORT, () => console.log(`dev proxy on http://localhost:${PORT}`));
