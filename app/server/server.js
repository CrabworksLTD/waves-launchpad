#!/usr/bin/env node
"use strict";
// Builder server: serves the editor, stores projects, and generates collections.
//
// Projects live in projects/<id>/ — one folder per project rather than per user,
// which is the shape the multi-user port will keep. Auth and ownership are the
// only things that need adding on top.
//
//   npm run dev   ->  http://localhost:4400

const http = require("http");
const fs = require("fs");
const path = require("path");
const png = require("../../lib/png");
const gen = require("./generate");
const zip = require("../../lib/zip");

const ROOT = path.join(__dirname, "..", "..");
const PUBLIC = path.join(__dirname, "..", "public");
const PROJECTS = path.join(ROOT, "projects");
const PORT = process.env.PORT || 4400;

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".png": "image/png", ".json": "application/json"
};

function body(req) {
  return new Promise(function (res, rej) {
    let d = "";
    req.on("data", function (c) {
      d += c;
      if (d.length > 120 * 1024 * 1024) { rej(new Error("payload too large")); req.destroy(); }
    });
    req.on("end", function () {
      try { res(d ? JSON.parse(d) : {}); } catch (e) { rej(e); }
    });
  });
}

function slug(s) {
  return String(s || "").replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "untitled";
}

function dataUrlToPng(url) {
  const m = /^data:image\/png;base64,(.+)$/.exec(url || "");
  if (!m) return null;
  return Buffer.from(m[1], "base64");
}

// ---------- project storage ----------
function saveProject(p) {
  const id = slug(p.name) + "-" + String(p.id || "").slice(-5);
  const dir = path.join(PROJECTS, id);
  const traitDir = path.join(dir, "traits");
  fs.mkdirSync(traitDir, { recursive: true });

  // images go to disk; the json keeps references, so the file stays readable.
  // Colors are drawings in their own right, so they are written out too —
  // leaving them inline would bloat project.json with base64 and hide them
  // from anyone looking at the traits folder.
  let written = 0;
  const copy = JSON.parse(JSON.stringify(p));
  copy.categories.forEach(function (c, ci) {
    c.traits.forEach(function (t, ti) {
      const stem = String(ci).padStart(2, "0") + "_" + slug(c.name) + "__" + slug(t.name);
      const cols = t.colors || [];
      if (cols.length) {
        cols.forEach(function (k) {
          const buf = dataUrlToPng(k.image);
          if (!buf) { k.image = null; return; }
          const file = stem + "__" + slug(k.name) + ".png";
          fs.writeFileSync(path.join(traitDir, file), buf);
          k.image = "traits/" + file;
          written++;
        });
        t.image = null;   // unused once colors exist
        return;
      }
      const buf = dataUrlToPng(t.image);
      if (!buf) { t.image = null; return; }
      fs.writeFileSync(path.join(traitDir, stem + ".png"), buf);
      t.image = "traits/" + stem + ".png";
      written++;
    });
  });
  fs.writeFileSync(path.join(dir, "project.json"), JSON.stringify(copy, null, 2));
  return { id: id, dir: dir, traits: written };
}

// ---------- server ----------
// A tab left open from before the spelling change still posts `colours`. Without
// this the color art is read as absent and the token silently generates with a
// blank trait, so normalize on the way in rather than trusting the client.
function migrate(p) {
  (p && p.categories || []).forEach(function (c) {
    (c.traits || []).forEach(function (t) {
      if (!t.colors && t.colours) { t.colors = t.colours; delete t.colours; }
    });
  });
  return p;
}

