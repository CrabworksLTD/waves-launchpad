"use strict";
// ZIP writer for the browser, store-only (no compression) — the same format as
// lib/zip.js on the server, with Buffer swapped for Uint8Array.
//
// PNGs are already deflated, so compressing again buys almost nothing and costs
// CPU on the user's machine.
//
// The important difference from the server version: this never concatenates
// into one contiguous buffer. Parts are collected in an array and handed to the
// Blob constructor at the end, which lets the browser store them however it
// likes — including spilling to disk. A 600 MB collection would fail outright
// as a single ArrayBuffer on most machines.
window.Zip = (function () {

  var CRC = (function () {
    var t = new Int32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c;
    }
    return t;
  })();

  function crc32(buf) {
    var c = -1;
    for (var i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  }

  // DOS time/date, which is what the format wants
  function dosTime(d) {
    return ((d.getHours() << 11) | (d.getMinutes() << 5) | ((d.getSeconds() / 2) | 0)) & 0xFFFF;
  }
  function dosDate(d) {
    return (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF;
  }

  function u8(n) { return new Uint8Array(n); }
  function view(a) { return new DataView(a.buffer); }

  // A writer rather than a one-shot build(), so images can be added as they are
  // rendered instead of all being held until the end.
  function Writer() {
    this.parts = [];      // body chunks, in order
    this.central = [];    // central directory chunks
    this.offset = 0;
    this.count = 0;
    var now = new Date();
    this.time = dosTime(now);
    this.date = dosDate(now);
  }

  Writer.prototype.add = function (name, data) {
    var nameBytes = new TextEncoder().encode(name);
    var sum = crc32(data);

    var local = u8(30), lv = view(local);
    lv.setUint32(0, 0x04034b50, true);    // local file header
    lv.setUint16(4, 20, true);            // version needed
    lv.setUint16(6, 0, true);             // flags
    lv.setUint16(8, 0, true);             // method: store
    lv.setUint16(10, this.time, true);
    lv.setUint16(12, this.date, true);
    lv.setUint32(14, sum, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);            // extra length

    this.parts.push(local, nameBytes, data);

    var c = u8(46), cv = view(c);
    cv.setUint32(0, 0x02014b50, true);    // central directory header
    cv.setUint16(4, 20, true);            // version made by
    cv.setUint16(6, 20, true);            // version needed
    cv.setUint16(8, 0, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, this.time, true);
    cv.setUint16(14, this.date, true);
    cv.setUint32(16, sum, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);            // extra
    cv.setUint16(32, 0, true);            // comment
    cv.setUint16(34, 0, true);            // disk
    cv.setUint16(36, 0, true);            // internal attrs
    cv.setUint32(38, 0, true);            // external attrs
    cv.setUint32(42, this.offset, true);  // offset of local header
    this.central.push(c, nameBytes);

    this.offset += local.length + nameBytes.length + data.length;
    this.count++;
  };

  Writer.prototype.text = function (name, str) {
    this.add(name, new TextEncoder().encode(str));
  };

  Writer.prototype.blob = function () {
    var centralSize = 0;
    this.central.forEach(function (c) { centralSize += c.length; });

    var end = u8(22), ev = view(end);
    ev.setUint32(0, 0x06054b50, true);    // end of central directory
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, this.count, true);
    ev.setUint16(10, this.count, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, this.offset, true);
    ev.setUint16(20, 0, true);

    return new Blob(this.parts.concat(this.central, [end]), { type: "application/zip" });
  };

  return { Writer: Writer, crc32: crc32 };
})();
