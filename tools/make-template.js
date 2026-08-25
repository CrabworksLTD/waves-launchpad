"use strict";
// Build a starter collection as a .moonpad.json the builder can open.
//
//   node tools/make-template.js
//
// A template is not a new file format — it is exactly what "Save project"
// writes, so anything the builder can open, this can produce, and a creator can
// edit every pixel of it after loading. That is the point: a starting position,
// not a locked skin.
//
// The art here is deliberately plain and deliberately original. The genre —
// a small pixel portrait with swappable traits — is not anybody's property, but
// specific collections are, so nothing is traced from anything. It exists to
// prove the path end to end and to show what a real one has to contain; it is
// not finished art.
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const N = 24;                 // 24x24, the classic pixel-portrait size
const OUT = path.join(__dirname, "..", "app", "public", "templates");

// ---------------------------------------------------------------- png
// A minimal encoder rather than a dependency: the builder wants data URLs and
// this is the whole of what that needs.
function crc32(buf) {
  let c, table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(rgba, w, h) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

// ---------------------------------------------------------------- drawing
function blank() { return Buffer.alloc(N * N * 4); }
function set(buf, x, y, hex) {
  if (x < 0 || y < 0 || x >= N || y >= N) return;
  const i = (y * N + x) * 4;
  buf[i] = parseInt(hex.slice(1, 3), 16);
  buf[i + 1] = parseInt(hex.slice(3, 5), 16);
  buf[i + 2] = parseInt(hex.slice(5, 7), 16);
  buf[i + 3] = 255;
}
function rect(buf, x, y, w, h, hex) {
  for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) set(buf, x + dx, y + dy, hex);
}
function url(buf) { return "data:image/png;base64," + png(buf, N, N).toString("base64"); }

// ---------------------------------------------------------------- drawing kit
// Rectangles alone read as programmer art. Everything here is drawn with a
// rounded-corner fill and a traced outline, on a 4-tone ramp (line, shade,
// base, lit) — which is the minimum a pixel portrait needs to stop looking
// generated. Each style carries its own line colour; a shared black outline is
// exactly the tell that five collections came off one script.

// fill a rect but drop the four corner pixels — instant rounding at this scale
function rrect(buf, x, y, w, h, hex) {
  rect(buf, x, y, w, h, hex);
  const clear = [[x, y], [x + w - 1, y], [x, y + h - 1], [x + w - 1, y + h - 1]];
  clear.forEach(function (c) {
    const i = (c[1] * N + c[0]) * 4;
    if (c[0] >= 0 && c[1] >= 0 && c[0] < N && c[1] < N) buf[i + 3] = 0;
  });
}
// trace an outline around everything opaque in `buf`, in `line`
function outline(buf, line) {
  const on = [];
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++)
    if (buf[(y * N + x) * 4 + 3]) on.push([x, y]);
  const has = {};
  on.forEach(function (p2) { has[p2[0] + "," + p2[1]] = 1; });
  on.forEach(function (p2) {
    [[0, -1], [0, 1], [-1, 0], [1, 0]].forEach(function (d) {
      const nx = p2[0] + d[0], ny = p2[1] + d[1];
      if (!has[nx + "," + ny] && nx >= 0 && ny >= 0 && nx < N && ny < N) {
        const i = (ny * N + nx) * 4;
        if (!buf[i + 3]) set(buf, nx, ny, line);
      }
    });
  });
}

// ---------------------------------------------------------------- rat
function ratHead(P) {
  const b = blank();
  // skull: narrow snouted wedge
  rrect(b, 8, 5, 9, 9, P.base);                 // cranium
  rect(b, 6, 9, 3, 4, P.base);                  // snout out to the left
  rect(b, 5, 10, 1, 2, P.base);
  rect(b, 10, 14, 6, 4, P.base);                // jaw / neck
  // ears: big round dishes, the rat signature
  rrect(b, 9, 1, 4, 4, P.base);
  rrect(b, 14, 1, 4, 4, P.base);
  set(b, 10, 2, P.inner); set(b, 11, 2, P.inner); set(b, 15, 2, P.inner); set(b, 16, 2, P.inner);
  set(b, 10, 3, P.inner); set(b, 15, 3, P.inner);
  // form
  rect(b, 8, 5, 1, 8, P.lit); rect(b, 16, 6, 1, 8, P.shade);
  rect(b, 10, 17, 6, 1, P.shade); rect(b, 6, 12, 3, 1, P.shade);
  // nose + teeth
  set(b, 5, 10, P.nose); set(b, 5, 11, P.nose);
  set(b, 7, 13, "#e6e2d6"); set(b, 8, 13, "#e6e2d6");
  outline(b, P.line);
  return b;
}
function ratEyes(hex) {
  const b = blank();
  // beady, close to the snout, with a catchlight
  rect(b, 9, 8, 2, 2, hex); rect(b, 13, 8, 2, 2, hex);
  set(b, 9, 8, "#ffffff"); set(b, 13, 8, "#ffffff");
  return b;
}
function whiskers(hex) {
  const b = blank();
  set(b, 3, 9, hex); set(b, 2, 10, hex); set(b, 3, 12, hex); set(b, 2, 12, hex);
  return b;
}

