// Refresh individual preview images after a token has been re-rolled.
//
// build-preview.js writes only the first 240 at full size (the rest are left
// from an earlier full build), so a re-roll that touches token #4926 never
// reaches the site through it. Rebuilding all 5,555 to move 120 files is both
// slow and a five-thousand-file diff, so this redoes exactly the ids given.
//
//   node tools/refresh-preview-art.js 279 311 318 …
//   node tools/refresh-preview-art.js --stdin < ids.txt
//
// The downscale is copied from build-preview.js and has to stay identical to
// it, or a refreshed image would not match the ones around it.
const fs = require("fs");
const path = require("path");
const png = require(path.join(process.env.HOME, "cookers", "lib", "png.js"));

const SIZE = 192;
const IMGS = path.join(process.env.HOME, "cookers", "mint", "images");
const OUT = path.join(__dirname, "..", "app", "public", "preview", "img");

let ids = process.argv.slice(2).filter(a => /^\d+$/.test(a)).map(Number);
if (process.argv.includes("--stdin")) {
  ids = fs.readFileSync(0, "utf8").trim().split(/\s+/).filter(Boolean).map(Number);
}
if (!ids.length) {
  console.error("usage: node tools/refresh-preview-art.js <id> [id …]   |   --stdin");
  process.exit(1);
}

let n = 0;
for (const id of ids) {
  const s = png.read(path.join(IMGS, id + ".png"));
  const im = png.blank(SIZE, SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const sx = Math.floor(x * s.width / SIZE), sy = Math.floor(y * s.height / SIZE);
      const a = (sy * s.width + sx) * 4, d = (y * SIZE + x) * 4;
      im.data[d] = s.data[a]; im.data[d + 1] = s.data[a + 1];
      im.data[d + 2] = s.data[a + 2]; im.data[d + 3] = 255;
    }
  }
  png.write(path.join(OUT, id + ".png"), im);
  n++;
}
console.log("refreshed " + n + " preview images at " + SIZE + "px");
