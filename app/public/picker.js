"use strict";
// Color picker: spectrum, grayscale ramp, saturation and lightness, hex entry,
// and recents. Emits a hex string; it holds no opinion about what paints with it.
//
// The grayscale ramp exists because outlines, whites and neutrals are most of
// what gets used, and reaching them on a hue-first control means two moves.

const Picker = (function () {

  function hsl2hex(h, s, l) {
    s /= 100; l /= 100;
    const k = function (n) { return (n + h / 30) % 12; };
    const a = s * Math.min(l, 1 - l);
    const f = function (n) {
      return l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    };
    const to = function (v) {
      const x = Math.round(v * 255).toString(16);
      return x.length < 2 ? "0" + x : x;
    };
    return "#" + to(f(0)) + to(f(8)) + to(f(4));
  }

  function hex2hsl(hex) {
    const r = parseInt(hex.slice(1, 3), 16) / 255,
          g = parseInt(hex.slice(3, 5), 16) / 255,
          b = parseInt(hex.slice(5, 7), 16) / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    let h = 0;
    if (d) {
      if (mx === r) h = ((g - b) / d) % 6;
      else if (mx === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60; if (h < 0) h += 360;
    }
    const l = (mx + mn) / 2;
    const s = d ? d / (1 - Math.abs(2 * l - 1)) : 0;
    return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
  }

  // The spectrum is a fixed field, not a view of the current colour. It used to
  // paint at state.s, so selecting a dark grey turned the whole palette grey and
  // there was no colour left in it to pick — the one moment you most want the
  // palette is the moment it stopped offering anything.
  const PALETTE_S = 50;

  function create(host, opts) {
    opts = opts || {};
    const state = { h: 18, s: PALETTE_S, l: 55, recent: [], onChange: opts.onChange || function () {} };

    host.innerHTML =
      '<canvas class="pk-spectrum" width="240" height="92"></canvas>' +
      '<div class="pk-row"><label>Gray</label><input type="range" class="pk-ramp pk-k" min="0" max="100" value="55"><output class="pk-kv">55</output></div>' +
      '<div class="pk-row"><label>Sat</label><input type="range" class="pk-s" min="0" max="100" value="100"><output class="pk-sv">100</output></div>' +
      '<div class="pk-row"><label>Light</label><input type="range" class="pk-l" min="0" max="100" value="55"><output class="pk-lv">55</output></div>' +
      '<div class="pk-row"><span class="pk-chip"></span>' +
        '<input class="pk-hex" spellcheck="false" maxlength="7" value="#ff5c1a"></div>' +
      '<div class="pk-lbl">Recent</div><div class="pk-recent"></div>';

    const $ = function (sel) { return host.querySelector(sel); };
    const spectrum = $(".pk-spectrum");
    const sctx = spectrum.getContext("2d");

    function paintSpectrum() {
      const w = spectrum.width, hh = spectrum.height;
      for (let x = 0; x < w; x++) {
        const hue = x / w * 360;
        const g = sctx.createLinearGradient(0, 0, 0, hh);
        g.addColorStop(0, hsl2hex(hue, PALETTE_S, 92));
        g.addColorStop(0.5, hsl2hex(hue, PALETTE_S, 50));
        g.addColorStop(1, hsl2hex(hue, PALETTE_S, 8));
        sctx.fillStyle = g;
        sctx.fillRect(x, 0, 1, hh);
      }
      // marker showing where the current color sits
      const mx = state.h / 360 * w;
      const my = Math.max(4, Math.min(hh - 4, (92 - state.l) / 84 * hh));
      sctx.lineWidth = 2;
      sctx.strokeStyle = "rgba(0,0,0,.85)";
      sctx.beginPath(); sctx.arc(mx, my, 6, 0, Math.PI * 2); sctx.stroke();
      sctx.strokeStyle = "rgba(255,255,255,.95)";
      sctx.beginPath(); sctx.arc(mx, my, 4.5, 0, Math.PI * 2); sctx.stroke();
    }

    function paintRecent() {
      const r = $(".pk-recent");
      r.innerHTML = "";
      state.recent.forEach(function (hex) {
        const b = document.createElement("button");
        b.style.background = hex;
        b.title = hex;
        b.addEventListener("click", function () { set(hex, true); });
        r.appendChild(b);
      });
    }

    // `push` false updates the UI without touching recents — used while dragging.
    // `keepHsl`: the sliders are the source of truth while dragging, so don't
    // re-derive h/s/l from the hex and write it back — that round-trips through
    // 8-bit RGB and quantizes the value being dragged (saturation snaps to 0 near
    // white/black, lightness jumps). A slider drag applies its colour without
    // disturbing its own h/s/l state or any slider position.
    function set(hex, push, keepHsl) {
      hex = String(hex || "").toLowerCase();
      if (!/^#[0-9a-f]{6}$/.test(hex)) return;
      if (!keepHsl) {
        const v = hex2hsl(hex);
        state.h = v.h; state.s = v.s; state.l = v.l;
        $(".pk-k").value = v.l; $(".pk-kv").textContent = v.l;
        $(".pk-s").value = v.s; $(".pk-sv").textContent = v.s;
        $(".pk-l").value = v.l; $(".pk-lv").textContent = v.l;
      }
      $(".pk-hex").value = hex;
      $(".pk-chip").style.background = hex;
      if (push) {
        state.recent = [hex].concat(state.recent.filter(function (x) { return x !== hex; })).slice(0, 16);
        try { localStorage.setItem("nb_recent", JSON.stringify(state.recent)); } catch (e) {}
        paintRecent();
      }
      paintSpectrum();
      state.onChange(hex);
    }

    // grayscale ramp pins saturation to zero
    $(".pk-k").addEventListener("input", function (e) {
      $(".pk-kv").textContent = e.target.value;
      set(hsl2hex(state.h, 0, +e.target.value), false);
    });
    [["s", "sv"], ["l", "lv"]].forEach(function (p) {
      $(".pk-" + p[0]).addEventListener("input", function (e) {
        $(".pk-" + p[1]).textContent = e.target.value;
        state[p[0]] = +e.target.value;
        set(hsl2hex(state.h, state.s, state.l), false, true);
      });
    });
    spectrum.addEventListener("click", function (e) {
      const r = spectrum.getBoundingClientRect();
      const hue = Math.round((e.clientX - r.left) / r.width * 359);
      const y = (e.clientY - r.top) / r.height;
      set(hsl2hex(hue, PALETTE_S, Math.round(92 - y * 84)), true);
    });
    $(".pk-hex").addEventListener("change", function (e) {
      let v = e.target.value.trim();
      if (v.charAt(0) !== "#") v = "#" + v;
      set(v, true);
    });

    try { state.recent = JSON.parse(localStorage.getItem("nb_recent") || "[]"); } catch (e) {}
    paintRecent();
    set(opts.value || "#141414", false);

    return {
      set: function (hex, push) { set(hex, push !== false); },
      value: function () { return $(".pk-hex").value; }
    };
  }

  return { create: create, hsl2hex: hsl2hex, hex2hsl: hex2hsl };
})();

if (typeof module !== "undefined") module.exports = Picker;
