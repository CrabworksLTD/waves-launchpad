/* The share card, composed in the browser at launch and pinned to Arweave
 * beside the art.
 *
 * Server-side rendering is not an option: @vercel/og dies inside Vercel's
 * current function builder whichever runtime it's given. A canvas in the page
 * that is already launching has none of that fragility, costs one extra file
 * in an upload that is happening anyway, and produces a card that keeps
 * working even if this site disappears — the image lives on Arweave and
 * /api/og only redirects to it.
 *
 * The layout mirrors art/og.png: black, the subject's banner filling the card
 * behind a dim-to-black scrim (or the WAVES staircase in the chain's gradient
 * when there is no banner), the name in Archivo, and the launch numbers along
 * the bottom.
 *
 *   CardMaker.make({ kind:"token"|"collection", chain:"solana"|"robinhood",
 *                    name, sym, avatar, banner, stats:[[label,value],…] })
 *     -> Promise<Uint8Array>  (PNG, 1200x630)
 */
(function () {
  "use strict";

  var W = 1200, H = 630;
  var PAL = {
    solana:   { accent: "#14F195", stops: ["#9945FF", "#6D7EDC", "#40B8B8", "#14F195"] },
    robinhood:{ accent: "#CCFF00", stops: ["#CCFF00", "#D0F248", "#D5E691", "#D9D9D9"] }
  };

  function loadImage(src) {
    return new Promise(function (res) {
      if (!src) return res(null);
      var im = new Image();
      im.crossOrigin = "anonymous";
      im.onload = function () { res(im); };
      im.onerror = function () { res(null); };   // a missing image degrades, never fails
      im.src = src;
    });
  }

  function roundRect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  // draw `im` covering the box, centred — canvas has no object-fit
  function drawCover(g, im, x, y, w, h) {
    var s = Math.max(w / im.width, h / im.height);
    var dw = im.width * s, dh = im.height * s;
    g.drawImage(im, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  }

  /* The WAVES staircase: three squares flush bottom-left, climbing off the top
     edge, each carrying its slice of one continuous sweep. */
  function staircase(g, pal) {
    var S = 210;
    [[0, H - S, 0], [S, H - 2 * S, 1], [2 * S, 0, 2]].forEach(function (p) {
      var lg = g.createLinearGradient(p[0], p[1] + S, p[0] + S, p[1]);
      lg.addColorStop(0, pal.stops[p[2]]);
      lg.addColorStop(1, pal.stops[p[2] + 1]);
      g.fillStyle = lg;
      g.fillRect(p[0], p[1], S, S);
    });
  }

  async function make(o) {
    var pal = PAL[o.chain === "robinhood" ? "robinhood" : "solana"];
    var cv = document.createElement("canvas");
    cv.width = W; cv.height = H;
    var g = cv.getContext("2d");

    // fonts must be resident before the first fillText or the card renders in
    // a fallback face — the launch page has them, but ask anyway
    try {
      await document.fonts.load("800 72px Archivo");
      await document.fonts.load("700 20px Archivo");
      await document.fonts.load("600 34px 'IBM Plex Mono'");
      await document.fonts.ready;
    } catch (e) {}

    g.fillStyle = "#0a0a0a";
    g.fillRect(0, 0, W, H);

    var pair = await Promise.all([loadImage(o.banner), loadImage(o.avatar)]);
    var banner = pair[0], avatar = pair[1];

    /* Background, in order of what we actually have.
     *
     * A launcher who skipped the banner did not choose a bare card. If there is
     * a PFP, use it: square art on a 1200x630 canvas would crop to a sliver, so
     * it is drawn oversized and blurred into a wash of the collection's own
     * colours, with the WAVES staircase still climbing the empty right side so
     * the card is unmistakably ours. */
    if (banner) {
      drawCover(g, banner, 0, 0, W, H);
    } else if (avatar) {
      g.save();
      try { g.filter = "blur(48px)"; } catch (e) {}
      drawCover(g, avatar, -W * 0.25, -H * 0.25, W * 1.5, H * 1.5);
      g.restore();
      staircase(g, pal);
    } else {
      staircase(g, pal);
    }

    // scrim: the body sits on darkness whatever the art is doing
    var art = !!(banner || avatar);
    var sc = g.createLinearGradient(0, 0, 0, H);
    sc.addColorStop(0, art ? "rgba(10,10,10,.25)" : "rgba(10,10,10,.35)");
    sc.addColorStop(.52, art ? "rgba(10,10,10,.55)" : "rgba(10,10,10,.66)");
    sc.addColorStop(1, art ? "rgba(10,10,10,.96)" : "rgba(10,10,10,.94)");
    g.fillStyle = sc;
    g.fillRect(0, 0, W, H);

    // wordmark + handle, top-right. A drop shadow keeps them legible over a
    // LIGHT/white banner — green-on-white and white-on-white would otherwise
    // vanish. On a dark banner the dark shadow is invisible, so the look is
    // unchanged. save/restore so the shadow does not bleed into other draws.
    g.save();
    g.textAlign = "right";
    g.textBaseline = "alphabetic";
    var handle = (window.BRAND && window.BRAND.x) || "@waveslaunchpad";
    // the handle under the wordmark — every shared token card is exposure back
    // to us, so a viewer can find and follow the launchpad's socials
    function drawBranding() {
      g.font = '800 30px Archivo, sans-serif';
      g.fillStyle = pal.accent;
      g.fillText("WAVES", W - 56, 74);
      // Archivo (proportional), not the mono face — the monospace one spaced the
      // letters evenly so "@waveslaunchpad" read as two words with a gap
      g.font = '700 20px Archivo, sans-serif';
      g.fillStyle = "rgba(255,255,255,.9)";
      g.fillText(handle, W - 56, 100);
    }
    /* Two passes. First a soft DARK edge, so both stay legible on a light/white
     * banner (a pure green glow gives no contrast on white). Then a GREEN glow
     * in the WAVES accent layered on top — invisible on dark, a subtle bloom on
     * light, and matches the wordmark either way. */
    g.shadowColor = "rgba(0,0,0,.5)"; g.shadowBlur = 7; g.shadowOffsetY = 1;
    drawBranding();
    g.shadowColor = pal.accent; g.shadowBlur = 16; g.shadowOffsetY = 0;
    drawBranding();
    g.restore();

    // avatar tile with the accent border
    var ax = 56, ay = H - 52 - 176 - 34 - 60, AS = 176;
    ay = H - 52 - 60 - 34 - AS;
    g.save();
    roundRect(g, ax, ay, AS, AS, 22);
    g.clip();
    if (avatar) {
      drawCover(g, avatar, ax, ay, AS, AS);
    } else {
      g.fillStyle = "#191c21";
      g.fillRect(ax, ay, AS, AS);
      g.fillStyle = "rgba(255,255,255,.85)";
      g.font = '800 84px Archivo, sans-serif';
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText((o.name || "?").replace(/^\$/, "").slice(0, 1).toUpperCase(),
        ax + AS / 2, ay + AS / 2 + 4);
    }
    g.restore();
    g.strokeStyle = pal.accent;
    g.lineWidth = 3;
    roundRect(g, ax + 1.5, ay + 1.5, AS - 3, AS - 3, 21);
    g.stroke();

    // name + chip line, right of the avatar
    var tx = ax + AS + 30;
    g.textAlign = "left";
    g.textBaseline = "alphabetic";
    g.fillStyle = "#fff";
    g.font = '800 68px Archivo, sans-serif';
    var name = String(o.name || "").slice(0, 24);
    g.fillText(name, tx, ay + 96);

    g.font = '400 22px "IBM Plex Mono", monospace';
    g.fillStyle = "rgba(255,255,255,.62)";
    var chips = [(o.chain === "robinhood" ? "ROBINHOOD" : "SOLANA")];
    if (o.sym) chips.unshift("$" + String(o.sym).toUpperCase());
    chips.push(o.kind === "token" ? "BONDING CURVE" : "COLLECTION");
    g.fillText(chips.join("  ·  "), tx, ay + 140);

    // the numbers along the bottom
    var sx = 56, sy = H - 92;
    (o.stats || []).forEach(function (st) {
      g.font = '400 20px "IBM Plex Mono", monospace';
      g.fillStyle = "rgba(255,255,255,.45)";
      g.fillText(String(st[0]).toUpperCase(), sx, sy);
      g.font = '600 34px "IBM Plex Mono", monospace';
      g.fillStyle = "#fff";
      g.fillText(String(st[1]), sx, sy + 40);
      sx += Math.max(g.measureText(String(st[1])).width, 120) + 64;
    });

    var blob = await new Promise(function (res) { cv.toBlob(res, "image/png"); });
    if (!blob) throw new Error("Could not compose the share card");
    return new Uint8Array(await blob.arrayBuffer());
  }

  window.CardMaker = { make: make };
})();
