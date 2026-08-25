"use strict";
// Minimal ZIP writer, store-only (no compression).
//
// PNGs are already deflated and JSON is a rounding error next to them, so
// compressing again buys almost nothing and costs CPU per download. Writing
// this by hand avoids a dependency for what is ~80 lines of well-specified
// format.

const CRC = (function () {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// DOS time/date, which is what the format wants
function dosTime(d) {
  return ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() / 2)) & 0xFFFF;
}
function dosDate(d) {
  return (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF;
}

// entries: [{ name, data: Buffer }]
function build(entries) {
  const now = new Date();
  const time = dosTime(now), date = dosDate(now);
  const chunks = [];
  const central = [];
  let offset = 0;

  entries.forEach(function (e) {
    const name = Buffer.from(e.name, "utf8");
    const data = e.data;
    const sum = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);   // local file header
    local.writeUInt16LE(20, 4);           // version needed
    local.writeUInt16LE(0, 6);            // flags
    local.writeUInt16LE(0, 8);            // method: store
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);           // extra length

    chunks.push(local, name, data);

    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);       // central directory header
    c.writeUInt16LE(20, 4);               // version made by
    c.writeUInt16LE(20, 6);               // version needed
    c.writeUInt16LE(0, 8);
    c.writeUInt16LE(0, 10);
    c.writeUInt16LE(time, 12);
    c.writeUInt16LE(date, 14);
    c.writeUInt32LE(sum, 16);
    c.writeUInt32LE(data.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt16LE(0, 30);               // extra
    c.writeUInt16LE(0, 32);               // comment
    c.writeUInt16LE(0, 34);               // disk
    c.writeUInt16LE(0, 36);               // internal attrs
    c.writeUInt32LE(0, 38);               // external attrs
    c.writeUInt32LE(offset, 42);          // offset of local header
    central.push(c, name);

    offset += local.length + name.length + data.length;
  });

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);       // end of central directory
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([Buffer.concat(chunks), centralBuf, end]);
}

// walk a directory into zip entries, with an optional prefix inside the archive
function fromDir(fs, path, dir, prefix) {
  const out = [];
  (function walk(d, rel) {
    fs.readdirSync(d).forEach(function (f) {
      const full = path.join(d, f);
      const r = rel ? rel + "/" + f : f;
      if (fs.statSync(full).isDirectory()) walk(full, r);
      else out.push({ name: (prefix ? prefix + "/" : "") + r, data: fs.readFileSync(full) });
    });
  })(dir, "");
  return out;
}

module.exports = { build: build, fromDir: fromDir, crc32: crc32 };
