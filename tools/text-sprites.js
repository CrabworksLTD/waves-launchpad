"use strict";
// Renders every string the ad needs into transparent PNGs, once, via Chrome.
//
// The alternative was building the whole video in HTML and screenshotting each
// frame, but that is one Chrome launch per frame — 288 launches for eighteen
// seconds. This way Chrome runs once for the type, and node does the motion with
// full control over easing and compositing.
//
//   node tools/text-sprites.js   ->  /tmp/moonpad-text/*.png  +  index.json
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const OUT = "/tmp/moonpad-text";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// key -> { text, size, weight, color, font, track }
const STRINGS = {
  size:      { t: "48 × 48",              s: 26, c: "#8d9894", f: "mono", k: 6 },
  cats:      { t: "7 CATEGORIES",              s: 30, c: "#e9eeec", f: "mono", k: 6 },
  traits:    { t: "83 TRAITS",                 s: 30, c: "#e9eeec", f: "mono", k: 6 },
  weights:   { t: "WEIGHTS",                   s: 26, c: "#cdfd37", f: "mono", k: 8 },
  rules:     { t: "RULES",                     s: 26, c: "#cdfd37", f: "mono", k: 8 },
  caps:      { t: "CAPS",                      s: 26, c: "#cdfd37", f: "mono", k: 8 },
  combos:    { t: "COMBINATIONS",              s: 24, c: "#8d9894", f: "mono", k: 10 },
  generating:{ t: "GENERATING",                s: 26, c: "#cdfd37", f: "mono", k: 10 },
  tokens:    { t: "TOKENS",                    s: 24, c: "#8d9894", f: "mono", k: 10 },
  out1:      { t: "PNG  ·  METADATA  ·  ZIP", s: 22, c: "#e9eeec", f: "mono", k: 4 },
  out2:      { t: "ERC-721  ·  METAPLEX", s: 22, c: "#8d9894", f: "mono", k: 4 },
  browser:   { t: "RUNS IN YOUR BROWSER",      s: 20, c: "#8d9894", f: "mono", k: 8 },
  wordmark:  { t: "MOONPAD",                   s: 64, c: "#dff59a", f: "px",   k: 2, glow: true },
  url:       { t: "moonpad.online",            s: 26, c: "#cdfd37", f: "mono", k: 4 },
  nothing:   { t: "NOTHING TO INSTALL",        s: 20, c: "#8d9894", f: "mono", k: 8 },

  // showcase captions
  l_open:    { t: "THE WHOLE BUILDER, IN A BROWSER", s: 24, c: "#e9eeec", f: "mono", k: 6 },
  l_cats:    { t: "CATEGORIES  +  TRAITS",       s: 26, c: "#cdfd37", f: "mono", k: 8 },
  l_draw:    { t: "DRAW THEM YOURSELF",          s: 26, c: "#cdfd37", f: "mono", k: 8 },
  l_tools:   { t: "PIXEL OR BRUSH",              s: 26, c: "#cdfd37", f: "mono", k: 8 },
  l_colors:  { t: "EVERY COLOR IS ITS OWN DRAWING", s: 24, c: "#cdfd37", f: "mono", k: 6 },
  l_rules:   { t: "RULES STOP BAD COMBINATIONS", s: 24, c: "#cdfd37", f: "mono", k: 6 },
  l_rarity:  { t: "SET THE RARITY",              s: 26, c: "#cdfd37", f: "mono", k: 8 },
  l_gen:     { t: "GENERATE THE COLLECTION",     s: 26, c: "#cdfd37", f: "mono", k: 8 },
  l_out:     { t: "ART + METADATA, ZIPPED",      s: 26, c: "#cdfd37", f: "mono", k: 8 },
  build:     { t: "BUILD IT  +  SHIP IT",        s: 28, c: "#cdfd37", f: "mono", k: 10 },
  assemble:  { t: "ASSEMBLE",                    s: 28, c: "#cdfd37", f: "mono", k: 22 }
};
for (let d = 0; d <= 9; d++) {
  STRINGS["d" + d] = { t: String(d), s: 46, c: "#cdfd37", f: "mono", k: 0 };
}
STRINGS.comma = { t: ",", s: 46, c: "#cdfd37", f: "mono", k: 0 };

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const items = Object.keys(STRINGS).map(function (key) {
  const s = STRINGS[key];
  // Single quotes inside the family name. This value goes into a style="..."
  // attribute, and a double quote there closes the attribute early — every
  // declaration after it is silently dropped, which is how the wordmark came
  // out as unstyled 16px body text.
  const font = s.f === "px"
    ? "'Press Start 2P', ui-monospace, monospace"
    : "ui-monospace, SFMono-Regular, Menlo, monospace";
  const glow = s.glow
    ? "text-shadow:0 0 6px rgba(205,253,55,.95),0 0 20px rgba(205,253,55,.6),0 0 46px rgba(205,253,55,.35);"
    : "";
  return '<div class="s" id="' + key + '" style="font-family:' + font +
    ";font-size:" + s.s + "px;color:" + s.c + ";letter-spacing:" + (s.k / 10) + "px;" +
    glow + '">' + s.t + "</div>";
});

