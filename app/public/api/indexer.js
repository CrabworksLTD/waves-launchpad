// GET /api/indexer — walk each launch's pool and record its trades.
//
// The token page needs price history, volume, market cap and holders. None of
// that exists on chain as a queryable thing: a bonding-curve pool knows its
// current state, not what it was an hour ago. So we build the history the only
// way there is — read every transaction that touched the pool, once, and keep
// the result.
//
// ── How a swap is read ───────────────────────────────────────────────────────
// Not from the trader's SOL balance: that includes gas and any account rent
// they paid, which would quietly corrupt the price. It comes from the POOL's
// own vault movements, which are exactly the swap and nothing else.
//
// In every swap the pool authority owns both vaults, so it is the one address
// appearing in both a base-mint move and a quote-mint move. Its quote delta
// tells you the direction:
//
//   pool quote +, pool base −   → somebody bought
//   pool quote −, pool base +   → somebody sold
//
// price = |pool quote delta| / |pool base delta|, in UI units. Verified against
// the $SOLWAVES dev buy: 0.01 SOL in, 353,455.499312 out.
//
// Transactions that touch the pool without moving the base mint — fee claims,
// migration plumbing — move no tokens and are skipped.
//
// ── Cost ─────────────────────────────────────────────────────────────────────
// Each run only reads signatures newer than the cursor, so a quiet token costs
// one request. Backfilling a new token costs one request per historical trade,
// once. Needs an RPC that allows getProgramAccounts and getTokenSupply for the
// holder and supply figures — see api/keeper.js for why the public node is not
// enough.

export const config = { runtime: "nodejs", maxDuration: 300 };

const RPC = process.env.SOLANA_RPC || "https://solana-rpc.publicnode.com";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const MAX_TRADES = 600;          // ~70KB of JSON, plenty for a chart and a feed
const MAX_BACKFILL = 2000;       // signatures per run, so one busy pool cannot
                                 // eat the whole 300s budget
const PAGE = 1000;               // getSignaturesForAddress maximum

function kv() {
  /* No credentials means no store, not a broken one. The Upstash client
   * constructs happily without a url and then fails every command with
   * "Failed to parse URL from /pipeline", which reads like a bug in us and
   * aborted the whole job — so answer null and let callers degrade. */
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    return Promise.resolve(null);
  }
  return import("@upstash/redis").then(({ Redis }) => new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN
  }));
}

/* What the pool's quote asset is worth in dollars.
 *
 * Every figure on the token page is denominated in the quote currency, which
 * is the honest unit for a curve but not a readable one: "27.73 SOL" and
 * "2.77e-8" tell you nothing at a glance. Priced once per run and stored, so
 * the page never makes a third-party call.
 *
 * Jupiter first because it prices any Solana mint including the RWA quotes;
 * CoinGecko as a fallback for SOL, which is the case that matters most. */
const usdCache = new Map();
async function quoteUsd(mint) {
  if (usdCache.has(mint)) return usdCache.get(mint);
  let usd = null;
  try {
    const r = await fetch("https://lite-api.jup.ag/price/v3?ids=" + mint);
    const j = await r.json();
    const v = j && j[mint] && j[mint].usdPrice;
    if (typeof v === "number" && isFinite(v) && v > 0) usd = v;
  } catch (e) { /* fall through */ }
  if (usd == null && mint === "So11111111111111111111111111111111111111112") {
    try {
      const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd");
      const j = await r.json();
      if (j && j.solana && j.solana.usd > 0) usd = j.solana.usd;
    } catch (e) { /* leave null; the page falls back to native units */ }
  }
  usdCache.set(mint, usd);
  return usd;
}

/* Free-tier RPCs rate-limit, and they do it in plain text — a 429 body is
 * "Too Many Requests", not JSON, so parsing it as JSON throws something that
 * reads like a bug in us. Back off and retry instead; a backfill is a burst by
 * nature and one refusal should not cost the whole run. */
