// The Share modal: a live preview of the launch's share card, then Share on X /
// Telegram, Copy Link, and Copy / Save Image.
//
//   window.WavesShare.open({ id, to, name, title });
//
//   id     the address the card is keyed on — candy machine for a mint page,
//          mint for a token page
//   to     "mint" | "token" — which page the shared link lands a human on
//
// Ported from Moonpad's share-widget.js, which is the behaviour Kyle wants:
// seeing the card before you post it, and being able to save the image for
// somewhere that will not unfurl a link.
//
// Two cache subtleties carried over, both learned the hard way there:
//
//  - The SHARED link gets a per-share `v=` key. X, Telegram and iMessage cache
//    an unfurl per exact URL, so a link shared while a card was broken keeps
//    showing that broken card forever. A key the platform has never seen forces
//    a fresh fetch. It only re-renders the tiny /api/share HTML — the image
//    itself stays cached by address.
//  - The PREVIEW gets a per-day key, so a browser holding an older render does
//    not keep showing it here while everyone else sees the new one.

(function () {
  "use strict";

  var ICON = {
    x: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M18.9 2h3.3l-7.2 8.2L23.5 22h-6.6l-5.2-6.8L5.7 22H2.4l7.7-8.8L1.5 2h6.8l4.7 6.2L18.9 2zm-1.2 18h1.8L7.1 3.9H5.2L17.7 20z"/></svg>',
    telegram: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M21.9 4.3 18.9 19c-.2 1-.8 1.3-1.7.8l-4.6-3.4-2.2 2.1c-.3.3-.5.5-1 .5l.3-4.7L18.3 6c.4-.3-.1-.5-.6-.2L6.9 12.7l-4.6-1.4c-1-.3-1-1 .2-1.5l18-6.9c.8-.3 1.6.2 1.4 1.4Z"/></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
    download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v12m0 0l-4-4m4 4l4-4M4 21h16"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18"/></svg>'
  };

  function q(o) {
    return "id=" + encodeURIComponent(o.id) +
           "&to=" + (o.to === "token" ? "token" : "mint");
  }
  function shareUrl(o) {
    return location.origin + "/api/share?" + q(o) + "&v=" + Date.now().toString(36);
  }
  function cardUrl(o) {
    return location.origin + "/api/og?" + q(o);
  }

  /* Styled from theme.css so the modal follows the chain skin — it is lime on
     the Robinhood side without a second stylesheet. */
  var CSS = [
    ".wv-sh-veil{position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.74);",
    "  backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;padding:20px}",
    ".wv-sh{width:min(500px,94vw);max-height:92vh;overflow:auto;background:var(--panel);",
    "  border:1px solid var(--line2);border-radius:18px;padding:20px;color:var(--ink);",
    "  font:400 15px Inter,ui-sans-serif,system-ui,sans-serif;",
    "  box-shadow:0 30px 90px -20px rgba(0,0,0,.9)}",
    ".wv-sh-hd{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}",
    ".wv-sh-hd h3{margin:0;font:800 21px Archivo,sans-serif;letter-spacing:-.015em}",
    ".wv-sh-x{width:34px;height:34px;border-radius:50%;border:1px solid var(--line2);",
    "  background:none;color:var(--faint);display:flex;align-items:center;justify-content:center;",
    "  cursor:pointer;transition:color .18s,border-color .18s}",
    ".wv-sh-x:hover{color:var(--ink);border-color:var(--faint)}",
    ".wv-sh-x svg{width:16px;height:16px}",
    ".wv-sh-card{width:100%;aspect-ratio:1200/630;border-radius:12px;border:1px solid var(--line);",
    "  background:var(--void);margin-bottom:14px;display:block;object-fit:cover}",
    ".wv-sh-card.miss{display:grid;place-items:center;color:var(--faint);",
    "  font:400 13px 'IBM Plex Mono',monospace;text-align:center;padding:20px}",
    ".wv-sh-btn{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;",
    "  padding:12px;border-radius:12px;border:1px solid var(--line2);background:none;",
    "  color:var(--ink);font:600 14.5px Inter,sans-serif;cursor:pointer;margin-top:8px;",
    "  transition:border-color .18s,background .18s}",
    ".wv-sh-btn:hover{border-color:var(--faint);background:var(--panel2)}",
    ".wv-sh-btn svg{width:18px;height:18px;flex:none}",
    ".wv-sh-btn.x{background:#000;border-color:#000;color:#fff}",
    ".wv-sh-btn.x:hover{background:#141414;border-color:#333}",
    ".wv-sh-split{display:flex;gap:8px;margin-top:8px}",
    ".wv-sh-split .wv-sh-btn{margin-top:0;font-weight:500}",
    "@media (prefers-reduced-motion:reduce){.wv-sh-btn{transition:none}}"
  ].join("");

  function injectCss() {
    if (document.getElementById("wv-sh-css")) return;
    var s = document.createElement("style");
    s.id = "wv-sh-css";
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  }

  function open(o) {
    injectCss();
    var url = shareUrl(o);
    var card = cardUrl(o);
    var text = (o.name || "This launch") + " on WAVES";
    var day = new Date().toISOString().slice(0, 10).replace(/-/g, "");

    var veil = document.createElement("div");
    veil.className = "wv-sh-veil";
    veil.innerHTML =
      '<div class="wv-sh" role="dialog" aria-modal="true" aria-label="Share">' +
        '<div class="wv-sh-hd"><h3>Share ' + esc(o.title || "launch") + "</h3>" +
          '<button class="wv-sh-x" aria-label="Close">' + ICON.close + "</button></div>" +
        '<img class="wv-sh-card" alt="Share card preview" src="' + esc(card + "&d=" + day) + '">' +
        '<button class="wv-sh-btn x" data-a="x">' + ICON.x + " Share on X</button>" +
        '<button class="wv-sh-btn" data-a="tg">' + ICON.telegram + " Share on Telegram</button>" +
        '<button class="wv-sh-btn" data-a="link">' + ICON.copy + " Copy link</button>" +
        '<div class="wv-sh-split">' +
          '<button class="wv-sh-btn" data-a="img">' + ICON.copy + " Copy image</button>" +
          '<button class="wv-sh-btn" data-a="save">' + ICON.download + " Save image</button>" +
        "</div></div>";
    document.body.appendChild(veil);

    // a launch from before cards existed has no image; say so rather than
    // leaving a broken-image icon in the middle of the modal
    var img = veil.querySelector(".wv-sh-card");
    img.addEventListener("error", function () {
      var ph = document.createElement("div");
      ph.className = "wv-sh-card miss";
      ph.textContent = "No share card for this launch yet";
      img.replaceWith(ph);
    });

    function close() { veil.remove(); document.removeEventListener("keydown", onKey); }
    function onKey(e) { if (e.key === "Escape") close(); }
    document.addEventListener("keydown", onKey);
    veil.addEventListener("click", function (e) { if (e.target === veil) close(); });
    veil.querySelector(".wv-sh-x").addEventListener("click", close);

    function go(u) { window.open(u, "_blank", "noopener"); }
    function flash(btn, txt) {
      var was = btn.innerHTML;
      btn.textContent = txt;
      setTimeout(function () { btn.innerHTML = was; }, 1300);
    }

    veil.addEventListener("click", async function (e) {
      var b = e.target.closest("[data-a]");
      if (!b) return;
      var a = b.getAttribute("data-a");
      if (a === "x") {
        go("https://twitter.com/intent/tweet?text=" + encodeURIComponent(text) +
           "&url=" + encodeURIComponent(url));
      } else if (a === "tg") {
        go("https://t.me/share/url?url=" + encodeURIComponent(url) +
           "&text=" + encodeURIComponent(text));
      } else if (a === "link") {
        try { await navigator.clipboard.writeText(url); flash(b, "Copied ✓"); }
        catch (err) { flash(b, "Copy failed"); }
      } else if (a === "img") {
        try {
          var blob = await fetch(card).then(function (r) { return r.blob(); });
          await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
          flash(b, "Copied ✓");
        } catch (err) { flash(b, "Copy failed"); }
      } else if (a === "save") {
        try {
          var bl = await fetch(card).then(function (r) { return r.blob(); });
          var link = document.createElement("a");
          link.href = URL.createObjectURL(bl);
          link.download = String(o.name || "launch")
            .replace(/[^a-z0-9]+/gi, "-").toLowerCase() + "-waves.png";
          link.click();
          setTimeout(function () { URL.revokeObjectURL(link.href); }, 4000);
          flash(b, "Saved ✓");
        } catch (err) { flash(b, "Save failed"); }
      }
    });
  }

  window.WavesShare = { open: open, shareUrl: shareUrl, cardUrl: cardUrl };
})();