// Each string on its own transparent row, measured after layout so the crop is
// exact. Padding leaves room for the glow, which extends well past the glyphs.
const html = `<meta charset="utf-8">
<style>
  @import url("https://fonts.googleapis.com/css2?family=Press+Start+2P&display=swap");
  html,body{margin:0;background:transparent}
  .s{display:inline-block;padding:26px 30px;white-space:pre;font-weight:600;
     -webkit-font-smoothing:antialiased;line-height:1.2}
  #wordmark{-webkit-font-smoothing:none;font-smooth:never;font-weight:400}
  body{display:flex;flex-direction:column;align-items:flex-start}
</style>
${items.join("\n")}
<script>
  window.addEventListener("load", function () {
    var out = {};
    document.querySelectorAll(".s").forEach(function (el) {
      var r = el.getBoundingClientRect();
      out[el.id] = { x: Math.round(r.left), y: Math.round(r.top),
                     w: Math.round(r.width), h: Math.round(r.height) };
    });
    var d = document.createElement("div");
    d.id = "BOXES";
    d.textContent = JSON.stringify(out);
    d.style.cssText = "position:absolute;left:-9999px";
    document.body.appendChild(d);
  });
<\/script>`;

fs.writeFileSync("/tmp/text-sheet.html", html);

const dom = execFileSync(CHROME, [
  "--headless", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
  "--allow-file-access-from-files", "--force-device-scale-factor=1",
  "--default-background-color=00000000",
  "--window-size=1400,4000", "--virtual-time-budget=8000",
  "--screenshot=/tmp/text-sheet.png", "--dump-dom", "file:///tmp/text-sheet.html"
], { maxBuffer: 1 << 26 }).toString();

const m = /id="BOXES"[^>]*>([^<]*)</.exec(dom);
if (!m) throw new Error("could not read the measured boxes back out of the DOM");
const boxes = JSON.parse(m[1].replace(/&quot;/g, '"'));

const png = require(path.join(process.env.HOME, "cookers", "lib", "png.js"));
const sheet = png.read("/tmp/text-sheet.png");

const index = {};
Object.keys(boxes).forEach(function (key) {
  const b = boxes[key];
  const w = Math.min(b.w, sheet.width - b.x), h = Math.min(b.h, sheet.height - b.y);
  if (w <= 0 || h <= 0) { console.log("  ! " + key + " measured off-sheet"); return; }
  const im = png.blank(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const s = ((b.y + y) * sheet.width + (b.x + x)) * 4, d = (y * w + x) * 4;
    im.data[d] = sheet.data[s]; im.data[d + 1] = sheet.data[s + 1];
    im.data[d + 2] = sheet.data[s + 2]; im.data[d + 3] = sheet.data[s + 3];
  }
  png.write(path.join(OUT, key + ".png"), im);
  index[key] = { w: w, h: h };
});

fs.writeFileSync(path.join(OUT, "index.json"), JSON.stringify(index, null, 1));
console.log(Object.keys(index).length + " sprites -> " + OUT);
