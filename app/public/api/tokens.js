// GET  /api/tokens        -> { tokens: [...] }   newest first
// POST /api/tokens        -> { ok: true }         record a launch
//
// The index of tokens launched here, mirroring api/collections.js — same
// reasoning, same failure mode. Deliberately a separate file with a separate
// Redis key rather than a `kind` param on the collections endpoint: Vercel
// functions are standalone, the file is forty lines, and two trivially
// readable endpoints beat one with branching.
//
// Only identity is stored (mint, name, symbol). Price and curve progress are
// live chain state and are read client-side where they are shown — a cached
// "43% to graduation" on a token that graduated an hour ago is worse than
// showing nothing.

import { okArt as okArtShared } from "./_art.js";
import { allow, tooMany, isRealLaunch, isRealEvmToken, archiveOverflow } from "./_guard.js";

const KEY = "tokens";
const MAX = 200;

function kv() {
  return import("@upstash/redis").then(({ Redis }) => new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN
  }));
}

const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM = /^0x[0-9a-fA-F]{40}$/;

export default async function handler(req, res) {
  if (req.method === "GET") {
    try {
      const db = await kv();
      const raw = await db.lrange(KEY, 0, MAX - 1);
      const out = (raw || []).map((r) => (typeof r === "string" ? JSON.parse(r) : r));
      /* ⚠️ Short, because this list is what tells a creator their launch exists.
       *
       * It was s-maxage=60 with stale-while-revalidate=600, so the CDN could
       * keep serving a ten-minute-old copy — and the copy that matters is the
       * one from just BEFORE a launch. A creator finished launching, opened the
       * homepage they had just added something to, and read "Nothing launched
       * yet" for up to ten minutes. That is the worst possible moment to look
       * broken, and it is exactly when someone shares the link.
       *
       * The list is one small KV read, so ten seconds of CDN caching still caps
       * the origin at six requests a minute however much traffic arrives. */
      res.setHeader("Cache-Control", "public, s-maxage=10, stale-while-revalidate=30");
      return res.status(200).json({ tokens: out });
    } catch (e) {
      // an unreachable store must not 500 the homepage
      return res.status(200).json({ tokens: [], degraded: true });
    }
  }

  if (req.method === "POST") {
    /* A launch is a rare event for any one person and a flood is never real. */
    if (!(await allow(req, { bucket: "tokens", max: 10, windowSec: 600 }))) return tooMany(res, 600);

    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const { mint, name, symbol, cluster, rewardMint, collection, creator, icon, banner, pool, config, feeShare, feeSharePct, feeWallet, chain, backend } = body;
    const isEvm = chain === "robinhood";

    /* A Robinhood Chain token is a 0x contract, not a base58 mint — the same
     * split api/collections.js makes. Validating everything as base58 would
     * reject every EVM launch with "bad mint". */
    if (isEvm) {
      if (!EVM.test(mint || "")) return res.status(400).json({ error: "bad address" });
    } else {
      if (!B58.test(mint || "")) return res.status(400).json({ error: "bad mint" });
      // both optional; validated when present so a bad value is dropped loudly
      if (rewardMint && !B58.test(rewardMint)) return res.status(400).json({ error: "bad rewardMint" });
      if (collection && !B58.test(collection)) return res.status(400).json({ error: "bad collection" });
      // Mainnet only — a devnet token on the homepage is a bug dressed as a scam.
      if (cluster && cluster !== "mainnet-beta") return res.status(200).json({ ok: true, skipped: "not mainnet" });
    }

    /* Prove it exists before listing it.
     *
     * ⚠️ Everything above this line is a SHAPE check, and shape is not
     * identity: "is this 32-44 base58 characters" is true of any such string.
     * The list is capped and trimmed, so two hundred well-formed strings pushed
     * every real launch off the homepage permanently, for the price of two
     * hundred HTTP requests. A listing now has to name a mint that exists and a
     * pool the bonding curve owns, which cannot be typed — it has to be
     * launched.
     *
     * Admins skip this: the correction path exists precisely for records the
     * chain disagrees with, and it already requires the deploy secret. */
    const isAdmin = process.env.CRON_SECRET &&
      req.headers.authorization === "Bearer " + process.env.CRON_SECRET;
    if (!isAdmin) {
      const real = isEvm ? await isRealEvmToken(mint) : await isRealLaunch(mint, pool);
      if (!real.ok) {
        /* Fail closed, including when the chain cannot be reached. Listing an
         * unverified token to be helpful during an outage reopens the whole
         * hole; the launch itself already succeeded, and the client can post
         * again. */
        return res.status(real.reason === "unverifiable" ? 503 : 400)
          .json({ ok: false, error: real.reason, retryable: real.reason === "unverifiable" });
      }
    }

    try {
      const db = await kv();
      // one rule for every endpoint — see api/_art.js
      const okArt = (u) => okArtShared(u, req.headers.host);
      const rec = {
        mint,
        name: String(name || "Untitled").slice(0, 40),
        symbol: String(symbol || "").slice(0, 12),
        /* Which side launched it. Mirrors api/collections.js — null means
         * Solana, so records written before this field existed stay Solana,
         * which is what they are. Without it the tokens page showed every
         * launch on both chains. */
        chain: isEvm ? "robinhood" : null,
        /* Which Solana launch backend created the pool: "launchlab" (Raydium
         * LaunchLab) or null (Meteora DBC — the default, so every record written
         * before this field, and every EVM record, reads as Meteora/legacy). The
         * token page, keeper, and stats route their pool reads/claims on this. */
        backend: backend === "launchlab" ? "launchlab" : null,
        // the reward asset the creator picked, and the collection this token
        // is paired with — consumed by the staking keeper later, displayed now
        rewardMint: rewardMint || null,
        /* The pool's QUOTE asset (Robinhood Chain): ETH by default, else USDG or
         * a tokenised stock. The indexer/keeper/token-page read it to price the
         * pool and denominate fees. Validated like any other address. */
        quoteMint: (body.quoteMint && EVM.test(body.quoteMint)) ? String(body.quoteMint).toLowerCase() : null,
        quoteSym: (body.quoteSym && /^[A-Za-z0-9$.\-]{1,12}$/.test(body.quoteSym)) ? String(body.quoteSym) : null,
        /* What the pledged share does: pay holders an asset, or buy the token
         * back and burn it. Anything unrecognised reads as a dividend, which
         * is the behaviour every launch had before this existed. */
        /* "none" is the creator keeping everything, and it is the DEFAULT the
         * launch window opens on — so falling through to "dividend" recorded
         * the opposite of what most launches chose. */
        rewardMode: ["burn", "keep", "none", "split"].includes(body.rewardMode) ? body.rewardMode : "dividend",
        /* Solana LaunchLab fee tier. Drives which platform-config the keeper
         * claims from (standard needs no keeper forward). EVM/Meteora records
         * default to standard, which is correct — they have no ladder. */
        tier: ["standard", "t2", "t3", "t4", "t5"].includes(body.tier) ? body.tier : "standard",
        // per-NFT burn-to-activate amount (paired launches) — the staking page
        // defaults its stake input to this. A positive number or null.
        burn: (Number.isFinite(+body.burn) && +body.burn > 0) ? +body.burn : null,
        // only arweave art, never an arbitrary URL someone POSTs at us
        card: okArt(body.card),
        icon: okArt(icon), banner: okArt(banner),
        pool: (pool && B58.test(pool)) ? pool : null,
        feeShare: feeShare === "holders" ? "holders" : "keep",
        feeSharePct: Math.max(0, Math.min(100, parseInt(feeSharePct, 10) || 0)),
        // where the creator's KEPT portion goes. Dropped on the floor until
        // 2026-08-31, so the keeper always paid the deployer wallet while the
        // launch window promised it would route here.
        feeWallet: (feeWallet && (B58.test(feeWallet) || EVM.test(feeWallet))) ? feeWallet : null,
        config: (config && B58.test(config)) ? config : null,
        /* The block an EVM launch happened in. The holder indexer needs a start
         * point and cannot recover one later: this chain prunes historical
         * state within minutes, so there is no asking what block a contract
         * appeared in. Solana records stay null; they do not need it. */
        block: Number.isFinite(body.block) && body.block > 0 ? Math.floor(body.block) : null,
        collection: collection || null,
        /* ⚠️ An address is base58 OR 0x, depending on the chain — the same
         * split the mint check above makes, and the one collections.js already
         * makes. Validating both of these as base58 alone silently nulled them
         * on every Robinhood launch: the creator, so /fees could not match a
         * launch to the wallet that made it, and the fee wallet, so the kept
         * portion lost the destination the creator had chosen for it. */
        creator: (creator && (B58.test(creator) || EVM.test(creator))) ? creator : null,
        /* Paired NFT-reward launch: which keeper services the token, the
         * collection whose NFT holders are paid, and the reward vault the keeper
         * forwards fees into. rh-keeper-nft.js reads all three to know a token
         * is its to service; the claim page reads vault + pairedCollection. */
        keeper: body.keeper === "nft" ? "nft" : null,
        /* An address is base58 (Solana) OR 0x (Robinhood), by chain — same split
         * as mint/creator above. The Solana LaunchLab keeper reads pairedCollection
         * to derive the staking pool PDA, so validating it EVM-only silently nulled
         * every Solana pair (and lowercasing would corrupt a base58 pubkey). */
        pairedCollection: body.pairedCollection
          ? (isEvm
              ? (EVM.test(body.pairedCollection) ? String(body.pairedCollection).toLowerCase() : null)
              : (B58.test(body.pairedCollection) ? String(body.pairedCollection) : null))
          : null,
        vault: body.vault
          ? (isEvm
              ? (EVM.test(body.vault) ? String(body.vault).toLowerCase() : null)
              : (B58.test(body.vault) ? String(body.vault) : null))
          : null,
        at: Date.now()
      };
      /* Maintenance correction. Filling blanks is open to anyone (it cannot
       * destroy data); CHANGING a value that is already there is not, or a
       * listing could be rewritten by a stranger. Vercel's cron secret is the
       * key, so only someone who can already deploy can do it. */
      const admin = process.env.CRON_SECRET &&
        req.headers.authorization === "Bearer " + process.env.CRON_SECRET;
      if (admin) {
        const raw = await db.lrange(KEY, 0, MAX - 1);
        for (let i = 0; i < (raw || []).length; i++) {
          const cur = typeof raw[i] === "string" ? JSON.parse(raw[i]) : raw[i];
          if (!cur || cur.mint !== mint) continue;
          /* Only fields the caller actually SENT.
           *
           * This used to copy every non-null field of `rec`, but `rec` is a
           * fully-formed record with defaults — name falls back to "Untitled"
           * and symbol to "", neither of which is null. So correcting one field
           * silently renamed the token to "Untitled" and blanked its ticker.
           * Doing it to $SOLWAVES while attaching its share card is how this
           * was found. */
          for (const k of Object.keys(rec)) {
            if (k === "at" || !(k in body)) continue;
            if (rec[k] != null) cur[k] = rec[k];
          }
          await db.lset(KEY, i, JSON.stringify(cur));
          return res.status(200).json({ ok: true, corrected: true });
        }
      }

      // Low: check-then-claim, with the dedupe key written AFTER the list entry
      // (below). The old nx-set claimed the key first, so an lpush failure left
      // the mint marked listed but in no list — permanently unlistable. Worst
      // case now is a recoverable double entry, not a lost launch.
      const exists = await db.get("tok:" + mint);
      if (exists) {
        /* Already listed. The ONLY thing an unauthenticated caller may fill is
         * the art that finishes uploading after the record is written — icon,
         * banner, card. Everything that routes value (feeWallet, vault, keeper,
         * pairedCollection, rewardMint, pool, config) is deliberately NOT
         * fillable here: a stranger could POST a blank one on a victim's own
         * mint+pool and redirect its fees on the next keeper run (C-2). Those
         * corrections go through the admin-bearer path above. Existing values are
         * never overwritten either way. */
        const FILLABLE = ["icon", "banner", "card"];
        const raw = await db.lrange(KEY, 0, MAX - 1);
        for (let i = 0; i < (raw || []).length; i++) {
          const cur = typeof raw[i] === "string" ? JSON.parse(raw[i]) : raw[i];
          if (!cur || cur.mint !== mint) continue;
          let changed = false;
          for (const k of FILLABLE) {
            if ((cur[k] === null || cur[k] === undefined) && rec[k] != null) {
              cur[k] = rec[k]; changed = true;
            }
          }
          if (changed) await db.lset(KEY, i, JSON.stringify(cur));
          return res.status(200).json({ ok: true, updated: changed, duplicate: !changed });
        }
        return res.status(200).json({ ok: true, duplicate: true });
      }

      await db.lpush(KEY, JSON.stringify(rec));
      // whatever falls off the end is kept, so the cap is a window and not a delete
      await archiveOverflow(db, KEY, MAX);
      await db.ltrim(KEY, 0, MAX - 1);
      // claim the dedupe key only now that the entry is actually in the list
      await db.set("tok:" + mint, 1);
      return res.status(200).json({ ok: true });
    } catch (e) {
      // a launch must never fail because the listing did
      return res.status(200).json({ ok: false, detail: "not listed" });
    }
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "GET or POST" });
}
