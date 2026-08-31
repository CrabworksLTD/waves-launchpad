// GET /api/ping — deploy canary with zero imports. If this answers while a
// sibling function 500s, the sibling's imports are what's broken (deps not
// installed or module-type mismatch), not the function pipeline.
export default async function handler(req, res) {
  let dep = "missing";
  try { await import("@vercel/og"); dep = "resolves"; } catch (e) { dep = "missing: " + (e.message || "").slice(0, 120); }
  res.status(200).json({ ok: true, node: process.version, og: dep });
}