async function rpc(method, params, tries) {
  const max = tries == null ? 5 : tries;
  let wait = 400;
  for (let i = 0; i < max; i++) {
    const r = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
    });
    const text = await r.text();
    let j = null;
    try { j = JSON.parse(text); } catch (e) { /* rate limit or gateway page */ }
    if (j && j.error) throw new Error(method + ": " + (j.error.message || "rpc error"));
    if (j) return j.result;
    if (r.status !== 429 && r.status < 500) {
      throw new Error(method + ": " + r.status + " " + text.slice(0, 60));
    }
    await new Promise((s) => setTimeout(s, wait));
    wait = Math.min(wait * 2, 4000);
  }
  throw new Error(method + ": rate limited after " + max + " attempts");
}

/* Every token account movement in one transaction, keyed by account index so a
 * balance that only appears on one side still counts (a freshly created ATA has
 * no pre-balance). */
function moves(meta) {
  const by = new Map();
  for (const b of meta.preTokenBalances || []) {
    by.set(b.accountIndex, {
      owner: b.owner, mint: b.mint, dec: b.uiTokenAmount.decimals,
      pre: BigInt(b.uiTokenAmount.amount), post: 0n
    });
  }
  for (const b of meta.postTokenBalances || []) {
    const e = by.get(b.accountIndex) || {
      owner: b.owner, mint: b.mint, dec: b.uiTokenAmount.decimals, pre: 0n, post: 0n
    };
    e.post = BigInt(b.uiTokenAmount.amount);
    by.set(b.accountIndex, e);
  }
  const out = [];
  for (const e of by.values()) {
    const d = e.post - e.pre;
    if (d !== 0n) out.push({ owner: e.owner, mint: e.mint, dec: e.dec, delta: d });
  }
  return out;
}

function readSwap(tx, baseMint, sig, blockTime) {
  if (!tx || !tx.meta || tx.meta.err) return null;
  const ms = moves(tx.meta);
  const base = ms.filter((m) => m.mint === baseMint);
  if (base.length < 2) return null;                 // not a swap of this token

  // the pool authority is the address on both sides of the trade
  const quoteByOwner = new Map();
  for (const m of ms) {
    if (m.mint === baseMint) continue;
    if (!quoteByOwner.has(m.owner)) quoteByOwner.set(m.owner, m);
  }
  const poolSide = base.find((b) => quoteByOwner.has(b.owner));
  if (!poolSide) return null;
  const poolQuote = quoteByOwner.get(poolSide.owner);
  const trader = base.find((b) => b.owner !== poolSide.owner);
  if (!trader || poolQuote.delta === 0n || poolSide.delta === 0n) return null;

  /* Size comes from the TRADER's side, not the pool's. They are the same
   * number in an ordinary swap, but not in the launch transaction: createPool
   * WithFirstBuy mints the whole supply into the vault and does the dev buy at
   * once, so the pool's delta there is ~the entire supply. Reading the pool
   * side made the launch look like a 999,646,544-token buy for 0.01 SOL — a
   * price of 1e-11 that dragged "change since launch" to +456,570%. The
   * trader's delta is what they actually received: 353,455.499312. */
  const abs = (x) => (x < 0n ? -x : x);
  const baseAmt = Number(abs(trader.delta)) / Math.pow(10, trader.dec);
  const quoteAmt = Number(abs(poolQuote.delta)) / Math.pow(10, poolQuote.dec);
  if (!(baseAmt > 0) || !(quoteAmt > 0)) return null;

  return {
    sig,
    at: (blockTime || 0) * 1000,
    who: String(trader.owner || ""),
    side: poolQuote.delta > 0n ? "buy" : "sell",    // pool gained quote = a buy
    tokens: baseAmt,
    quote: quoteAmt,
    // which asset the pool is priced in, learned from the swap itself rather
    // than from the launch record (which does not keep it)
    qmint: poolQuote.mint,
    price: quoteAmt / baseAmt
  };
}

