/* Brand — the single source of truth for every name-bearing string.
 *
 * The name is NOT decided yet. "SUNPAD" is a placeholder. To rename the whole
 * project, run:  node tools/rename.js NEWNAME
 * which rewrites this file plus the handful of places a name has to be baked
 * into markup (the <title>, OG tags and the wordmark in app.html).
 *
 * Nothing else in the codebase should contain the product name. If you find
 * yourself typing it in another file, add a field here instead. */
(function () {
  var NAME = "SUNPAD";
  var lower = NAME.toLowerCase();

  window.BRAND = {
    name: NAME,                       // "SUNPAD" — display, uppercase
    lower: lower,                     // "sunpad" — keys, slugs, filenames
    tagline: "Design Suite",
    description: "Design, assemble, and deploy your own NFT collection on Solana.",
    chain: "Solana",
    domain: "",                       // set once a domain is registered

    // Save files. `fileKind` is written into new saves; `readKinds` is what we
    // accept when opening, so Moonpad projects and the bundled templates
    // (which are still "moonpad-project") keep working. Never drop an entry
    // from readKinds — it silently orphans anyone's saved work.
    fileKind: lower + "-project",
    readKinds: [lower + "-project", "moonpad-project"],
    fileExt: "." + lower + ".json",
    readExts: [".json", "." + lower + ".json", ".moonpad.json"],

    // localStorage namespace. Bumping this resets the tour for everyone.
    key: function (s) { return lower + "." + s; }
  };
})();
