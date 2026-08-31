// GET /api/ping — deploy canary.
export default async function handler(req, res) {
  res.status(200).json({ ok: true, v: 4, node: process.version });
}