export default async function handler(req, res) {
  /* Two ways in.
   *
   * The cron sweeps everything and needs the secret. But a launch and a trade
   * both want their token indexed NOW — waiting up to ten minutes to see your
   * own buy appear is the difference between a page that feels live and one
   * that feels broken — and neither a launch panel nor a trading page can hold
   * a secret. So a single named mint may be indexed without one, rate-limited
   * per mint, and only if we already have a record of it. The work is bounded:
   * it reads the signatures since that pool's cursor and stops. */
  const secret = process.env.CRON_SECRET;
  const authed = !secret || req.headers.authorization === "Bearer " + secret;
  const only = (req.query && req.query.mint) || null;
  if (!authed && !only) return res.status(401).json({ error: "no" });

  const log = [];
  try {
    const db = await kv();
    const proto = req.headers["x-forwarded-proto"] || "https";
    const origin = proto + "://" + (req.headers["x-forwarded-host"] || req.headers.host);
    const j = await fetch(origin + "/api/tokens").then((r) => r.json()).catch(() => ({}));
    const toks = (j.tokens || []).filter((t) => t.pool && t.mint);

    /* An unauthenticated caller may only name a mint we have already recorded,
     * and only once every 20 seconds. That bounds it to work we would do on the
     * next cron sweep anyway. */
    if (!authed) {
      if (!toks.some((t) => t.mint === only)) {
        return res.status(404).json({ error: "not a launch we know about" });
      }
      const gate = await db.set("ixhit:" + only, 1, { nx: true, ex: 20 }).catch(() => "OK");
      if (gate !== "OK") return res.status(200).json({ ok: true, throttled: true });
    }

    for (const t of only ? toks.filter((x) => x.mint === only) : toks) {
      try {
        const cursorKey = "ix:" + t.mint + ":cursor";
        const tradesKey = "ix:" + t.mint + ":trades";
        const statsKey = "ix:" + t.mint + ":stats";

        let cursor = await db.get(cursorKey).catch(() => null);
        if (req.query && req.query.reset === "1") {
          // re-read a pool from scratch, for when a parsing bug has already
          // written wrong numbers (gated by CRON_SECRET like the rest)
          cursor = null;
          await db.del(tradesKey).catch(() => {});
          await db.del(statsKey).catch(() => {});
          await db.del(cursorKey).catch(() => {});
        }

        /* Collect signatures newer than the cursor, newest first. `until` stops
         * the walk at what we already have, so steady state is one request. */
        const fresh = [];
        let before = null;
        for (let page = 0; page < Math.ceil(MAX_BACKFILL / PAGE); page++) {
          const opts = { limit: PAGE };
          if (before) opts.before = before;
          if (cursor) opts.until = cursor;
          const sigs = await rpc("getSignaturesForAddress", [t.pool, opts]);
          if (!sigs.length) break;
          fresh.push(...sigs);
          if (sigs.length < PAGE) break;
          before = sigs[sigs.length - 1].signature;
        }
        /* No new trades is not a reason to stop: supply, holders and therefore
         * market cap all move without anyone trading, and skipping the rest of
         * this loop meant they were only ever written during a backfill. */
        const quiet = !fresh.length;

        // oldest first, so the stored list stays in order and ATH is found
        // in the sequence it actually happened
        fresh.reverse();
        const found = [];

        /* The cursor may only advance over signatures we actually READ. It used
         * to advance to the newest signature regardless, so when the rate
         * limiter ate the last few reads of a backfill, those trades were
         * skipped and then permanently excluded from every future run — the
         * first index of $SOLWAVES lost its five newest trades that way.
         * Stop at the first unreadable transaction and let the next run retry. */
        let safeCursor = cursor;
        let stalled = false;
        for (const s of fresh) {
          if (s.err) { if (!stalled) safeCursor = s.signature; continue; }
          const tx = await rpc("getTransaction", [s.signature, {
            encoding: "jsonParsed", maxSupportedTransactionVersion: 0,
            commitment: "confirmed"
          }]).catch(() => null);
          if (!tx) {
            stalled = true;
            log.push(t.symbol + ": could not read " + s.signature.slice(0, 12) +
                     ", holding the cursor for the next run");
            break;
          }
          const trade = readSwap(tx, t.mint, s.signature, s.blockTime);
          if (trade) found.push(trade);
          safeCursor = s.signature;
          // pace the backfill so the reads that come after it are not the ones
          // that get refused
          await new Promise((r) => setTimeout(r, 60));
        }

        let stored = await db.get(tradesKey).catch(() => null);
        if (typeof stored === "string") { try { stored = JSON.parse(stored); } catch { stored = null; } }
        /* Dedupe by signature: holding the cursor back means a later run can
         * legitimately re-read transactions it already stored. */
        const seen = new Set((Array.isArray(stored) ? stored : []).map((x) => x.sig));
        const all = (Array.isArray(stored) ? stored : [])
          .concat(found.filter((f) => !seen.has(f.sig)));
        all.sort((a, b) => a.at - b.at);
        // newest last; trim the oldest away
        const trades = all.slice(-MAX_TRADES);

        // supply and holders — both need an RPC that answers indexed requests
        let supply = null, decimals = 6, holders = null;
        try {
          const s = await rpc("getTokenSupply", [t.mint]);
          supply = Number(s.value.amount) / Math.pow(10, s.value.decimals);
          decimals = s.value.decimals;
        } catch (e) { log.push(t.symbol + ": supply unavailable (" + e.message.slice(0, 60) + ")"); }
        try {
          const accts = await rpc("getProgramAccounts", [TOKEN_PROGRAM, {
            encoding: "base64",
            filters: [{ dataSize: 165 }, { memcmp: { offset: 0, bytes: t.mint } }]
          }]);
          let n = 0;
          for (const a of accts) {
            const d = Buffer.from(a.account.data[0], "base64");
            if (d.readBigUInt64LE(64) > 0n) n++;
          }
          holders = n;
        } catch (e) { /* leave null; the page says "—" rather than a wrong number */ }

        /* ATH is cumulative: trades get trimmed, so the previous high has to
         * survive independently of the list it came from. */
        let prev = await db.get(statsKey).catch(() => null);
        if (typeof prev === "string") { try { prev = JSON.parse(prev); } catch { prev = null; } }
        let ath = (prev && prev.ath) || 0, athAt = (prev && prev.athAt) || 0;
        for (const tr of found) {
          if (tr.price > ath) { ath = tr.price; athAt = tr.at; }
        }

        const now = Date.now();
        const since = (ms) => trades.filter((x) => now - x.at <= ms);
        const sum = (rows, f) => rows.reduce((a, b) => a + f(b), 0);
        const d1 = since(86400000);
        const last = trades.length ? trades[trades.length - 1] : null;
        const price = last ? last.price : (prev && prev.price) || null;

        // the quote asset comes from the swaps themselves; SOL if we have none
        const qmint = (last && last.qmint) ||
          (prev && prev.quoteMint) || "So11111111111111111111111111111111111111112";
        const qusd = await quoteUsd(qmint);

        const stats = {
          mint: t.mint,
          price,
          quoteMint: qmint,
          quoteUsd: qusd,
          priceUsd: price != null && qusd != null ? price * qusd : null,
          // the standard quote: price times everything that exists
          mcap: price != null && supply != null ? price * supply : null,
          mcapUsd: price != null && supply != null && qusd != null
            ? price * supply * qusd : null,
          supply, decimals, holders,
          ath, athAt,
          vol24h: sum(d1, (x) => x.quote),
          vol7d: sum(since(604800000), (x) => x.quote),
          trades24h: d1.length,
          buyers24h: new Set(d1.filter((x) => x.side === "buy").map((x) => x.who)).size,
          firstAt: trades.length ? trades[0].at : null,
          lastAt: last ? last.at : null,
          count: trades.length,
          at: now
        };

        await db.set(tradesKey, JSON.stringify(trades));
        await db.set(statsKey, JSON.stringify(stats));
        if (safeCursor && safeCursor !== cursor) await db.set(cursorKey, safeCursor);
        log.push(t.symbol + ": " + (quiet ? "no new trades" : "+" + found.length + " trades") +
                 " (" + trades.length + " kept), " +
                 (holders == null ? "holders n/a" : holders + " holders") +
                 (stats.mcap == null ? ", mcap n/a" : ", mcap " + stats.mcap.toFixed(2)));
      } catch (e) {
        log.push((t.symbol || t.mint) + ": FAILED " + String((e && e.message) || e).slice(0, 140));
      }
    }
    return res.status(200).json({ ok: true, indexed: log.length, log });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String((e && e.message) || e).slice(0, 300), log });
  }
}
