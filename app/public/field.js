/* ============================================================
   Shared background particle field
   ------------------------------------------------------------
   The homepage hero owns the moon; every other page reuses just the ambient
   field, at the low "below the fold" density, so the whole site sits in one
   space. Seeded deterministically: the particles land in the same places on
   every page, so a cross-document View Transition has nothing to jump.

   Mount: a page needs <canvas id="field-canvas"></canvas> and to load three.js
   + this file. Nothing else. The canvas carries a view-transition-name so the
   field is treated as one persistent surface across navigations, not crossfaded.
   ============================================================ */
(function () {
  "use strict";
  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function boot() {
    if (typeof THREE === "undefined") return;
    var canvas = document.getElementById("field-canvas");
    if (!canvas) return;

    var renderer = new THREE.WebGLRenderer({ canvas: canvas, alpha: true, antialias: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    var scene = new THREE.Scene();
    var camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
    camera.position.z = 7;

    /* deterministic PRNG (mulberry32) — same seed, same field, every page */
    var seed = 0x9e3779b9;
    function rnd() {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      var t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    }

    var mobile = window.innerWidth < 768;
    var N = mobile ? 520 : 1100;      /* low density — the sparse, below-fold look */
    var pos = new Float32Array(N * 3);
    var col = new Float32Array(N * 3);
    var phos = new THREE.Color(0xC9F53F), bone = new THREE.Color(0xE9ECE4);
    for (var i = 0; i < N; i++) {
      pos[i*3]   = (rnd() - 0.5) * 30;
      pos[i*3+1] = (rnd() - 0.5) * 22;
      pos[i*3+2] = -2 - rnd() * 9;
      var c = rnd() < 0.10 ? phos : bone;
      var f = 0.14 + rnd() * 0.4;
      col[i*3] = c.r * f; col[i*3+1] = c.g * f; col[i*3+2] = c.b * f;
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
    var field = new THREE.Points(geo, new THREE.PointsMaterial({
      size: 0.03, vertexColors: true, transparent: true, opacity: 0.34,
      depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true
    }));
    scene.add(field);

    function resize() {
      var w = window.innerWidth, h = window.innerHeight;
      renderer.setSize(w, h, false);
      camera.aspect = w / h; camera.updateProjectionMatrix();
    }
    resize();
    window.addEventListener("resize", resize);

    var visible = !document.hidden;
    document.addEventListener("visibilitychange", function () { visible = !document.hidden; });
    var clock = new THREE.Clock();
    (function tick() {
      requestAnimationFrame(tick);
      if (!visible) return;
      if (!reduce) {
        var t = clock.getElapsedTime();
        field.rotation.y = t * 0.006;
        field.position.y = Math.sin(t * 0.05) * 0.25;
      }
      renderer.render(scene, camera);
    })();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
