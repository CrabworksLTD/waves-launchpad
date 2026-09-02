/* node tools/test-ratelimit.mjs
 *
 * Exercises the real limiter against a stand-in Upstash that speaks the REST
 * protocol, so the pipeline call, the counting and the key layout are all the
 * production ones. Only the store is fake. */
import http from "node:http";

const store = new Map();          // key -> { n, ttl }
let commands = 0;
let failNext = false;

function run(cmd) {
  commands++;
  const [op, key, arg] = cmd;
  const name = String(op).toUpperCase();
  if (name === "INCRBY") {
    const cur = store.get(key) || { n: 0, ttl: null };
    cur.n += Number(arg);
    store.set(key, cur);
    return cur.n;
  }
  if (name === "EXPIRE") {
    const cur = store.get(key);
    if (cur) cur.ttl = Number(arg);
    return 1;
  }
  return null;
}

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    if (failNext) {                       // simulate the store being unreachable
      res.writeHead(500); return res.end("boom");
    }
    const parsed = JSON.parse(body || "[]");
    res.setHeader("content-type", "application/json");
    if (req.url.includes("pipeline")) {
      return res.end(JSON.stringify(parsed.map((c) => ({ result: run(c) }))));
    }
    res.end(JSON.stringify({ result: run(parsed) }));
  });
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

process.env.KV_REST_API_URL = "http://127.0.0.1:" + port;
process.env.KV_REST_API_TOKEN = "test";

const { allow, clientIp } = await import(
  "../app/public/api/_guard.js"
);

const nodeReq = (ip) => ({ headers: { "x-forwarded-for": ip }, socket: {} });
const edgeReq = (ip) => ({ headers: new Headers({ "x-forwarded-for": ip }) });

let failures = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log((ok ? "  ok  " : " FAIL ") + label + (ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
};

// ── the ceiling is exact
let allowed = 0;
for (let i = 0; i < 25; i++) if (await allow(nodeReq("1.1.1.1"), { bucket: "t1", max: 20, windowSec: 60 })) allowed++;
check("lets through exactly max, then refuses", allowed, 20);

// ── cost: a batch of 20 must count as 20, not as 1
allowed = 0;
for (let i = 0; i < 5; i++) if (await allow(nodeReq("2.2.2.2"), { bucket: "t2", max: 50, windowSec: 60, cost: 20 })) allowed++;
check("a batch is charged per call, not per request", allowed, 2);

// ── callers are isolated from each other
const a = await allow(nodeReq("3.3.3.3"), { bucket: "t3", max: 1, windowSec: 60 });
const b = await allow(nodeReq("4.4.4.4"), { bucket: "t3", max: 1, windowSec: 60 });
check("one caller's flood does not spend another's budget", [a, b], [true, true]);

// ── the identity used is the proxy-appended entry, not the caller's claim
check("a spoofed x-forwarded-for cannot fake a fresh identity",
  clientIp(nodeReq("9.9.9.9, 5.5.5.5")), "5.5.5.5");

// ── an edge request carries Headers, not a plain object
check("edge and node requests resolve the same caller",
  clientIp(edgeReq("6.6.6.6")), "6.6.6.6");

// ── concurrency: 100 at once against a ceiling of 40
const results = await Promise.all(
  Array.from({ length: 100 }, () => allow(nodeReq("7.7.7.7"), { bucket: "conc", max: 40, windowSec: 60 }))
);
check("100 concurrent requests still see exactly the ceiling",
  results.filter(Boolean).length, 40);

// ── every key must carry a TTL, or the store fills up forever
const untl = [...store.entries()].filter(([, v]) => v.ttl === null).map(([k]) => k);
check("every counter is given an expiry", untl, []);

// ── one round trip per request
const before = commands;
await allow(nodeReq("8.8.8.8"), { bucket: "cost", max: 10, windowSec: 60 });
check("costs two commands in one pipeline", commands - before, 2);

// ── an unreachable store must not lock the site out
failNext = true;
const openWhenBroken = await allow(nodeReq("1.1.1.1"), { bucket: "t1", max: 1, windowSec: 60 });
failNext = false;
check("fails open when the store is unreachable", openWhenBroken, true);

server.close();
console.log(failures ? `\n${failures} failed` : "\nlimiter behaves under all of the above");
process.exit(failures ? 1 : 0);