const server = http.createServer(async function (req, res) {
  const url = new URL(req.url, "http://x");

  function json(code, obj) {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj));
  }

  // the editor mirrors these so it can warn before a generate is attempted
  if (url.pathname === "/api/limits") return json(200, gen.LIMITS);

  if (url.pathname === "/api/project" && req.method === "POST") {
    try {
      const p = migrate(await body(req));
      const r = saveProject(p);
      return json(200, { ok: true, id: r.id, traits: r.traits });
    } catch (e) { return json(400, { error: e.message }); }
  }

  // stream the last generated collection as a zip, so the user actually
  // receives the files rather than them sitting on the server
  if (url.pathname === "/api/download") {
    try {
      const id = url.searchParams.get("id");
      if (!id || /[\/\\.]/.test(id)) return json(400, { error: "bad id" });
      const out = path.join(PROJECTS, id, "output");
      if (!fs.existsSync(out)) return json(404, { error: "nothing generated yet" });
      const entries = zip.fromDir(fs, path, out, id);
      const buf = zip.build(entries);
      res.writeHead(200, {
        "Content-Type": "application/zip",
        "Content-Disposition": "attachment; filename=\"" + id + ".zip\"",
        "Content-Length": buf.length
      });
      return res.end(buf);
    } catch (e) { return json(400, { error: e.message }); }
  }

  if (url.pathname === "/api/generate" && req.method === "POST") {
    try {
      const p = migrate(await body(req));
      const saved = saveProject(p);
      const out = path.join(saved.dir, "output");
      const r = gen.generate(p, out, PROJECTS);
      return json(200, Object.assign({ ok: true, id: saved.id, out: path.relative(ROOT, out) }, r));
    } catch (e) { return json(400, { error: e.message }); }
  }

  // index.html is the landing page and app.html the editor, so the filenames
  // match the URLs and a plain static host routes them correctly with no
  // rewrite rules to keep in sync.
  let rel = url.pathname;
  if (rel === "/") rel = "/index.html";
  else if (rel === "/app" || rel === "/app/") rel = "/app.html";
  // generic cleanUrls, matching how Vercel serves /launch -> launch.html —
  // one rule here instead of a mapping to keep in sync per page
  else if (/^\/[a-z-]+$/.test(rel) && fs.existsSync(path.join(PUBLIC, rel + ".html"))) rel = rel + ".html";
  const file = path.join(PUBLIC, path.normalize(rel).replace(/^(\.\.[/\\])+/, ""));
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    return res.end("not found");
  }
  res.writeHead(200, {
    "Content-Type": TYPES[path.extname(file)] || "application/octet-stream",
    "Cache-Control": "no-cache"
  });
  res.end(fs.readFileSync(file));
});

// ---------- staying up ----------
// A malformed request line or a client that hangs mid-body should cost one
// socket, not the process.
server.on("clientError", function (err, socket) {
  if (!socket.destroyed && socket.writable) {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  }
  socket.destroy();
});

// Generation is synchronous and can hold a request open for a while, so these
// are generous — the point is to reap sockets that will never finish, not to
// interrupt real work.
server.requestTimeout = 10 * 60 * 1000;
server.headersTimeout = 60 * 1000;
server.keepAliveTimeout = 30 * 1000;

// The route handlers already catch their own errors. Anything reaching here is
// unexpected, so the process is left in an unknown state — log it loudly and
// exit so the supervisor starts a clean one. Staying up after an unknown fault
// risks serving corrupted output, which is worse than a two-second restart.
function fatal(kind) {
  return function (err) {
    console.error("\n[" + new Date().toISOString() + "] " + kind + ":");
    console.error(err && err.stack ? err.stack : err);
    console.error("exiting so the supervisor can restart\n");
    process.exit(1);
  };
}
process.on("uncaughtException", fatal("uncaughtException"));
process.on("unhandledRejection", fatal("unhandledRejection"));

// Ctrl-C and supervisor stops should close cleanly rather than drop sockets.
["SIGINT", "SIGTERM"].forEach(function (sig) {
  process.on(sig, function () {
    console.log("\n" + sig + " — closing");
    server.close(function () { process.exit(0); });
    setTimeout(function () { process.exit(0); }, 3000).unref();
  });
});

server.listen(PORT, function () {
  fs.mkdirSync(PROJECTS, { recursive: true });
  console.log("\n  NFT Builder  ->  http://localhost:" + PORT + "\n");
  console.log("  projects/    one folder per project: traits, project.json, output");
  console.log("  Pixel mode   indexed grid, hard edges");
  console.log("  Brush mode   1024px raster, pressure, stamped brushes");
  console.log("  Limits       " + human(gen.LIMITS.supply) + " supply · " +
    gen.LIMITS.canvas + "px canvas · " + human(gen.LIMITS.pixels) + " pixels total\n");
});

function human(n) {
  return n >= 1e9 ? (n / 1e9).toFixed(1) + "B"
       : n >= 1e6 ? (n / 1e6).toFixed(0) + "M"
       : n >= 1e3 ? (n / 1e3).toFixed(0) + "K" : String(n);
}
