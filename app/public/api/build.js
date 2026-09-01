// GET /api/build -> { build }
//
// The identity of the code currently deployed. A launch page left open across a
// deploy keeps running the JavaScript it loaded — which is how three launches
// in a row hit a bug that had already been fixed, each one paying a storage fee
// on the way. The page checks this before it spends anything.

export const config = { runtime: "nodejs" };

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({
    build: process.env.VERCEL_GIT_COMMIT_SHA || process.env.VERCEL_DEPLOYMENT_ID || "dev"
  });
}
