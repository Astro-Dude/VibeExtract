/**
 * DOM Heist — minimal ZIP writer (store-only, no compression).
 *
 * Store-only is not a shortcut here: every font format worth bundling (woff2
 * above all) is already compressed, so deflating again would cost CPU and a
 * deflate implementation while saving essentially nothing. This keeps the whole
 * archive writer under a hundred lines with no dependency.
 *
 * Entry names are the same relative paths the saved HTML references
 * ("fonts/Inter-600.woff2"), so unzipping next to the HTML makes it render with
 * the real fonts offline.
 */
(function (name, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (typeof globalThis !== 'undefined' ? globalThis : self)[name] = api;
})('DomHeistZip', function () {
  var CRC_TABLE = (function () {
    var table = new Uint32Array(256);
    for (var i = 0; i < 256; i += 1) {
      var c = i;
      for (var k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      table[i] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    var crc = 0xffffffff;
    for (var i = 0; i < bytes.length; i += 1) {
      crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function utf8Bytes(str) {
    if (typeof TextEncoder === 'function') return new TextEncoder().encode(str);
    // Node without TextEncoder in scope, or an exotic host.
    var out = [];
    for (var i = 0; i < str.length; i += 1) {
      var code = str.charCodeAt(i);
      if (code < 0x80) out.push(code);
      else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
      else out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
    return new Uint8Array(out);
  }

  function base64ToBytes(base64) {
    var binary = typeof atob === 'function'
      ? atob(base64)
      : Buffer.from(base64, 'base64').toString('binary');
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i) & 0xff;
    return bytes;
  }

  /** DOS date/time. Fixed timestamp keeps archives byte-reproducible. */
  var DOS_TIME = 0;
  var DOS_DATE = ((2024 - 1980) << 9) | (1 << 5) | 1;

  function Writer() {
    this.chunks = [];
    this.length = 0;
  }
  Writer.prototype.push = function (bytes) {
    this.chunks.push(bytes);
    this.length += bytes.length;
  };
  Writer.prototype.u16 = function (value) {
    this.push(new Uint8Array([value & 0xff, (value >>> 8) & 0xff]));
  };
  Writer.prototype.u32 = function (value) {
    this.push(new Uint8Array([
      value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff
    ]));
  };
  Writer.prototype.concat = function () {
    var out = new Uint8Array(this.length);
    var offset = 0;
    for (var i = 0; i < this.chunks.length; i += 1) {
      out.set(this.chunks[i], offset);
      offset += this.chunks[i].length;
    }
    return out;
  };

  /**
   * files: [{ name: 'fonts/Inter-600.woff2', bytes: Uint8Array }]
   *        or  { name, base64: '...' }
   * returns Uint8Array
   */
  function build(files) {
    var writer = new Writer();
    var central = [];

    for (var i = 0; i < files.length; i += 1) {
      var file = files[i];
      var bytes = file.bytes || base64ToBytes(file.base64 || '');
      var nameBytes = utf8Bytes(file.name);
      var crc = crc32(bytes);
      var offset = writer.length;

      // Local file header
      writer.u32(0x04034b50);
      writer.u16(20);            // version needed
      writer.u16(0x0800);        // UTF-8 filename flag
      writer.u16(0);             // method 0 = stored
      writer.u16(DOS_TIME);
      writer.u16(DOS_DATE);
      writer.u32(crc);
      writer.u32(bytes.length);  // compressed size == uncompressed for stored
      writer.u32(bytes.length);
      writer.u16(nameBytes.length);
      writer.u16(0);             // extra field length
      writer.push(nameBytes);
      writer.push(bytes);

      central.push({ name: nameBytes, crc: crc, size: bytes.length, offset: offset });
    }

    var centralStart = writer.length;
    for (var c = 0; c < central.length; c += 1) {
      var entry = central[c];
      writer.u32(0x02014b50);
      writer.u16(20);            // version made by
      writer.u16(20);            // version needed
      writer.u16(0x0800);
      writer.u16(0);
      writer.u16(DOS_TIME);
      writer.u16(DOS_DATE);
      writer.u32(entry.crc);
      writer.u32(entry.size);
      writer.u32(entry.size);
      writer.u16(entry.name.length);
      writer.u16(0);             // extra
      writer.u16(0);             // comment
      writer.u16(0);             // disk number
      writer.u16(0);             // internal attrs
      writer.u32(0);             // external attrs
      writer.u32(entry.offset);
      writer.push(entry.name);
    }
    var centralSize = writer.length - centralStart;

    // End of central directory
    writer.u32(0x06054b50);
    writer.u16(0);
    writer.u16(0);
    writer.u16(central.length);
    writer.u16(central.length);
    writer.u32(centralSize);
    writer.u32(centralStart);
    writer.u16(0);

    return writer.concat();
  }

  return { build: build, crc32: crc32, utf8Bytes: utf8Bytes, base64ToBytes: base64ToBytes };
});
