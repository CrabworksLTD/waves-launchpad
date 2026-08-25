/* ============================================================
   three.js particle sphere + GSAP choreography
   ============================================================ */
(function(){
  "use strict";
  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------------- three.js: particle moon ---------------- */
  function initMoon(){
    if (typeof THREE === "undefined") return;
    var canvas = document.getElementById("moon-canvas");
    if (!canvas) return;

    var renderer = new THREE.WebGLRenderer({canvas: canvas, alpha: true, antialias: false});
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

    var scene = new THREE.Scene();
    var camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
    camera.position.z = 7.2;

    var group = new THREE.Group();
    scene.add(group);

    /* --- moon point cloud --- */
    var mobile = window.innerWidth < 768;
    var COUNT = mobile ? 3500 : 7000;
    var R = 2.35;
    var positions = new Float32Array(COUNT * 3);
    var colors = new Float32Array(COUNT * 3);
    var phos = new THREE.Color(0x14F195);   /* Solana green */
    var bone = new THREE.Color(0x9945FF);   /* Solana purple */
    var dimc = new THREE.Color(0x2A2140);   /* violet shadow */

    /* deterministic-ish crater centers */
    var craters = [];
    for (var c = 0; c < 9; c++){
      var cv = new THREE.Vector3().setFromSphericalCoords(
        1,
        Math.acos(2 * Math.random() - 1),
        Math.random() * Math.PI * 2
      );
      craters.push({dir: cv, size: 0.18 + Math.random() * 0.28, depth: 0.05 + Math.random() * 0.1});
    }

    var v = new THREE.Vector3();
    for (var i = 0; i < COUNT; i++){
      /* even-ish sphere distribution */
      var theta = Math.acos(2 * Math.random() - 1);
      var phi = Math.random() * Math.PI * 2;
      v.setFromSphericalCoords(1, theta, phi);

      var r = R;
      /* crater dents */
      for (var k = 0; k < craters.length; k++){
        var d = v.distanceTo(craters[k].dir);
        if (d < craters[k].size){
          r -= craters[k].depth * (1 - d / craters[k].size);
        }
      }
      /* fine surface noise */
      r += (Math.random() - 0.5) * 0.045;

      positions[i*3]   = v.x * r;
      positions[i*3+1] = v.y * r;
      positions[i*3+2] = v.z * r;

      /* color: mostly bone, terminator handled per-frame is costly — bake a lit side */
      var lit = Math.max(0, v.x * 0.72 + v.y * 0.28 + v.z * 0.35); /* light from upper-left-front */
      var col = dimc.clone().lerp(bone, Math.pow(lit, 1.35));
      /* phosphor rim near the terminator */
      if (lit > 0.02 && lit < 0.22) col.lerp(phos, 0.55 * (1 - Math.abs(lit - 0.12) / 0.1));
      /* occasional phosphor speck */
      if (Math.random() < 0.012) col.copy(phos);
      colors[i*3]   = col.r;
      colors[i*3+1] = col.g;
      colors[i*3+2] = col.b;
    }

    var geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));

    var mat = new THREE.PointsMaterial({
      size: 0.022,
      vertexColors: true,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    });
    var moon = new THREE.Points(geo, mat);
    group.add(moon);

    /* --- orbit ring of drifting dust --- */
    var DUST = 900;
    var dpos = new Float32Array(DUST * 3);
    var dcol = new Float32Array(DUST * 3);
    for (var j = 0; j < DUST; j++){
      var ang = Math.random() * Math.PI * 2;
      var rad = R * (1.4 + Math.random() * 2.4);
      var y = (Math.random() - 0.5) * 2.6;
      dpos[j*3]   = Math.cos(ang) * rad;
      dpos[j*3+1] = y;
      dpos[j*3+2] = Math.sin(ang) * rad;
      var dc = Math.random() < 0.12 ? phos : bone;
      var fade = 0.25 + Math.random() * 0.4;
      dcol[j*3] = dc.r * fade; dcol[j*3+1] = dc.g * fade; dcol[j*3+2] = dc.b * fade;
    }
    var dgeo = new THREE.BufferGeometry();
    dgeo.setAttribute("position", new THREE.BufferAttribute(dpos, 3));
    dgeo.setAttribute("color", new THREE.BufferAttribute(dcol, 3));
    var dust = new THREE.Points(dgeo, new THREE.PointsMaterial({
      size: 0.018, vertexColors: true, transparent: true, opacity: 0.6,
      depthWrite: false, blending: THREE.AdditiveBlending
    }));
    group.add(dust);

    /* --- ambient field: fills the page's space so every section shares it.
       Not in `group`, so it does not parallax with the moon; sits behind it. --- */
    var FIELD = mobile ? 800 : 2600;
    var fpos = new Float32Array(FIELD * 3);
    var fcol = new Float32Array(FIELD * 3);
    for (var m = 0; m < FIELD; m++){
      fpos[m*3]   = (Math.random() - 0.5) * 28;
      fpos[m*3+1] = (Math.random() - 0.5) * 36;
      fpos[m*3+2] = -2 - Math.random() * 9;
      var fc = Math.random() < 0.10 ? phos : bone;
      var ff = 0.16 + Math.random() * 0.5;
      fcol[m*3] = fc.r * ff; fcol[m*3+1] = fc.g * ff; fcol[m*3+2] = fc.b * ff;
    }
    var fgeo = new THREE.BufferGeometry();
    fgeo.setAttribute("position", new THREE.BufferAttribute(fpos, 3));
    fgeo.setAttribute("color", new THREE.BufferAttribute(fcol, 3));
    var field = new THREE.Points(fgeo, new THREE.PointsMaterial({
      size: 0.03, vertexColors: true, transparent: true, opacity: 0.5,
      depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true
    }));
    scene.add(field);

    /* --- sizing: the canvas is the whole viewport now --- */
    function resize(){
      var w = window.innerWidth, h = window.innerHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      /* moon sits upper-right in the hero region on wide screens, up-centre on mobile */
      var wide = window.innerWidth > 1024;
      group.position.x = wide ? 1.7 : 0;
      group.position.y = wide ? 0.9 : 1.6;
    }
    resize();
    window.addEventListener("resize", resize);

    /* --- mouse parallax --- */
    var targetRX = 0, targetRY = 0;
    if (!reduceMotion){
      window.addEventListener("pointermove", function(e){
        var nx = (e.clientX / window.innerWidth) - 0.5;
        var ny = (e.clientY / window.innerHeight) - 0.5;
        targetRY = nx * 0.35;
        targetRX = ny * 0.22;
      }, {passive: true});
    }

    /* --- one global scroll progress (0 at top of page, 1 at the bottom) drives
       both the moon receding out of the hero and the field thinning to a dim
       scatter, so the space reads as continuous top to bottom. --- */
    var pageScroll = {p: 0};
    if (window.gsap && window.ScrollTrigger && !reduceMotion){
      gsap.to(pageScroll, {
        p: 1, ease: "none",
        scrollTrigger: {trigger: document.body, start: "top top", end: "bottom bottom", scrub: 0.5}
      });
    }

    var clock = new THREE.Clock();
    var visible = !document.hidden;
    document.addEventListener("visibilitychange", function(){ visible = !document.hidden; });

    function tick(){
      requestAnimationFrame(tick);
      if (!visible) return;
      var t = clock.getElapsedTime();
      moon.rotation.y = t * (reduceMotion ? 0 : 0.06);
      dust.rotation.y = -t * (reduceMotion ? 0 : 0.02);
      group.rotation.y += (targetRY - group.rotation.y) * 0.04;
      group.rotation.x += (targetRX - group.rotation.x) * 0.04;

      var p = pageScroll.p;
      var heroP = Math.min(1, p / 0.28);            /* moon recedes over the first stretch */
      group.position.z = -heroP * 2.6;
      mat.opacity = 0.95 * (1 - heroP * 0.82);
      dust.material.opacity = 0.6 * (1 - heroP * 0.7);
      /* field: dense in the hero, dim scatter below */
      field.material.opacity = 0.5 - p * 0.42;
      if (!reduceMotion){
        field.rotation.y = t * 0.006;
        field.position.y = Math.sin(t * 0.05) * 0.3;
      }
      renderer.render(scene, camera);
    }
    tick();

    /* hero entrance for the moon itself */
    if (window.gsap && !reduceMotion){
      gsap.from(group.scale, {x: 0.7, y: 0.7, z: 0.7, duration: 2.2, ease: "power3.out", delay: 0.15});
      gsap.from(mat, {opacity: 0, duration: 1.6, ease: "power2.out", delay: 0.1});
    }
  }

  /* ---------------- moonbaby grid: the real art ---------------- */
  /* Written by tools/refresh-grid.js from whatever it picked, between the
     markers below — a screen reader should hear the picture that is actually
     there, and nine images all called "Moonbaby N" describe nothing. Do not
     edit by hand; the next refresh overwrites it. */
  /* GRID-ALT-START */
  var BABY_ALT = [
    "A Moonbaby in a black hoodie with an exposed brain",
    "A Moonbaby in an OG moonsuit",
    "A Moonbaby in a white hoodie with a beanie",
    "A Moonbaby in a purple smiley tee with a bucket hat",
    "A Moonbaby in a pink hoodie with a DUST cap",
    "A Moonbaby in a black smiley tee with an alien cap",
    "A Moonbaby in a lime Robinhood moonsuit with a Roaring Kitty headband",
    "A Moonbaby in a white smiley tee",
    "A Moonbaby in an orange hoodie with a backwards cap"
  ];
  /* GRID-ALT-END */

  function initBabies(){
    var grid = document.getElementById("babies-grid");
    if (!grid) return;
    for (var n = 1; n <= 9; n++){
      var cell = document.createElement("div");
      cell.className = "baby will-reveal";
      var img = document.createElement("img");
      img.src = "/art/g" + n + ".png";
      img.alt = BABY_ALT[n - 1] || "A Moonbaby";
      img.loading = "lazy";
      cell.appendChild(img);
      grid.appendChild(cell);
    }
  }

  /* ---------------- GSAP choreography ---------------- */
  function initGsap(){
    if (!window.gsap){ document.body.classList.add("no-js"); return; }
    gsap.registerPlugin(ScrollTrigger);

    var nav = document.getElementById("nav");
    window.addEventListener("scroll", function(){
      nav.classList.toggle("scrolled", window.scrollY > 24);
    }, {passive: true});

    if (reduceMotion){
      gsap.set(".will-reveal", {opacity: 1});
      gsap.set("[data-hero='line']", {yPercent: 0, opacity: 1});
      return;
    }

    /* --- hero load sequence --- */
    gsap.set("[data-hero='line']", {yPercent: 110});
    var tl = gsap.timeline({defaults: {ease: "power3.out"}});
    tl.from(".nav-inner", {y: -20, opacity: 0, duration: 0.8}, 0.1)
      .to("[data-hero='eyebrow']", {opacity: 1, duration: 0.7}, 0.25)
      .to("[data-hero='line']", {yPercent: 0, duration: 1.1, stagger: 0.12}, 0.35)
      .to("[data-hero='lede']", {opacity: 1, duration: 0.9}, 0.95)
      .to("[data-hero='actions']", {opacity: 1, duration: 0.9}, 1.1)
      .from(".hero-ticker", {opacity: 0, duration: 1.2}, 1.2);

    /* --- headlines and eyebrows carry their own reveal, so lift them out of
       the plain fade and give them the hero's confidence. --- */
    gsap.set(".section .eyebrow.will-reveal, .section h2.h-lg.will-reveal", {opacity: 1});

    /* split a headline into its visual lines and wrap each in an overflow-clipped
       strip, so a line can ride up from nothing — the hero's move, applied down
       the page. Measured after fonts load so the wrap points are the real ones. */
    function splitLines(el){
      var text = el.textContent.replace(/\s+/g, " ").trim();
      var words = text.split(" ");
      el.textContent = "";
      var spans = words.map(function(w, i){
        var s = document.createElement("span");
        s.style.display = "inline-block";
        s.textContent = w;
        el.appendChild(s);
        if (i < words.length - 1) el.appendChild(document.createTextNode(" "));
        return s;
      });
      var lines = [], cur = [], top = null;
      spans.forEach(function(s){
        var t = s.offsetTop;
        if (top === null || Math.abs(t - top) < 6) cur.push(s);
        else { lines.push(cur); cur = [s]; }
        top = t;
      });
      if (cur.length) lines.push(cur);
      el.textContent = "";
      return lines.map(function(group){
        var mask = document.createElement("span"); mask.className = "ln-mask";
        var inner = document.createElement("span"); inner.className = "ln-inner";
        inner.textContent = group.map(function(s){ return s.textContent; }).join(" ");
        mask.appendChild(inner); el.appendChild(mask);
        return inner;
      });
    }

    function wireHeadlines(){
      gsap.utils.toArray(".section h2.h-lg").forEach(function(h){
        var inners = splitLines(h);
        gsap.set(inners, {yPercent: 110});
        gsap.to(inners, {
          yPercent: 0, duration: 0.85, ease: "power3.out", stagger: 0.11,
          scrollTrigger: {trigger: h, start: "top 84%", once: true}
        });
      });
      ScrollTrigger.refresh();
    }
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(wireHeadlines);
    else wireHeadlines();

    /* --- eyebrows type in like a terminal line --- */
    gsap.utils.toArray(".section .eyebrow").forEach(function(eb){
      var full = eb.textContent;
      eb.textContent = "";
      var st = {n: 0};
      gsap.to(st, {
        n: full.length, ease: "none", duration: Math.min(1.1, 0.22 + full.length * 0.04),
        scrollTrigger: {trigger: eb, start: "top 90%", once: true},
        onStart: function(){ eb.classList.add("typing"); },
        onUpdate: function(){ eb.textContent = full.slice(0, Math.ceil(st.n)); },
        onComplete: function(){ eb.textContent = full; eb.classList.remove("typing"); }
      });
    });

    /* --- everything else: a short, quiet lift along the reading path --- */
    gsap.utils.toArray(".section").forEach(function(section){
      var items = section.querySelectorAll(".will-reveal:not(.eyebrow):not(.h-lg)");
      if (!items.length) return;
      gsap.fromTo(items,
        {opacity: 0, y: 16},
        {
          opacity: 1, y: 0, duration: 0.7, ease: "power2.out", stagger: 0.08,
          scrollTrigger: {trigger: section, start: "top 78%", once: true}
        }
      );
    });

    /* --- steps: staggered column reveal, short travel --- */
    gsap.from("#steps .step", {
      opacity: 0, y: 14, duration: 0.5, ease: "power2.out", stagger: 0.1,
      scrollTrigger: {trigger: "#steps", start: "top 82%", once: true}
    });

    /* --- moonbabies counter --- */
    var counter = {val: 0};
    var countEl = document.getElementById("baby-count");
    gsap.to(counter, {
      val: 999, duration: 2, ease: "power2.out",
      scrollTrigger: {trigger: "#moonbabies", start: "top 70%", once: true},
      onUpdate: function(){
        countEl.textContent = Math.floor(counter.val).toLocaleString("en-US");
      }
    });

  }

  /* ---------------- deploy-flow diagram ---------------- */
  function initPairFlow(){
    var pf = document.getElementById("pairFlow");
    if (!pf) return;
    var labs   = [].slice.call(pf.querySelectorAll(".dg-lab"));
    var nodes  = [].slice.call(pf.querySelectorAll(".pf-node"));
    var glowln = [].slice.call(pf.querySelectorAll(".pf-glowline"));
    var beams  = [].slice.call(pf.querySelectorAll(".pf-beam"));
    var waves  = [].slice.call(pf.querySelectorAll(".pf-wave"));
    var parts  = [].slice.call(pf.querySelectorAll(".pf-particle"));
    var wave   = document.getElementById("pfWave");
    var glow   = document.getElementById("pf-glow");
    var onring = document.getElementById("pf-onring");

    /* no-JS / reduced motion: static gradient beams, gentle static glow, no wave */
    if (!window.gsap || reduceMotion){
      labs.forEach(function(e){ e.style.opacity = 1; });
      nodes.forEach(function(e){ e.style.opacity = 1; });
      glowln.forEach(function(e){ e.style.opacity = ""; });
      waves.forEach(function(w){ w.style.opacity = 0; });
      if (glow) glow.setAttribute("opacity", "0.28");
      return;
    }
    document.documentElement.classList.add("js-anim");

    /* prep the beams for a top-to-bottom draw-in */
    beams.forEach(function(p){
      var L = p.getTotalLength();
      p.style.strokeDasharray  = L;
      p.style.strokeDashoffset = L;
    });

    function runWave(){
      /* one synchronized luminance wave slides down every beam; the gradient
         repeats every 200px so translating 0->200 loops seamlessly */
      var o = {t: 0};
      gsap.to(o, {
        t: 200, duration: 6, ease: "power1.inOut", repeat: -1,
        onUpdate: function(){
          wave.setAttribute("gradientTransform", "translate(0," + o.t.toFixed(2) + ")");
          /* ON-CHAIN glow swells as a band passes the node (crossing ~t=68) */
          var d = o.t - 68;
          if (d >  100) d -= 200;
          if (d < -100) d += 200;
          var g = Math.exp(-(d * d) / (2 * 36 * 36));
          if (glow)   glow.setAttribute("opacity", (0.16 + 0.5 * g).toFixed(3));
          if (onring) onring.setAttribute("r", (18 + 2.5 * g).toFixed(2));
        }
      });
      /* faint particle drift around the destination only */
      parts.forEach(function(pt, i){
        var dx = ((i % 3) - 1) * 5 + (i % 2 ? 3 : -3);
        var dy = ((i % 4) - 1.5) * 6;
        gsap.to(pt, {x: dx, y: dy, duration: 3 + (i % 3), ease: "sine.inOut", repeat: -1, yoyo: true, delay: i * 0.2});
        gsap.to(pt, {opacity: 0.12 + (i % 3) * 0.1, duration: 2 + (i % 2), ease: "sine.inOut", repeat: -1, yoyo: true, delay: i * 0.3});
      });
    }
    function start(){
      gsap.timeline()
        .to(beams,  {strokeDashoffset: 0, duration: 0.8, ease: "power2.inOut", stagger: 0.1})   /* pour in, top to bottom */
        .to(glowln, {opacity: 0.22, duration: 0.6, ease: "power2.out"}, "-=0.5")
        .to(nodes,  {opacity: 1, duration: 0.4, ease: "power2.out", stagger: 0.06}, "-=0.45")
        .to(labs,   {opacity: 1, duration: 0.4, ease: "power2.out", stagger: 0.08}, "-=0.3")
        .to(waves,  {opacity: 0.95, duration: 0.5}, "-=0.15")
        .add(runWave);                                                                            /* then the flow begins */
    }
    if (window.ScrollTrigger) ScrollTrigger.create({trigger: pf, start: "top 82%", once: true, onEnter: start});
    else start();
  }

  /* ---------------- $MOON tier selector ---------------- */
  function initMoonTiers(){
    var wrap = document.getElementById("moonTiers");
    var burn = document.getElementById("mlBurn");
    var share = document.getElementById("mlShare");
    if (!wrap || !burn || !share) return;
    var spans = [].slice.call(wrap.querySelectorAll("span"));
    function pick(span){
      spans.forEach(function(s){
        var on = s === span;
        s.classList.toggle("on", on);
        s.setAttribute("aria-selected", on ? "true" : "false");
      });
      /* flat ladder: burn and share both scale with the multiplier, and stay
         equal — that equality is the whole point ("twice the burn is twice the
         share"), so both bars move to the same width together. */
      var m = parseFloat(span.getAttribute("data-m")) || 1;
      var to = Math.max(9, m / 10 * 100) + "%";
      if (window.gsap && !reduceMotion) gsap.to([burn, share], {width: to, duration: 0.5, ease: "power2.out"});
      else { burn.style.width = to; share.style.width = to; }
      /* bigger burn, bigger presence on the ring */
      var trav = document.getElementById("mlTrav");
      if (trav) trav.setAttribute("r", (3 + m / 10 * 3).toFixed(1));
    }
    spans.forEach(function(s){ s.addEventListener("click", function(){ pick(s); }); });
    pick(wrap.querySelector("span.on") || spans[spans.length - 1]);
  }

  /* ---------------- $MOON cycle ring ---------------- */
  function initRing(){
    var ring = document.getElementById("mlRing");
    var trav = document.getElementById("mlTrav");
    var path = document.getElementById("mlRingPath");
    if (!ring || !trav || !path) return;
    var dots = [].slice.call(ring.querySelectorAll(".ml-dot"));
    var labs = [].slice.call(ring.querySelectorAll(".ml-lab"));
    var cx = 280, cy = 280, r = 130;
    function place(a){ trav.setAttribute("cx", cx + r * Math.sin(a)); trav.setAttribute("cy", cy - r * Math.cos(a)); }
    place(0);

    if (!window.gsap || reduceMotion){ return; }   /* static ring, no traveller */
    document.documentElement.classList.add("js-anim");

    function traveller(){
      var prox = {a: 0}, last = -1;
      gsap.to(prox, {
        a: Math.PI * 2, duration: 11, ease: "none", repeat: -1,
        onUpdate: function(){
          var a = prox.a % (Math.PI * 2);
          place(a);
          var idx = Math.round(a / (Math.PI / 2)) % 4;   /* nearest node */
          if (idx !== last){
            last = idx;
            if (dots[idx]) gsap.fromTo(dots[idx], {attr: {r: 5}}, {attr: {r: 8}, duration: 0.22, yoyo: true, repeat: 1, ease: "power1.out"});
            labs.forEach(function(l, i){ l.classList.toggle("hot", i === idx); });
          }
        }
      });
    }

    function start(){
      var tl = gsap.timeline();
      tl.to(path, {strokeDashoffset: 0, duration: 0.9, ease: "power2.inOut"})
        .to([".ml-hub", ".ml-hub-t", ".ml-ring-close"], {opacity: 1, duration: 0.5}, "-=0.35");
      dots.forEach(function(d, i){ tl.to([d, labs[i]], {opacity: 1, duration: 0.32, ease: "power2.out"}, "-=0.14"); });
      tl.set(trav, {opacity: 1}).add(traveller);
    }

    if (window.ScrollTrigger) ScrollTrigger.create({trigger: ring, start: "top 80%", once: true, onEnter: start});
    else start();
  }

  /* ---------------- FAQ accordion ---------------- */
  function initFaq(){
    var accs = [].slice.call(document.querySelectorAll(".acc"));
    if (!accs.length) return;
    function setA(a, h){ if (window.gsap && !reduceMotion) gsap.to(a, {height: h, duration: h ? 0.32 : 0.28, ease: "power2.out"}); else a.style.height = (h || 0) + (h ? "" : "px"); }
    function close(acc){
      acc.classList.remove("open");
      acc.querySelector(".acc-q").setAttribute("aria-expanded", "false");
      var a = acc.querySelector(".acc-a");
      if (window.gsap && !reduceMotion) gsap.to(a, {height: 0, duration: 0.28, ease: "power2.inOut"}); else a.style.height = "0px";
    }
    function open(acc){
      accs.forEach(function(o){ if (o !== acc && o.classList.contains("open")) close(o); });   /* one at a time */
      acc.classList.add("open");
      acc.querySelector(".acc-q").setAttribute("aria-expanded", "true");
      var a = acc.querySelector(".acc-a");
      if (window.gsap && !reduceMotion) gsap.to(a, {height: "auto", duration: 0.32, ease: "power2.out"}); else a.style.height = "auto";
    }
    accs.forEach(function(acc){
      acc.querySelector(".acc-q").addEventListener("click", function(){
        acc.classList.contains("open") ? close(acc) : open(acc);
      });
    });
    /* #faq deep-link: browser scrolls to the section; open the first question */
    if (location.hash === "#faq") open(accs[0]);
  }

  /* ---------------- mobile nav ---------------- */
  function initNav(){
    var burger = document.getElementById("navBurger");
    var overlay = document.getElementById("navOverlay");
    if (!burger || !overlay) return;
    var links = overlay.querySelectorAll("a");
    var open = false;
    function set(o){
      open = o;
      burger.classList.toggle("open", o);
      burger.setAttribute("aria-expanded", o ? "true" : "false");
      burger.setAttribute("aria-label", o ? "Close menu" : "Open menu");
      overlay.hidden = !o;
      overlay.setAttribute("aria-hidden", o ? "false" : "true");
      document.body.style.overflow = o ? "hidden" : "";
      if (o && window.gsap && !reduceMotion){
        gsap.fromTo(links, {opacity: 0, y: 14},
          {opacity: 1, y: 0, duration: 0.4, ease: "power2.out", stagger: 0.05});
      }
    }
    burger.addEventListener("click", function(){ set(!open); });
    links.forEach(function(a){ a.addEventListener("click", function(){ set(false); }); });
    window.addEventListener("keydown", function(e){ if (e.key === "Escape" && open) set(false); });
  }

  /* ---------------- boot ---------------- */
  if (document.readyState === "loading"){
    document.addEventListener("DOMContentLoaded", boot);
  } else { boot(); }
  function boot(){
    initBabies();   /* create sprite cells first so reveal triggers pick them up */
    initNav();
    initMoonTiers();
    initRing();
    initPairFlow();
    initFaq();
    initGsap();
    initMoon();
  }
})();