// ---------------------------------------------------------------- monkey
function monkeyHead(P) {
  const b = blank();
  rrect(b, 7, 4, 10, 11, P.base);               // cranium
  rrect(b, 5, 7, 3, 5, P.base);                 // ears out both sides
  rrect(b, 16, 7, 3, 5, P.base);
  set(b, 6, 9, P.inner); set(b, 17, 9, P.inner);
  rrect(b, 8, 9, 8, 8, P.muzzle);               // the lighter face patch
  rect(b, 10, 17, 4, 3, P.base);                // neck
  // form
  rect(b, 7, 4, 1, 10, P.lit); rect(b, 15, 5, 1, 4, P.shade);
  rect(b, 8, 16, 8, 1, P.shade);
  // nostrils
  set(b, 11, 12, P.line); set(b, 12, 12, P.line);
  outline(b, P.line);
  return b;
}
function monkeyEyes(hex, wide) {
  const b = blank();
  const h = wide ? 2 : 1;
  rect(b, 9, 10 - (wide ? 1 : 0), 2, h + 1, "#f2ede2");
  rect(b, 13, 10 - (wide ? 1 : 0), 2, h + 1, "#f2ede2");
  set(b, 10, 10, hex); set(b, 14, 10, hex);
  set(b, 9, 9, hex === "#2b2b33" ? "#f2ede2" : hex);
  return b;
}

// ---------------------------------------------------------------- cat (redrawn)
function catHead2(P) {
  const b = blank();
  rrect(b, 7, 6, 10, 9, P.base);                // face, wider than tall
  // triangular ears that actually taper
  set(b, 8, 3, P.base); rect(b, 7, 4, 3, 1, P.base); rect(b, 7, 5, 4, 1, P.base);
  set(b, 15, 3, P.base); rect(b, 14, 4, 3, 1, P.base); rect(b, 13, 5, 4, 1, P.base);
  set(b, 8, 4, P.inner); set(b, 15, 4, P.inner);
  rect(b, 9, 15, 6, 3, P.base);                 // chest
  // cheeks flare
  rect(b, 6, 10, 1, 3, P.base); rect(b, 17, 10, 1, 3, P.base);
  // form
  rect(b, 7, 6, 1, 8, P.lit); rect(b, 16, 7, 1, 7, P.shade);
  rect(b, 9, 17, 6, 1, P.shade);
  // muzzle: nose + split mouth
  set(b, 11, 11, P.nose); set(b, 12, 11, P.nose);
  set(b, 11, 12, P.line); set(b, 12, 12, P.line); set(b, 10, 13, P.line); set(b, 13, 13, P.line);
  outline(b, P.line);
  // whiskers go on after the outline, or the tracer wraps each one in a box
  // and they read as floating blobs rather than hairs
  set(b, 4, 10, P.shade); set(b, 3, 11, P.shade); set(b, 19, 10, P.shade); set(b, 20, 11, P.shade);
  return b;
}
function catEyes2(hex, style) {
  const b = blank();
  if (style === "slit") {
    rect(b, 9, 8, 2, 3, hex); rect(b, 13, 8, 2, 3, hex);
    set(b, 9, 9, "#14141c"); set(b, 13, 9, "#14141c");   // vertical pupil
    set(b, 10, 8, "#ffffff"); set(b, 14, 8, "#ffffff");
  } else {
    rect(b, 9, 9, 2, 2, hex); rect(b, 13, 9, 2, 2, hex);
    set(b, 9, 9, "#ffffff"); set(b, 13, 9, "#ffffff");
  }
  return b;
}

// ---------------------------------------------------------------- shared props
function propCap(P, hex, dark, style) {
  const b = blank();
  if (style === "beanie") {
    rrect(b, 7, 1, 10, 5, hex); rect(b, 7, 5, 10, 1, dark);
    set(b, 12, 0, dark);
  } else if (style === "back") {
    rrect(b, 7, 1, 10, 5, hex); rect(b, 15, 4, 5, 2, hex); rect(b, 16, 3, 3, 1, dark);
  } else {
    rrect(b, 7, 1, 10, 5, hex); rect(b, 3, 5, 10, 2, hex); rect(b, 3, 5, 10, 1, dark);
  }
  outline(b, P.line);
  return b;
}
function propShades(P, lens) {
  const b = blank();
  rect(b, 8, 8, 4, 3, P.line); rect(b, 13, 8, 4, 3, P.line);
  rect(b, 12, 8, 1, 1, P.line);
  rect(b, 9, 9, 2, 1, lens); rect(b, 14, 9, 2, 1, lens);
  set(b, 7, 8, P.line); set(b, 17, 8, P.line);
  return b;
}
function propChain(hex) {
  const b = blank();
  for (let x = 9; x <= 15; x += 2) set(b, x, 19, hex);
  set(b, 8, 18, hex); set(b, 16, 18, hex);
  set(b, 12, 20, hex);
  return b;
}
function propHalo(hex) {
  const b = blank();
  rect(b, 9, 0, 6, 1, hex); set(b, 8, 1, hex); set(b, 15, 1, hex);
  return b;
}
// ---------------------------------------------------------------- torso
// A bust, not a floating head. Shoulders rise from the bottom edge of the
// canvas so the portrait is anchored the way a PFP is, and the head's own neck
// paints over the collar, which is what stitches the two layers together.
function torso(P, hex, dark, lit, style) {
  const b = blank();
  rect(b, 8, 18, 8, 1, hex);                    // collar line rises to the neck
  rect(b, 6, 19, 12, 1, hex);
  rect(b, 5, 20, 14, 4, hex);
  // form
  rect(b, 5, 20, 1, 4, lit); rect(b, 18, 20, 1, 4, dark);
  rect(b, 6, 19, 1, 1, lit); rect(b, 17, 19, 1, 1, dark);
  if (style === "hoodie") {
    rect(b, 8, 18, 1, 6, dark); rect(b, 15, 18, 1, 6, dark);   // hood cords sides
    set(b, 11, 20, dark); set(b, 12, 20, dark);                 // drawstrings
    set(b, 11, 21, dark); set(b, 12, 21, dark);
  } else if (style === "vee") {
    set(b, 11, 19, P.line); set(b, 12, 19, P.line); set(b, 11, 20, P.line); set(b, 12, 20, P.line);
  } else if (style === "suit") {
    rect(b, 11, 19, 2, 5, "#e6e2d6");                           // shirt
    set(b, 11, 20, dark); set(b, 12, 21, dark);                 // tie hint
    rect(b, 8, 18, 2, 6, dark); rect(b, 14, 18, 2, 6, dark);    // lapels
  } else if (style === "stripe") {
    rect(b, 5, 21, 14, 1, dark);
  }
  // no line along the canvas bottom: the tracer only draws inside the canvas,
  // so the bust bleeds off the edge the way a PFP crop should
  outline(b, P.line);
  return b;
}

