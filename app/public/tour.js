/* First-run walkthrough.
   Every step names a real control and rings it on the page, so the tour teaches
   the interface rather than a diagram of it. Steps whose target is missing fall
   back to a centered card, which is what happens on a narrow layout where the
   right rail collapses. */
(function () {
  "use strict";

  var KEY = window.BRAND.key("tour.v1");   // bumped after removing the AI step so the tour reflects the current flow

  var STEPS = [
    {
      title: "Draw it here, mint it from here",
      body: "This is the editor — a collection goes from nothing to minted without " +
            "leaving the page. Four steps, left to right: name, draw, rarity, generate.",
      target: null
    },
    {
      title: "Start from a template",
      body: "Ready-made collections, one click to load. It becomes <b>your</b> project — " +
            "recolour, redraw, rename anything. A starting position, not a locked skin.",
      target: "#usetemplate", side: "right"
    },
    {
      title: "Categories stack back to front",
      body: "First category is furthest back — Background first, Hat last. Drag to " +
            "reorder. Each holds <b>traits</b>; one lands on every token.",
      target: "#cats", side: "right"
    },
    {
      title: "Click a swatch to draw it",
      body: "<b>Pixel</b> snaps to a grid (16–96); <b>Brush</b> is freehand with six " +
            "presets and pressure. Pick your grid size early — changing it reloads the trait.",
      target: ".modebar", side: "bottom"
    },
    {
      title: "The usual tools, plus Guide",
      body: "<b>Guide</b> ghosts the other categories behind your drawing, so a hat lines " +
            "up with the head it sits on. <b>Paint layers</b> stack passes inside one trait.",
      target: ".tools", side: "top"
    },
    {
      title: "Rarity is a weight, not a percent",
      body: "A trait at 20 rolls twice as often as one at 10. Nothing has to add to 100 — " +
            "add a trait and the rest rebalance.",
      target: "#cats", side: "right"
    },
    {
      title: "Colors are drawings, not filters",
      body: "Each entry in a trait's <b>Colors</b> list is its own drawing with its own " +
            "rarity — so a color can hold a gradient or a pattern. Adding one copies the last.",
      target: "#cats", side: "right"
    },
    {
      title: "Bring in art you already have",
      body: "<b>Import</b> loads PNGs as traits or colors, honoring <code>Name#weight.png</code>. " +
            "<b>Trace reference</b> puts an image under the canvas; it is never exported.",
      target: "#cats", side: "right"
    },
    {
      title: "Rules stop bad combinations",
      body: "A hood over long hair, glasses under a helmet — matches are re-rolled. " +
            "End a value with <b>*</b> to match every colorway it grows.",
      target: "#rulesfold", side: "left", open: "details"
    },
    {
      title: "Save the project, not just the output",
      body: "<b>Save project</b> is one <code>" + window.BRAND.fileExt + "</code> with everything in it, " +
            "art included. Nothing is kept for you on a server.",
      target: ".savebtns", side: "left"
    },
    {
      title: "Generate, then launch",
      body: "Set a supply, hit <b>Generate</b>: images, metadata, a rarity report and a " +
            "contact sheet. The combination count tells you if the supply is possible first.",
      target: ".pinned", side: "left"
    }
  ];

  var el = {}, at = 0;

  function build() {
    var wrap = document.createElement("div");
    wrap.className = "tour";
    wrap.hidden = true;
    wrap.innerHTML =
      '<div class="tour-veil"></div>' +
      '<div class="tour-ring" hidden></div>' +
      '<div class="tour-card" role="dialog" aria-modal="true" aria-labelledby="tourTitle">' +
        '<div class="tour-step"><span id="tourNum"></span> of ' + STEPS.length + '</div>' +
        '<h2 id="tourTitle"></h2>' +
        '<p id="tourBody"></p>' +
        '<div class="tour-dots" id="tourDots"></div>' +
        '<div class="tour-nav">' +
          '<button id="tourSkip" class="ghost">Skip</button>' +
          '<span class="tour-gap"></span>' +
          '<button id="tourBack">Back</button>' +
          '<button id="tourNext" class="primary">Next</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(wrap);

    el.wrap = wrap;
    el.ring = wrap.querySelector(".tour-ring");
    el.veil = wrap.querySelector(".tour-veil");
    el.card = wrap.querySelector(".tour-card");
    el.num = wrap.querySelector("#tourNum");
    el.title = wrap.querySelector("#tourTitle");
    el.body = wrap.querySelector("#tourBody");
    el.dots = wrap.querySelector("#tourDots");

    STEPS.forEach(function (s, i) {
      var d = document.createElement("button");
      d.className = "tour-dot";
      d.title = s.title;
      d.addEventListener("click", function () { go(i); });
      el.dots.appendChild(d);
    });

    wrap.querySelector("#tourSkip").addEventListener("click", close);
    wrap.querySelector("#tourBack").addEventListener("click", function () { go(at - 1); });
    wrap.querySelector("#tourNext").addEventListener("click", function () {
      if (at === STEPS.length - 1) close(); else go(at + 1);
    });
    el.veil.addEventListener("click", close);
    // the ring is pointer-events:none so a click in the dimmed area lands on the
    // wrapper itself; treat that as "outside" too
    wrap.addEventListener("click", function (e) { if (e.target === wrap) close(); });

    document.addEventListener("keydown", function (e) {
      if (el.wrap.hidden) return;
      if (e.key === "Escape") close();
      if (e.key === "ArrowRight") go(at + 1);
      if (e.key === "ArrowLeft") go(at - 1);
    });
    window.addEventListener("resize", function () { if (!el.wrap.hidden) place(); });
  }

  function go(i) {
    if (i < 0 || i >= STEPS.length) return;
    at = i;
    var s = STEPS[i];
    el.num.textContent = i + 1;
    el.title.textContent = s.title;
    el.body.innerHTML = s.body;
    Array.prototype.forEach.call(el.dots.children, function (d, n) {
      d.classList.toggle("on", n === i);
      d.classList.toggle("seen", n < i);
    });
    el.wrap.querySelector("#tourBack").disabled = i === 0;
    el.wrap.querySelector("#tourNext").textContent = i === STEPS.length - 1 ? "Start building" : "Next";
    // a collapsed <details> has no box to ring, so open it before measuring
    if (s.open) {
      var f = document.querySelector(s.target);
      var d = f && f.closest(s.open);
      if (d && !d.open) d.open = true;
    }
    place();
  }

  function place() {
    var s = STEPS[at];
    var t = s.target && document.querySelector(s.target);
    var box = t && t.getBoundingClientRect();

    // Centre by measured coordinates rather than a left:50%/translate class —
    // the card is positioned from JS everywhere else, and mixing the two put it
    // in the wrong corner.
    if (!box || !box.width || !box.height) {
      el.ring.hidden = true;
      el.veil.hidden = false;
      el.card.style.left = Math.round((window.innerWidth - el.card.offsetWidth) / 2) + "px";
      el.card.style.top = Math.round((window.innerHeight - el.card.offsetHeight) / 2) + "px";
      return;
    }
    // The ring dims the page itself, with a huge shadow spreading out from the
    // hole. Leaving the veil up as well would tint the hole too and the
    // highlighted control would be no brighter than the rest of the page.
    el.ring.hidden = false;
    el.veil.hidden = true;
    var pad = 8;
    el.ring.style.left = (box.left - pad) + "px";
    el.ring.style.top = (box.top - pad) + "px";
    el.ring.style.width = (box.width + pad * 2) + "px";
    el.ring.style.height = (box.height + pad * 2) + "px";

    var cw = el.card.offsetWidth, ch = el.card.offsetHeight, gap = 18;
    var x, y;
    if (s.side === "right") { x = box.right + gap; y = box.top; }
    else if (s.side === "left") { x = box.left - cw - gap; y = box.top; }
    else if (s.side === "top") { x = box.left; y = box.top - ch - gap; }
    else { x = box.left; y = box.bottom + gap; }

    // keep the card on screen whichever side it was asked to sit on
    x = Math.max(14, Math.min(x, window.innerWidth - cw - 14));
    y = Math.max(14, Math.min(y, window.innerHeight - ch - 14));
    el.card.style.left = x + "px";
    el.card.style.top = y + "px";
  }

  function open(i) {
    if (!el.wrap) build();
    el.wrap.hidden = false;
    go(i || 0);
  }

  function close() {
    el.wrap.hidden = true;
    try { localStorage.setItem(KEY, "1"); } catch (e) {}
  }

  window.Tour = { open: open };

  document.addEventListener("DOMContentLoaded", function () {
    var btn = document.getElementById("howto");
    if (btn) btn.addEventListener("click", function () { open(0); });
    var seen;
    try { seen = localStorage.getItem(KEY); } catch (e) { seen = "1"; }
    // let the editor finish its own first render before measuring anything
    if (!seen) setTimeout(function () { open(0); }, 400);
  });
})();
