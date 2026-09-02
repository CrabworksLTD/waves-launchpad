// GET /api/ping — deploy canary.
//
// Deliberately NOT rate limited: it returns a constant and touches nothing,
// so guarding it would cost more than serving it. See api/_guard.js.
export default async function handler(req, res) {
  res.status(200).json({ ok: true, v: 4, node: process.version });
}