// ---------------------------------------------------------------- punk
function punkHead(P) {
  const b = blank();
  rrect(b, 8, 5, 8, 11, P.base);                // narrow skull
  rect(b, 9, 16, 6, 2, P.base);                 // jaw
  rect(b, 10, 18, 4, 2, P.base);                // neck
  // form
  rect(b, 8, 5, 1, 10, P.lit); rect(b, 15, 6, 1, 10, P.shade);
  rect(b, 9, 17, 6, 1, P.shade);
  // ear
  set(b, 7, 11, P.base); set(b, 7, 12, P.shade);
  // nose: one pixel out the side profile-ish front
  set(b, 11, 12, P.shade); set(b, 12, 12, P.shade);
  outline(b, P.line);
  return b;
}
function punkEyes(hex) {
  const b = blank();
  rect(b, 9, 9, 2, 1, hex); rect(b, 13, 9, 2, 1, hex);
  set(b, 9, 10, hex); set(b, 13, 10, hex);
  return b;
}
function punkHair(hex, dark, style) {
  const b = blank();
  const L = "#161020";
  if (style === "mohawk") {
    rect(b, 11, 0, 2, 6, hex); set(b, 11, 0, dark); set(b, 12, 1, dark);
    rect(b, 10, 4, 4, 2, hex);
  } else if (style === "wild") {
    for (let x = 7; x <= 16; x++) if ((x * 7) % 3) set(b, x, 2 + (x % 2), hex);
    rect(b, 7, 4, 10, 2, hex); rect(b, 6, 5, 1, 3, hex); rect(b, 17, 5, 1, 3, hex);
  } else if (style === "slick") {
    rect(b, 8, 4, 8, 2, hex); rect(b, 8, 5, 8, 1, dark); rect(b, 15, 6, 1, 2, hex);
  } else if (style === "hood") {
    rect(b, 7, 2, 10, 4, hex); rect(b, 6, 4, 1, 12, hex); rect(b, 17, 4, 1, 12, hex);
    rect(b, 7, 5, 10, 1, dark);
  }
  outline(b, L);
  return b;
}
function punkMouth(style) {
  const b = blank();
  const L = "#161020";
  if (style === "line") rect(b, 10, 14, 4, 1, L);
  else if (style === "frown") { rect(b, 10, 14, 4, 1, L); set(b, 9, 15, L); set(b, 14, 15, L); }
  else if (style === "smile") { rect(b, 10, 14, 4, 1, L); set(b, 9, 13, L); set(b, 14, 13, L); }
  return b;
}
function punkSmoke() {
  const b = blank();
  const L = "#161020";
  rect(b, 13, 14, 4, 1, "#e6e2d6"); set(b, 17, 14, "#c4453a");
  set(b, 18, 12, "#9a9aa3"); set(b, 19, 11, "#77777f"); set(b, 18, 10, "#5c5c66");
  outline(b, L);
  return b;
}
function punkEarring(hex) {
  const b = blank();
  set(b, 7, 13, hex);
  return b;
}

// ---------------------------------------------------------------- helpers
let seq = 0;
function uid() { return "tpl" + (seq++).toString(36) + Math.random().toString(36).slice(2, 6); }
function trait(name, weight, image) { return { id: uid(), name: name, weight: weight, image: url(image), colors: [] }; }
function category(name, traits) { return { id: uid(), name: name, traits: traits }; }
function flat(hex) { const b = blank(); rect(b, 0, 0, N, N, hex); return b; }

// ---------------------------------------------------------------- recipes
// Each style: its own line colour, its own palette family, its own silhouette.

