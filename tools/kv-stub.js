#!/usr/bin/env node
/* A throwaway Upstash-compatible KV, so the keeper's crash-resume path can be
 * tested without touching the production store.
 *
 * The keeper writes a payout plan to KV before spending it and marks progress
 * as each batch lands — that is the whole reason a run that dies halfway does
 * not strand money. Testing it needs a store that can be made to fail on cue,
 * which a real Redis will not do politely.
 *
 *   node tools/kv-stub.js 7999 &
 *   KV_REST_API_URL=http://127.0.0.1:7999 KV_REST_API_TOKEN=x node ...
 *
 * POST /fail-after/<n>  makes the (n+1)th write throw, simulating the function
 * being killed mid-distribution. POST /reset clears it.
 *
 * Implements only what api/keeper.js uses: GET, SET (with EX/NX), DEL, LPUSH,
 * LTRIM, LRANGE, LSET.
 */
"use strict";

const http = require("http");
const port = Number(process.argv[2] || 7999);

const store = new Map();
let failAfter = -1;      // -1 = never fail
let writes = 0;

function run(cmd) {
  const op = String(cmd[0] || "").toUpperCase();
  const key = cmd[1];

  if (op === "SET" || op === "DEL" || op === "LPUSH" || op === "LSET" || op === "LTRIM") {
    if (failAfter >= 0 && writes >= failAfter) {
      throw new Error("kv-stub: simulated failure on write " + writes);
    }
    writes++;
  }

  switch (op) {
    case "GET": {
      const v = store.get(key);
      return v === undefined ? null : v;
    }
    case "SET": {
      // SET key value [EX seconds] [NX]
      const nx = cmd.some((x) => String(x).toUpperCase() === "NX");
      if (nx && store.has(key)) return null;
      store.set(key, cmd[2]);
      return "OK";
    }
    case "DEL": {
      const had = store.has(key);
      store.delete(key);
      return had ? 1 : 0;
    }
    case "LPUSH": {
      const list = store.get(key) || [];
      list.unshift(...cmd.slice(2));
      store.set(key, list);
      return list.length;
    }
    case "LRANGE": {
      const list = store.get(key) || [];
      const start = Number(cmd[2]);
      let stop = Number(cmd[3]);
      if (stop < 0) stop = list.length + stop;
      return list.slice(start, stop + 1);
    }
    case "LSET": {
      const list = store.get(key) || [];
      list[Number(cmd[2])] = cmd[3];
      store.set(key, list);
      return "OK";
    }
    case "LTRIM": {
      const list = store.get(key) || [];
      let stop = Number(cmd[3]);
      if (stop < 0) stop = list.length + stop;
      store.set(key, list.slice(Number(cmd[2]), stop + 1));
      return "OK";
    }
    default:
      return null;
  }
}

http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    const send = (code, obj) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };

    const m = req.url.match(/^\/fail-after\/(-?\d+)/);
    if (m) { failAfter = Number(m[1]); writes = 0; return send(200, { ok: true, failAfter }); }
    if (req.url === "/reset") { store.clear(); failAfter = -1; writes = 0; return send(200, { ok: true }); }
    if (req.url === "/dump") {
      return send(200, { keys: [...store.keys()], writes, failAfter });
    }

    let parsed;
    try { parsed = JSON.parse(body || "[]"); } catch (e) { return send(400, { error: "bad json" }); }

    try {
      if (req.url.startsWith("/pipeline") || req.url.startsWith("/multi-exec")) {
        return send(200, parsed.map((c) => ({ result: run(c) })));
      }
      return send(200, { result: run(parsed) });
    } catch (e) {
      return send(500, { error: String(e.message) });
    }
  });
}).listen(port, "127.0.0.1", () => {
  console.log("kv-stub on http://127.0.0.1:" + port);
});
