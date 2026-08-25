"use strict";
const fs = require("fs");
const path = require("path");
const png = require("./png");

// traits/
//   01_Background/
//     Sky#15.png        <- weight 15
//     Void#2.png
//   02_Fit/
//     Zip hoodie.png    <- no "#", weight defaults to 100
//
// Directory number sets the stacking order, low to high. Everything after the
// underscore is the trait_type shown in metadata.

const DIR_RE = /^(\d+)[_\-\s]+(.+)$/;
const FILE_RE = /^(.+?)(?:#(\d+(?:\.\d+)?))?\.png$/i;

function loadCatalog(traitsDir) {
  if (!fs.existsSync(traitsDir)) {
    throw new Error("No traits directory at " + traitsDir);
  }

  const dirs = fs.readdirSync(traitsDir)
    .filter(function (d) { return fs.statSync(path.join(traitsDir, d)).isDirectory(); })
    .map(function (d) {
      const m = DIR_RE.exec(d);
      if (!m) {
        throw new Error(
          'Trait folder "' + d + '" must be named like "01_Background" ' +
          "(number, underscore, trait name)."
        );
      }
      return { dir: d, order: parseInt(m[1], 10), name: m[2].trim() };
    })
    .sort(function (a, b) { return a.order - b.order || a.name.localeCompare(b.name); });

  if (!dirs.length) throw new Error("No trait folders found in " + traitsDir);

  const cats = dirs.map(function (d) {
    const files = fs.readdirSync(path.join(traitsDir, d.dir))
      .filter(function (f) { return /\.png$/i.test(f) && !f.startsWith("."); })
      .sort();

    if (!files.length) throw new Error('Trait folder "' + d.dir + '" has no PNGs.');

    const options = files.map(function (f) {
      const m = FILE_RE.exec(f);
      const file = path.join(traitsDir, d.dir, f);
      return {
        name: m[1].trim(),
        weight: m[2] ? parseFloat(m[2]) : 100,
        file: file,
        img: png.read(file)
      };
    });

    // A trait named "None" (any case) still occupies a slot but contributes no
    // pixels, which is how you make a category optional.
    return { order: d.order, name: d.name, dir: d.dir, options: options };
  });

  validate(cats);
  return cats;
}

function validate(cats) {
  const first = cats[0].options[0];
  const W = first.img.width, H = first.img.height;
  const bad = [];

  cats.forEach(function (c) {
    c.options.forEach(function (o) {
      if (o.img.width !== W || o.img.height !== H) {
        bad.push(
          "  " + c.dir + "/" + path.basename(o.file) +
          " is " + o.img.width + "x" + o.img.height + ", expected " + W + "x" + H
        );
      }
    });
  });

  if (bad.length) {
    throw new Error(
      "Every layer must be the same canvas size and aligned:\n" + bad.join("\n")
    );
  }
  return { width: W, height: H };
}

function rate(cat, i) {
  let total = 0;
  for (let j = 0; j < cat.options.length; j++) total += cat.options[j].weight;
  return cat.options[i].weight / total;
}

module.exports = { loadCatalog, validate, rate };