function rats() {
  const L = "#1a1420";                         // warm near-black
  const coats = [
    ["Sewer Grey", 10, { base: "#8b8b93", shade: "#6c6c74", lit: "#a6a6ae", inner: "#c9a3a8", nose: "#c97a86", line: L }],
    ["Brown", 10, { base: "#8a6a4e", shade: "#6d5038", lit: "#a5836a", inner: "#c9a3a8", nose: "#b06a6a", line: L }],
    ["Black", 8, { base: "#38333d", shade: "#272430", lit: "#4a4552", inner: "#8a6a78", nose: "#a35b6b", line: L }],
    ["White", 6, { base: "#ddd8cc", shade: "#b7b2a5", lit: "#efeadf", inner: "#e8b7c1", nose: "#d98a97", line: L }],
    ["Plague", 4, { base: "#6b7a5c", shade: "#525f45", lit: "#84937a", inner: "#a3b08a", nose: "#7a8a5c", line: L }]
  ];
  return {
    file: "crypto-rats", name: "Crypto Rats",
    blurb: "Beady eyes, big ears, whiskers, and the odd gold chain. Scrappy on purpose.",
    categories: [
      category("Background", [
        trait("Tunnel", 12, flat("#241f2b")), trait("Brick", 9, flat("#43302c")),
        trait("Neon", 8, flat("#1f3333")), trait("Cheese", 6, flat("#575030")),
        trait("Blood", 4, flat("#3d2028"))
      ]),
            category("Outfit", [
        trait("Grey Hoodie", 9, torso({ line: L }, "#4a4e58", "#383b43", "#5d626e", "hoodie")),
        trait("Sewer Tee", 8, torso({ line: L }, "#5c6e5c", "#47563f", "#71846e", "vee")),
        trait("Rust Jacket", 6, torso({ line: L }, "#7a3b2e", "#5c2c22", "#93493a", "stripe")),
        trait("Shady Suit", 4, torso({ line: L }, "#33333b", "#242429", "#45454f", "suit"))
      ]),
      category("Coat", coats.map(function (c) { return trait(c[0], c[1], ratHead(c[2])); })),
      category("Eyes", [
        trait("Beady", 10, ratEyes("#1a1420")), trait("Red", 6, ratEyes("#c43a3a")),
        trait("Lime", 4, ratEyes("#cdfd37")), trait("Gold", 3, ratEyes("#c9982a"))
      ]),
      category("Whiskers", [
        trait("None", 8, blank()), trait("Grey", 8, whiskers("#9a9aa3")),
        trait("White", 6, whiskers("#ddd8cc"))
      ]),
      category("Extras", [
        trait("None", 12, blank()),
        trait("Gold Chain", 4, propChain("#c9982a")),
        trait("Beanie", 5, propCap({ line: L }, "#3d4a5c", "#2e3947", "beanie")),
        trait("Cap Back", 4, propCap({ line: L }, "#7a3b2e", "#5c2c22", "back")),
        trait("Shades", 3, propShades({ line: L }, "#3a4a5c"))
      ])
    ]
  };
}

function monkeys() {
  const L = "#231a12";
  const coats = [
    ["Cocoa", 10, { base: "#6d4c33", shade: "#543a26", lit: "#855e41", muzzle: "#c9a582", inner: "#8a6a4e", line: L }],
    ["Chestnut", 9, { base: "#8a5c33", shade: "#6d4826", lit: "#a57141", muzzle: "#d9b592", inner: "#a5744e", line: L }],
    ["Slate", 7, { base: "#5c5c66", shade: "#47474f", lit: "#71717d", muzzle: "#b0aa9d", inner: "#77777f", line: L }],
    ["Golden", 6, { base: "#b08a3d", shade: "#8f6e2e", lit: "#c9a352", muzzle: "#e5cfa3", inner: "#c9a352", line: L }],
    ["Night", 4, { base: "#33303b", shade: "#25232c", lit: "#443f4d", muzzle: "#8a8593", inner: "#443f4d", line: L }]
  ];
  return {
    file: "monkey-business", name: "Monkey Business",
    blurb: "Round ears, a lighter muzzle, plenty of attitude. Wide-eyed or unimpressed \u2014 your call.",
    categories: [
      category("Background", [
        trait("Jungle", 12, flat("#22382a")), trait("Dusk", 9, flat("#332b3f")),
        trait("Banana", 7, flat("#57502e")), trait("Sky", 7, flat("#28394a")),
        trait("Clay", 5, flat("#4a3226"))
      ]),
            category("Outfit", [
        trait("Jungle Tee", 9, torso({ line: L }, "#3f5c3a", "#31482e", "#4f7049", "vee")),
        trait("Banana Hoodie", 7, torso({ line: L }, "#b0a23d", "#8f832e", "#c9bb52", "hoodie")),
        trait("Navy Jacket", 6, torso({ line: L }, "#2f4a6e", "#243a57", "#3d5c85", "stripe")),
        trait("Boss Suit", 4, torso({ line: L }, "#33303b", "#25232c", "#443f4d", "suit"))
      ]),
      category("Coat", coats.map(function (c) { return trait(c[0], c[1], monkeyHead(c[2])); })),
      category("Eyes", [
        trait("Calm", 10, monkeyEyes("#2b2b33", false)), trait("Wide", 8, monkeyEyes("#2b2b33", true)),
        trait("Amber", 5, monkeyEyes("#b0731f", false)), trait("Wild", 3, monkeyEyes("#c43a3a", true))
      ]),
      category("Extras", [
        trait("None", 12, blank()),
        trait("Beanie", 5, propCap({ line: L }, "#3f5c3a", "#31482e", "beanie")),
        trait("Cap Red", 4, propCap({ line: L }, "#c4453a", "#9c352d", "cap")),
        trait("Shades", 4, propShades({ line: L }, "#2b2b33")),
        trait("Halo", 2, propHalo("#e5cf7a")),
        trait("Gold Chain", 3, propChain("#c9982a"))
      ])
    ]
  };
}

