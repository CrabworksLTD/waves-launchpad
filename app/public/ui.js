(function () {
  "use strict";
  /* A very small view layer. Not a framework — the editor is imperative canvas
   * code and stays that way. This exists because the site surfaces were being
   * built by concatenating strings, which is both unreadable and a standing
   * XSS hazard: every interpolation needed a manual esc() call and the one you
   * forget is the one that matters.
   *
   *   html`<a href="${url}">${name}</a>`
   *
   * Interpolations are escaped by default. To insert markup you have already
   * built, wrap it in raw() — which makes "this is deliberately unescaped"
   * something you can grep for.
   */

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // Marker object so html`` knows a value is already-safe markup.
  function Raw(s) { this.s = s; }
  function raw(s) { return new Raw(s); }

  function html(strings) {
    var out = strings[0];
    for (var i = 1; i < arguments.length; i++) {
      var v = arguments[i];
      if (v instanceof Raw) out += v.s;
      else if (Array.isArray(v)) out += v.map(function (x) {
        return x instanceof Raw ? x.s : esc(x);
      }).join("");
      else if (v == null || v === false) out += "";
      else out += esc(v);
      out += strings[i];
    }
    return new Raw(out);
  }

  function render(target, node) {
    var el = typeof target === "string" ? document.querySelector(target) : target;
    if (!el) return null;
    el.innerHTML = node instanceof Raw ? node.s : String(node);
    return el;
  }

  /* Delegated events. Bound once on a container rather than per element, so
   * re-rendering a list does not orphan handlers or leak them — the usual way
   * a hand-rolled UI starts eating memory on a page that refreshes a grid. */
  function on(target, type, selector, fn) {
    var el = typeof target === "string" ? document.querySelector(target) : target;
    if (!el) return;
    el.addEventListener(type, function (e) {
      var hit = e.target.closest(selector);
      if (hit && el.contains(hit)) fn(e, hit);
    });
  }

  function fmt(n, dp) {
    if (n == null || isNaN(n)) return "—";
    return Number(n).toLocaleString(undefined, {
      minimumFractionDigits: dp || 0, maximumFractionDigits: dp == null ? 0 : dp
    });
  }

  // Addresses are shown truncated everywhere, and always with enough of both
  // ends to be checkable against a wallet or an explorer.
  function shortAddr(a, n) {
    a = String(a || "");
    n = n || 4;
    return a.length > n * 2 + 2 ? a.slice(0, n) + "…" + a.slice(-n) : a;
  }

  window.UI = {
    html: html, raw: raw, esc: esc, render: render, on: on,
    fmt: fmt, shortAddr: shortAddr
  };
})();
