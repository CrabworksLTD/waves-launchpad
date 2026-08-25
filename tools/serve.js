"use strict";
// Local server for app/public that behaves the way Vercel does.
//
//   node tools/serve.js [port]        default 8787
//
// python -m http.server was serving this before and 404'd on /app, because the
// site links to clean URLs and Vercel rewrites them. Testing against a server
// that routes differently from production is how you end up debugging the
// wrong thing.
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "app", "public");
const PORT = parseInt(process.argv[2], 10) || 8787;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml", ".ico": "image/x-icon", ".pdf": "application/pdf"
};

// Serverless functions do not run here — this is a file server. Rather than
// have /api 404 locally and only discover it mid-launch, forward those calls to
// production, which has the function and the PINATA_JWT it needs.
function proxyApi(req, res) {
  const body = [];
  req.on("data", function (c) { body.push(c); });
  req.on("end", function () {
    const payload = Buffer.concat(body);
    const up = https.request({
      hostname: "moonpad.online", path: req.url, method: req.method,
      headers: {
        "Content-Type": req.headers["content-type"] || "application/json",
        "Content-Length": payload.length
      }
    }, function (r) {
      res.writeHead(r.statusCode, { "Content-Type": r.headers["content-type"] || "application/json" });
      r.pipe(res);
    });
    up.on("error", function (e) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "proxy to production failed: " + e.message }));
    });
    up.write(payload);
    up.end();
  });
}

http.createServer(function (req, res) {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p.startsWith("/api/")) return proxyApi(req, res);
  if (p.endsWith("/")) p += "index.html";

  // /mint/0xabc… -> mint.html, matching the rewrite in vercel.json. The address
  // is read back off the path by mint.js.
  if (/^\/mint\//.test(p)) p = "/mint.html";

  // cleanUrls: /app -> app.html, exactly what vercel.json declares
  let file = path.join(ROOT, p);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    if (fs.existsSync(file + ".html")) file = file + ".html";
  }

  // never serve outside the public folder, whatever the path claims
  if (!path.resolve(file).startsWith(path.resolve(ROOT))) {
    res.writeHead(403); return res.end("no");
  }

  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    return res.end("404 " + p + "\n\nTry /  or  /app");
  }

  const body = fs.readFileSync(file);
  res.writeHead(200, {
    "Content-Type": TYPES[path.extname(file)] || "application/octet-stream",
    "Content-Length": body.length,
    "Cache-Control": "no-store"          // so a reload always gets the new build
  });
  res.end(body);
}).listen(PORT, "127.0.0.1", function () {
  console.log("  serving " + path.relative(process.env.HOME, ROOT) + " with clean URLs");
  console.log("  http://127.0.0.1:" + PORT + "/        the landing page");
  console.log("  http://127.0.0.1:" + PORT + "/app     the builder");
  console.log("  /api/* is proxied to moonpad.online — functions do not run locally");
});