function cats() {
  const L = "#1c1826";
  const coats = [
    ["Tabby", 10, { base: "#b98b56", shade: "#96703f", lit: "#d1a56e", inner: "#e8b7c1", nose: "#d98a97", line: L }],
    ["Grey", 10, { base: "#8b8b93", shade: "#6c6c74", lit: "#a6a6ae", inner: "#c9a3a8", nose: "#c97a86", line: L }],
    ["Black", 8, { base: "#33333b", shade: "#242429", lit: "#45454f", inner: "#8a6a78", nose: "#a35b6b", line: L }],
    ["White", 6, { base: "#ddd8cc", shade: "#b7b2a5", lit: "#efeadf", inner: "#e8b7c1", nose: "#d98a97", line: L }],
    ["Ginger", 6, { base: "#c96f3a", shade: "#a3572a", lit: "#dc8850", inner: "#e8b7c1", nose: "#c97a5c", line: L }]
  ];
  return {
    file: "alley-cats", name: "Alley Cats",
    blurb: "Slit pupils, flared cheeks, proper triangular ears. The easiest set to recolour into your own.",
    categories: [
      category("Background", [
        trait("Dusk", 12, flat("#2f2a3d")), trait("Alley", 9, flat("#2c3333")),
        trait("Cream", 8, flat("#575039")), trait("Teal", 7, flat("#1f3d3d")),
        trait("Brick", 5, flat("#4a2f2a"))
      ]),
            category("Outfit", [
        trait("Alley Hoodie", 9, torso({ line: L }, "#3d4a5c", "#2e3947", "#4c5c72", "hoodie")),
        trait("Cream Tee", 8, torso({ line: L }, "#b0aa8d", "#8f8a70", "#c9c3a6", "vee")),
        trait("Plum Jacket", 6, torso({ line: L }, "#5c3a5c", "#472c47", "#714871", "stripe")),
        trait("Fancy Suit", 4, torso({ line: L }, "#2b2b33", "#1f1f26", "#3a3a45", "suit"))
      ]),
      category("Coat", coats.map(function (c) { return trait(c[0], c[1], catHead2(c[2])); })),
      category("Eyes", [
        trait("Green Slit", 10, catEyes2("#3f7a3a", "slit")), trait("Amber Slit", 8, catEyes2("#c9982a", "slit")),
        trait("Blue Slit", 6, catEyes2("#3a6ac4", "slit")), trait("Round", 6, catEyes2("#3f7a3a", "round")),
        trait("Odd", 2, (function () { const b = catEyes2("#3f7a3a", "slit");
          rect(b, 13, 8, 2, 3, "#3a6ac4"); set(b, 13, 9, "#14141c"); set(b, 14, 8, "#ffffff"); return b; })())
      ]),
      category("Extras", [
        trait("None", 13, blank()),
        trait("Beanie", 5, propCap({ line: L }, "#3d4a5c", "#2e3947", "beanie")),
        trait("Shades", 4, propShades({ line: L }, "#2b2b33")),
        trait("Gold Chain", 3, propChain("#c9982a")),
        trait("Halo", 2, propHalo("#e5cf7a"))
      ])
    ]
  };
}

function punks() {
  const L = "#161020";
  const skins = [
    ["Pale", 10, { base: "#e0bda0", shade: "#c19d80", lit: "#efd1b6", line: L }],
    ["Tan", 10, { base: "#c98f5e", shade: "#a06f45", lit: "#dba573", line: L }],
    ["Deep", 9, { base: "#7a5236", shade: "#5c3d28", lit: "#8f6344", line: L }],
    ["Undead", 3, { base: "#8fa383", shade: "#718266", lit: "#a5b899", line: L }],
    ["Visitor", 2, { base: "#8fb8c9", shade: "#7096a3", lit: "#a8cddb", line: L }]
  ];
  return {
    file: "chain-punks", name: "Chain Punks",
    blurb: "The classic 24x24 head-and-shoulders \u2014 mohawks, smokes, an earring, and two rare skins. Original pixels, familiar attitude.",
    categories: [
      category("Background", [
        trait("Slate", 12, flat("#4a5568")), trait("Sage", 10, flat("#5c6e5c")),
        trait("Mauve", 9, flat("#6e5c6e")), trait("Steel", 8, flat("#526270")),
        trait("Dusk", 5, flat("#3d3a4f"))
      ]),
      category("Outfit", [
        trait("Black Hoodie", 9, torso({ line: L }, "#33333b", "#242429", "#45454f", "hoodie")),
        trait("Worn Tee", 8, torso({ line: L }, "#5c6e5c", "#47563f", "#71846e", "vee")),
        trait("Leather", 6, torso({ line: L }, "#3d3038", "#2c222a", "#4f3f49", "stripe")),
        trait("Suit", 3, torso({ line: L }, "#2b2b33", "#1f1f26", "#3a3a45", "suit"))
      ]),
      category("Skin", skins.map(function (s) { return trait(s[0], s[1], punkHead(s[2])); })),
      category("Hair", [
        trait("Bald", 8, blank()),
        trait("Mohawk Green", 5, punkHair("#4fa34a", "#3d7a39", "mohawk")),
        trait("Mohawk Pink", 4, punkHair("#d96a9e", "#b04f7e", "mohawk")),
        trait("Wild Black", 6, punkHair("#23232b", "#16161c", "wild")),
        trait("Wild Blond", 4, punkHair("#c9b26b", "#a8914e", "wild")),
        trait("Slick", 6, punkHair("#23232b", "#16161c", "slick")),
        trait("Hood Up", 5, punkHair("#33333b", "#242429", "hood"))
      ]),
      category("Eyes", [
        trait("Flat", 10, punkEyes("#2b2b33")), trait("Tired", 6, punkEyes("#3d3a4f")),
        trait("Shades", 5, propShades({ line: L }, "#2b2b33")),
        trait("3D", 3, (function () { const b = blank();
          rect(b, 8, 8, 4, 3, "#e6e2d6"); rect(b, 13, 8, 4, 3, "#e6e2d6");
          rect(b, 9, 9, 2, 1, "#c4453a"); rect(b, 14, 9, 2, 1, "#3a6ac4");
          rect(b, 12, 8, 1, 1, "#e6e2d6"); outline(b, "#161020"); return b; })())
      ]),
      category("Mouth", [
        trait("Line", 10, punkMouth("line")), trait("Frown", 7, punkMouth("frown")),
        trait("Smoke", 5, punkSmoke()), trait("Smile", 4, punkMouth("smile"))
      ]),
      category("Extras", [
        trait("None", 12, blank()),
        trait("Earring", 5, punkEarring("#c9982a")),
        trait("Beanie", 4, propCap({ line: L }, "#3d4a5c", "#2e3947", "beanie")),
        trait("Cap Back", 3, propCap({ line: L }, "#7a3b2e", "#5c2c22", "back")),
        trait("Gold Chain", 3, propChain("#c9982a"))
      ])
    ]
  };
}

