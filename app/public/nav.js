/* Shared nav behaviour for app pages: the static nav markup (identical to the
   homepage) gains the blur + hairline border once you scroll past the top. The
   homepage runs the same toggle from landing.js; this is the app-page copy so
   every route behaves the same. */
(function () {
  "use strict";
  var nav = document.getElementById("nav");
  if (!nav) return;
  function onScroll(){ nav.classList.toggle("scrolled", window.scrollY > 24); }
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();
})();
