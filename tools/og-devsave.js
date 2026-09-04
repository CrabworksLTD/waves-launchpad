#!/usr/bin/env node
/* Tiny static server for regenerating the website OG cards from og-lab.html.
 * Serves app/public and accepts POST /api/dev-save {name, dataUrl} to write a
 * canvas PNG to art/<name>. Local, ephemeral — not part of the deploy.
 *
 *   node tools/og-devsave.js [port]
 */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "app", "public");
const PORT = Number(process.argv[2] || 8792);
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".json": "application/json",
  ".ttf": "font/ttf", ".woff": "font/woff", ".woff2": "font/woff2" };
// only the two website cards may be written, nowhere else
const ALLOW = new Set(["og.png", "og-rh.png"]);

http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/dev-save") {
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 20e6) req.destroy(); });
    req.on("end", () => {
      try {
        const { name, dataUrl } = JSON.parse(body);
        if (!ALLOW.has(name)) { res.writeHead(400).end('{"error":"name not allowed"}'); return; }
        const b64 = String(dataUrl).replace(/^data:image\/png;base64,/, "");
        fs.writeFileSync(path.join(ROOT, "art", name), Buffer.from(b64, "base64"));
        console.log("  wrote art/" + name + " (" + Math.round(b64.length * 0.75 / 1024) + " KB)");
        res.writeHead(200, { "Content-Type": "application/json" }).end('{"ok":true}');
      } catch (e) {
        res.writeHead(500).end(JSON.stringify({ error: String(e.message || e) }));
      }
    });
    return;
  }
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/") p = "/index.html";
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => console.log("  og-devsave on http://localhost:" + PORT));