// ---------------------------------------------------------------- chibi
function chibiHead(P) {
  const b = blank();
  rrect(b, 5, 3, 14, 13, P.base);               // oversized head
  rect(b, 6, 15, 12, 1, P.base);
  rect(b, 10, 16, 4, 2, P.base);                // tiny neck
  // form: soft — one lit column, one shade column, chin shade
  rect(b, 5, 4, 1, 11, P.lit); rect(b, 18, 4, 1, 11, P.shade);
  rect(b, 7, 15, 10, 1, P.shade);
  // blush
  set(b, 7, 12, P.blush); set(b, 8, 12, P.blush);
  set(b, 15, 12, P.blush); set(b, 16, 12, P.blush);
  outline(b, P.line);
  return b;
}
function chibiEyes(iris, style) {
  const b = blank();
  const L = "#2b2233";
  function eye(x) {
    rect(b, x, 8, 4, 4, L);                     // big frame
    rect(b, x + 1, 9, 2, 2, iris);
    set(b, x + 1, 9, "#ffffff");                // catchlight high
    set(b, x + 2, 11, iris);
    if (style === "sparkle") set(b, x + 3, 10, "#ffffff");
    if (style === "sleepy") { rect(b, x, 8, 4, 1, L); rect(b, x + 1, 9, 2, 1, iris); }
  }
  eye(7); eye(13);
  return b;
}
function chibiMouth(style) {
  const b = blank();
  const L = "#2b2233";
  if (style === "tiny") set(b, 11, 14, L);
  else if (style === "smile") { set(b, 11, 14, L); set(b, 12, 14, L); set(b, 10, 13, L); set(b, 13, 13, L); }
  else if (style === "o") { set(b, 11, 14, L); set(b, 12, 14, L); set(b, 11, 15, L); set(b, 12, 15, L); }
  else if (style === "cat") { set(b, 10, 14, L); set(b, 12, 14, L); set(b, 11, 15, L); set(b, 13, 15, L); }
  return b;
}
function chibiHair(hex, dark, style) {
  const b = blank();
  const L = "#2b2233";
  // bangs across the brow are common to all
  rect(b, 5, 3, 14, 4, hex);
  set(b, 8, 7, hex); set(b, 12, 7, hex); set(b, 16, 7, hex);   // bang points
  rect(b, 5, 6, 1, 2, hex); rect(b, 18, 6, 1, 2, hex);
  if (style === "twintails") {
    rect(b, 2, 6, 3, 9, hex); rect(b, 19, 6, 3, 9, hex);
    rect(b, 2, 13, 3, 2, dark); rect(b, 19, 13, 3, 2, dark);
    set(b, 4, 5, dark); set(b, 19, 5, dark);
  } else if (style === "bob") {
    rect(b, 4, 5, 2, 9, hex); rect(b, 18, 5, 2, 9, hex);
    rect(b, 4, 13, 2, 1, dark); rect(b, 18, 13, 2, 1, dark);
  } else if (style === "buns") {
    rrect(b, 3, 2, 4, 4, hex); rrect(b, 17, 2, 4, 4, hex);
    set(b, 4, 3, dark); set(b, 18, 3, dark);
  } else if (style === "long") {
    rect(b, 4, 5, 2, 13, hex); rect(b, 18, 5, 2, 13, hex);
    rect(b, 4, 16, 2, 2, dark); rect(b, 18, 16, 2, 2, dark);
  }
  rect(b, 5, 4, 14, 1, dark === hex ? hex : dark);   // part shadow
  outline(b, L);
  return b;
}
function chibiBow(hex) {
  const b = blank();
  const L = "#2b2233";
  rect(b, 9, 1, 2, 2, hex); rect(b, 13, 1, 2, 2, hex); set(b, 11, 2, hex); set(b, 12, 2, hex);
  outline(b, L);
  return b;
}

