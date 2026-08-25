"use strict";
// Project model.
//
// A project is categories in draw order, each holding named traits. Every trait
// owns one image. Unlike the pixel-only pipeline this replaces, a trait's image
// is just RGBA — so pixel and brush drawings sit side by side and the generator
// does not care which produced them.
//
// Kept deliberately serialisable: the whole thing round-trips through JSON so it
// can move to per-user storage later without reshaping.

const Project = (function () {

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function blank(name) {
    return {
      id: uid(),
      name: name || "Untitled collection",
      canvas: { mode: "pixel", pixel: 48, raster: 1024 },
      supply: 500,
      seed: 1337,
      categories: [],
      // One-of-ones claim the first token ids. Each pins an option per category,
      // may replace or layer custom art on any of them, and may carry an
      // accessory drawn above everything.
      ones: [],
      // { when: {Category: [values]}, forbid: {Category: [values]} }
      // a value ending in " *" matches by prefix
      rules: []
    };
  }

  function addCategory(p, name) {
    const c = { id: uid(), name: name || "Category", traits: [] };
    p.categories.push(c);
    return c;
  }

  function addOne(p, name) {
    p.ones = p.ones || [];
    const o = { id: uid(), name: name || "One of one " + (p.ones.length + 1),
                extra: "", picks: {}, custom: {}, overlay: null };
    p.ones.push(o);
    return o;
  }

  // ---------- colors ----------
  // A color is a whole second drawing of the trait, not a transform of the
  // first. That is the point: the earlier system shifted hue/saturation, which
  // is a no-op on grayscale art and could never produce a gradient or a
  // pattern. Drawing each one costs more work but has no such ceiling, and new
  // colors start as a copy of the current drawing so it is a recolor, not a
  // redraw.
  //
  // A trait with no colors is drawn directly and emits one file. With colors
  // it emits one per color, and the trait's own layers/image go unused.
  function slots(t) {
    return (t.colors && t.colors.length) ? t.colors : [t];
  }

  function addColor(t, name) {
    t.colors = t.colors || [];
    // The first color adopts whatever is already drawn, so opening the list on
    // a finished trait never discards it.
    const seed = t.colors.length ? t.colors[t.colors.length - 1] : t;
    const c = {
      id: uid(),
      name: name || "Color " + (t.colors.length + 1),
      weight: 10,
      image: seed.image || null,
      layers: seed.layers ? JSON.parse(JSON.stringify(seed.layers)) : null
    };
    // fresh ids, or two colors would share layer identity
    if (c.layers) c.layers.forEach(function (l) { l.id = uid(); });
    t.colors.push(c);
    return c;
  }

  // Every option a category emits, as {name, traitId, colorId} — the same
  // expansion the generator does, so the picker and the output agree.
  function optionsOf(c) {
    const out = [];
    c.traits.forEach(function (t) {
      slots(t).forEach(function (s) {
        out.push({
          name: s === t ? t.name : t.name + " " + s.name,
          traitId: t.id, colorId: s === t ? null : s.id
        });
      });
    });
    return out;
  }

  function addTrait(p, catId, name) {
    const c = p.categories.find(function (x) { return x.id === catId; });
    if (!c) return null;
    const t = { id: uid(), name: name || "Trait", weight: 10, image: null, colors: [] };
    c.traits.push(t);
    return t;
  }

  // Resolves a trait id or a color id to the drawing it refers to. Selecting a
  // trait that has colors lands on its first color, since the trait itself
  // has no drawing of its own once colors exist.
  function find(p, id) {
    for (let i = 0; i < p.categories.length; i++) {
      const cat = p.categories[i];
      for (let j = 0; j < cat.traits.length; j++) {
        const t = cat.traits[j];
        if (t.id === id) {
          const s = slots(t)[0];
          return { cat: cat, trait: t, color: s === t ? null : s, slot: s };
        }
        const col = (t.colors || []).find(function (x) { return x.id === id; });
        if (col) return { cat: cat, trait: t, color: col, slot: col };
      }
    }
    return null;
  }

  function remove(p, id) {
    for (let i = 0; i < p.categories.length; i++) {
      if (p.categories[i].id === id) { p.categories.splice(i, 1); return true; }
      const ts = p.categories[i].traits;
      for (let j = 0; j < ts.length; j++) {
        if (ts[j].id === id) { ts.splice(j, 1); return true; }
        const cols = ts[j].colors || [];
        for (let k = 0; k < cols.length; k++) {
          if (cols[k].id === id) {
            const gone = cols.splice(k, 1)[0];
            // Removing the last color must not throw the art away — the trait
            // adopts that drawing and goes back to being a plain single-image
            // trait.
            if (!cols.length) {
              ts[j].image = gone.image || ts[j].image || null;
              ts[j].layers = gone.layers || ts[j].layers || null;
            }
            return true;
          }
        }
      }
    }
    return false;
  }

  // move a category to an absolute position, for drag reordering
  function reorder(p, id, toIndex) {
    const from = p.categories.findIndex(function (c) { return c.id === id; });
    if (from < 0) return false;
    const to = Math.max(0, Math.min(p.categories.length - 1, toIndex));
    if (from === to) return false;
    const x = p.categories.splice(from, 1)[0];
    p.categories.splice(to, 0, x);
    return true;
  }

  function move(p, id, dir) {
    for (let i = 0; i < p.categories.length; i++) {
      if (p.categories[i].id === id) {
        const to = i + dir;
        if (to < 0 || to >= p.categories.length) return false;
        const x = p.categories.splice(i, 1)[0];
        p.categories.splice(to, 0, x);
        return true;
      }
    }
    return false;
  }

  // How many unique tokens the current traits can produce. A category with no
  // traits is skipped rather than zeroing the whole product.
  function space(p) {
    let n = 1, used = 0;
    p.categories.forEach(function (c) {
      if (!c.traits.length) return;
      n *= outputs(c);
      used++;
    });
    return used ? n : 0;
  }

  // how many trait files a category actually emits
  function outputs(c) {
    return c.traits.reduce(function (a, t) { return a + slots(t).length; }, 0);
  }

  // Share of a category each trait takes, for the rarity readout.
  function shares(cat) {
    const total = cat.traits.reduce(function (a, t) { return a + (t.weight || 0); }, 0);
    return cat.traits.map(function (t) {
      return { name: t.name, weight: t.weight, pct: total ? (t.weight / total) * 100 : 0 };
    });
  }

  // Share within a trait each color takes.
  function colorShares(t) {
    const cols = t.colors || [];
    const total = cols.reduce(function (a, c) { return a + (c.weight || 0); }, 0);
    return cols.map(function (c) {
      return { name: c.name, weight: c.weight, pct: total ? (c.weight / total) * 100 : 0 };
    });
  }

  // Drawings with no image yet — these cannot mint, so the UI flags them.
  function undrawn(p) {
    const out = [];
    p.categories.forEach(function (c) {
      c.traits.forEach(function (t) {
        slots(t).forEach(function (s) {
          if (!s.image) out.push(c.name + " / " + t.name + (s === t ? "" : " " + s.name));
        });
      });
    });
    return out;
  }

  return {
    blank: blank, addCategory: addCategory, addTrait: addTrait,
    find: find, remove: remove, move: move, reorder: reorder,
    space: space, outputs: outputs, shares: shares, undrawn: undrawn,
    slots: slots, addColor: addColor, colorShares: colorShares,
    addOne: addOne, optionsOf: optionsOf, uid: uid
  };
})();

if (typeof module !== "undefined") module.exports = Project;
