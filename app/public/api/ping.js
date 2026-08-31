// GET /api/ping — deploy canary and og-pipeline probe. Forces a minimal
// ImageResponse render inside a try/catch so the wasm crash that normally
// happens mid-stream (past all error handling) surfaces as readable JSON.
export default async function handler(req, res) {
  const out = { ok: true, v: 3, node: process.version, cwd: process.cwd() };
  try {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { createRequire } = await import("node:module");
    out.hbRel = fs.existsSync("node_modules/@vercel/og/dist/hb.wasm");
    const r2 = createRequire(import.meta.url);
    try {
      const dist = path.dirname(r2.resolve("@vercel/og/dist/index.node.js"));
      out.dist = dist;
      out.hbAtDist = fs.existsSync(path.join(dist, "hb.wasm"));
    } catch (e) { out.resolveErr = String(e.message || e).slice(0, 100); }
  } catch (e) { out.fsErr = String(e).slice(0, 100); }
  try {
    const { ImageResponse } = await import("@vercel/og");
    const r = new ImageResponse(
      { type: "div", props: { style: { width: "100px", height: "100px",
        display: "flex", backgroundColor: "#000" }, children: null } },
      { width: 100, height: 100 });
    const buf = Buffer.from(await r.arrayBuffer());
    out.render = "ok " + buf.length + "b";
  } catch (e) {
    out.render = "FAIL " + String((e && e.message) || e).slice(0, 200);
  }
  res.status(200).json(out);
}