function moonettes() {
  const L = "#2b2233";
  const skins = [
    ["Cream", 10, { base: "#f2ddc9", shade: "#d9bfa5", lit: "#faeada", blush: "#eda3ab", line: L }],
    ["Peach", 9, { base: "#edc9ab", shade: "#d1a887", lit: "#f6dcc4", blush: "#e58f9a", line: L }],
    ["Honey", 8, { base: "#cf9f70", shade: "#b08355", lit: "#e0b689", blush: "#d97f8f", line: L }],
    ["Cocoa", 7, { base: "#8a5f43", shade: "#6e4a32", lit: "#a37455", blush: "#b56676", line: L }],
    ["Doll", 3, { base: "#e8e4ef", shade: "#c6c1d4", lit: "#f6f3fa", blush: "#d4a3c9", line: L }]
  ];
  return {
    file: "moonettes", name: "Moonettes",
    blurb: "Pixel chibi \u2014 big shiny eyes, blush, bows and buns on pastel grounds. Sweet where the punks are sour.",
    categories: [
      category("Background", [
        trait("Rose", 11, flat("#e8c9d4")), trait("Lavender", 10, flat("#d4cce8")),
        trait("Mint", 9, flat("#c9e0d4")), trait("Butter", 8, flat("#e8e0c0")),
        trait("Sky", 7, flat("#c4d8e8")), trait("Charcoal", 3, flat("#3a3542"))
      ]),
      category("Outfit", [
        trait("Sailor", 9, torso({ line: L }, "#e8e4ef", "#8fa3c9", "#f6f3fa", "vee")),
        trait("Rose Hoodie", 8, torso({ line: L }, "#d98f9e", "#b06f7e", "#e8a8b5", "hoodie")),
        trait("Mint Tee", 7, torso({ line: L }, "#9ec9ab", "#7ea88a", "#b5dcc2", "vee")),
        trait("Lavender Knit", 6, torso({ line: L }, "#a89ec9", "#877ea8", "#bfb5dc", "stripe")),
        trait("Black Dress", 4, torso({ line: L }, "#3a3542", "#2b2733", "#4c4657", "suit"))
      ]),
      category("Skin", skins.map(function (s) { return trait(s[0], s[1], chibiHead(s[2])); })),
      category("Hair", [
        trait("Bob Black", 8, chibiHair("#33303b", "#242229", "bob")),
        trait("Bob Pink", 6, chibiHair("#e8a8c4", "#c987a3", "bob")),
        trait("Twintails Blond", 6, chibiHair("#e5d29a", "#c4b077", "twintails")),
        trait("Twintails Blue", 5, chibiHair("#9ab8e5", "#7796c4", "twintails")),
        trait("Buns Brown", 6, chibiHair("#8a5f43", "#6e4a32", "buns")),
        trait("Long Silver", 4, chibiHair("#d4d4dc", "#b0b0bc", "long")),
        trait("Long Lilac", 4, chibiHair("#c4a8e0", "#a387bf", "long"))
      ]),
      category("Eyes", [
        trait("Brown", 10, chibiEyes("#8a5f43", "plain")), trait("Blue", 8, chibiEyes("#5f7fc4", "plain")),
        trait("Green", 7, chibiEyes("#5f9e6e", "plain")), trait("Sparkle", 5, chibiEyes("#8a5f43", "sparkle")),
        trait("Sleepy", 4, chibiEyes("#8a5f43", "sleepy")), trait("Violet", 3, chibiEyes("#8f6ec4", "sparkle"))
      ]),
      category("Mouth", [
        trait("Tiny", 10, chibiMouth("tiny")), trait("Smile", 9, chibiMouth("smile")),
        trait("Cat", 5, chibiMouth("cat")), trait("O", 4, chibiMouth("o"))
      ]),
      category("Extras", [
        trait("None", 12, blank()),
        trait("Bow Pink", 5, chibiBow("#e58f9a")), trait("Bow Black", 4, chibiBow("#3a3542")),
        trait("Halo", 3, propHalo("#e5cf7a")),
        trait("Beret", 4, propCap({ line: L }, "#d98f9e", "#b06f7e", "beanie"))
      ])
    ]
  };
}

// ---------------------------------------------------------------- frog
function frogHead(P) {
  const b = blank();
  // eye bumps first, then the wide head over them
  rrect(b, 5, 3, 6, 5, P.base);
  rrect(b, 13, 3, 6, 5, P.base);
  rrect(b, 4, 7, 16, 9, P.base);
  rect(b, 9, 16, 6, 2, P.base);                 // chin into the torso
  // form
  rect(b, 4, 7, 1, 8, P.lit); rect(b, 19, 8, 1, 8, P.shade);
  rect(b, 5, 15, 14, 1, P.shade);
  rect(b, 6, 4, 1, 2, P.lit); rect(b, 17, 4, 1, 2, P.shade);
  // belly patch
  rect(b, 8, 12, 8, 4, P.belly);
  rect(b, 8, 12, 8, 1, P.shade);
  // nostrils
  set(b, 10, 9, P.line); set(b, 13, 9, P.line);
  // spots
  set(b, 6, 12, P.shade); set(b, 17, 13, P.shade); set(b, 7, 14, P.shade);
  outline(b, P.line);
  return b;
}
function frogEyes(hex, style) {
  const b = blank();
  function eye(x) {
    if (style === "sleepy") { rect(b, x, 5, 3, 1, "#141d14"); return; }
    rect(b, x, 4, 3, 3, "#f2f2ea");
    const px = style === "side" ? x + 2 : x + 1;
    set(b, px, 5, hex); set(b, px, 4, hex);
  }
  eye(6); eye(15);
  return b;
}
function frogMouth(style) {
  const b = blank();
  const L = "#141d14";
  if (style === "wide") rect(b, 7, 13, 10, 1, L);
  else if (style === "smile") { rect(b, 8, 13, 8, 1, L); set(b, 7, 12, L); set(b, 16, 12, L); }
  else if (style === "frown") { rect(b, 8, 13, 8, 1, L); set(b, 7, 14, L); set(b, 16, 14, L); }
  else if (style === "tongue") { rect(b, 7, 13, 10, 1, L);
    rect(b, 11, 14, 2, 3, "#d97f8f"); rect(b, 11, 16, 2, 1, "#b0616e"); }
  return b;
}

