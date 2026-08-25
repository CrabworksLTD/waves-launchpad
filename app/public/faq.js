/* Shared FAQ accordion — hairline items, [+]→x marker, GSAP height tween, one
   open at a time. Used by /faq. Deep-linkable: #<acc-id> opens that question,
   #<group-id> scrolls to the group. */
(function () {
  "use strict";
  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  function boot() {
    var accs = [].slice.call(document.querySelectorAll(".acc"));
    if (!accs.length) return;
    function close(acc) {
      acc.classList.remove("open");
      acc.querySelector(".acc-q").setAttribute("aria-expanded", "false");
      var a = acc.querySelector(".acc-a");
      if (window.gsap && !reduce) gsap.to(a, { height: 0, duration: 0.28, ease: "power2.inOut" });
      else a.style.height = "0px";
    }
    function open(acc) {
      accs.forEach(function (o) { if (o !== acc && o.classList.contains("open")) close(o); });
      acc.classList.add("open");
      acc.querySelector(".acc-q").setAttribute("aria-expanded", "true");
      var a = acc.querySelector(".acc-a");
      if (window.gsap && !reduce) gsap.to(a, { height: "auto", duration: 0.32, ease: "power2.out" });
      else a.style.height = "auto";
    }
    accs.forEach(function (acc) {
      acc.querySelector(".acc-q").addEventListener("click", function () {
        acc.classList.contains("open") ? close(acc) : open(acc);
      });
    });
    /* deep-link */
    var h = location.hash.slice(1);
    if (h) {
      var el = document.getElementById(h);
      if (el && el.classList.contains("acc")) { open(el); el.scrollIntoView({ block: "center" }); }
      else if (el) el.scrollIntoView();
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