function frogs() {
  const L = "#141d14";
  const coats = [
    ["Pond Green", 10, { base: "#5c8a4a", shade: "#476e38", lit: "#71a35c", belly: "#c9d4a3", line: L }],
    ["Teal", 9, { base: "#4a8a7a", shade: "#386e60", lit: "#5ca392", belly: "#a3d4c4", line: L }],
    ["Mud", 7, { base: "#8a6f4a", shade: "#6e5738", lit: "#a3875c", belly: "#d4c4a3", line: L }],
    ["Berry", 5, { base: "#8a4a5c", shade: "#6e3847", lit: "#a35c71", belly: "#d4a3b0", line: L }],
    ["Golden", 3, { base: "#c9982a", shade: "#a37a1f", lit: "#e0b23d", belly: "#f0dfa3", line: L }]
  ];
  return {
    file: "moon-frogs", name: "Moon Frogs",
    blurb: "Wide grins, eye bumps, a belly patch and the odd golden rare. The pond\u2019s answer to the punks.",
    categories: [
      category("Background", [
        trait("Pond", 11, flat("#1d3328")), trait("Night", 9, flat("#1a1a2b")),
        trait("Reed", 8, flat("#3d4a26")), trait("Lotus", 7, flat("#3d2a38")),
        trait("Rain", 5, flat("#26323d"))
      ]),
      category("Outfit", [
        trait("Lily Tee", 9, torso({ line: L }, "#4a6e5c", "#38564a", "#5c8a71", "vee")),
        trait("Bog Hoodie", 8, torso({ line: L }, "#57503d", "#443e2e", "#6e654c", "hoodie")),
        trait("Scout Jacket", 6, torso({ line: L }, "#3d5c8a", "#2e476e", "#4a71a3", "stripe")),
        trait("Dapper Suit", 4, torso({ line: L }, "#26262e", "#1a1a21", "#33333d", "suit"))
      ]),
      category("Coat", coats.map(function (c) { return trait(c[0], c[1], frogHead(c[2])); })),
      category("Eyes", [
        trait("Forward", 10, frogEyes("#141d14", "plain")),
        trait("Side", 8, frogEyes("#141d14", "side")),
        trait("Sleepy", 5, frogEyes("#141d14", "sleepy")),
        trait("Red", 3, frogEyes("#c43a3a", "plain"))
      ]),
      category("Mouth", [
        trait("Wide", 10, frogMouth("wide")),
        trait("Smile", 8, frogMouth("smile")),
        trait("Tongue", 4, frogMouth("tongue")),
        trait("Frown", 4, frogMouth("frown"))
      ]),
      category("Extras", [
        trait("None", 12, blank()),
        trait("Crown", 3, (function () { const b = blank();
          const g = "#e5cf7a", d = "#c4a94f";
          rect(b, 9, 1, 6, 2, g); set(b, 9, 0, g); set(b, 12, 0, g); set(b, 14, 0, g);
          rect(b, 9, 2, 6, 1, d); outline(b, "#141d14"); return b; })()),
        trait("Beanie", 5, propCap({ line: L }, "#3d4a5c", "#2e3947", "beanie")),
        trait("Shades", 4, propShades({ line: L }, "#2b2b33")),
        trait("Gold Chain", 3, propChain("#c9982a"))
      ])
    ]
  };
}

// ---------------------------------------------------------------- write
fs.mkdirSync(OUT, { recursive: true });
const index = { note: "Starting points a creator can open in the builder and then change completely. Each entry is a .moonpad.json \u2014 exactly what Save project writes.", templates: [] };

[punks, rats, monkeys, cats, moonettes, frogs].forEach(function (make) {
  const r = make();
  const project = {
    id: uid(), name: r.name,
    canvas: { mode: "pixel", pixel: N, raster: 1024 },
    supply: 500, seed: 1337, ones: [], rules: [],
    categories: r.categories
  };
  const doc = { kind: "moonpad-project", version: 1, savedAt: new Date().toISOString(), project: project };
  const file = path.join(OUT, r.file + ".moonpad.json");
  fs.writeFileSync(file, JSON.stringify(doc));

  const combos = project.categories.reduce(function (a, c) { return a * c.traits.length; }, 1);
  const traits = project.categories.reduce(function (a, c) { return a + c.traits.length; }, 0);
  index.templates.push({
    file: r.file + ".moonpad.json", name: r.name, blurb: r.blurb,
    categories: project.categories.length, traits: traits, combinations: combos
  });
  console.log("  " + r.name.padEnd(16) + project.categories.length + " cats  " +
              String(traits).padStart(2) + " traits  " + combos.toLocaleString().padStart(7) +
              " combos  " + (fs.statSync(file).size / 1024).toFixed(0) + " KB");
});

fs.writeFileSync(path.join(OUT, "index.json"), JSON.stringify(index, null, 2));
console.log("  index.json written");
