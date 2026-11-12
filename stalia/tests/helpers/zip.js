'use strict';
/* Test helper: reads back the zip archives Stalia writes (Word and Excel files), checking every entry on the way. */
const assert = require('node:assert/strict');
const X = require('../../app/export.js');

/** Files of a zip archive made by X.zip (stored entries), with every checksum verified. */
function unzip(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), out = {};
  const end = bytes.length - 22;
  assert.equal(v.getUint32(end, true), 0x06054b50, 'end of central directory');
  let p = v.getUint32(end + 16, true);
  for (let n = v.getUint16(end + 10, true); n > 0; n--) {
    assert.equal(v.getUint32(p, true), 0x02014b50, 'central directory entry');
    const size = v.getUint32(p + 24, true), nameLen = v.getUint16(p + 28, true), at = v.getUint32(p + 42, true);
    const name = Buffer.from(bytes.subarray(p + 46, p + 46 + nameLen)).toString('utf8');
    assert.equal(v.getUint32(at, true), 0x04034b50, 'local header of ' + name);
    assert.equal(v.getUint16(at + 8, true), 0, name + ' is stored');
    const data = bytes.subarray(at + 30 + nameLen, at + 30 + nameLen + size);
    assert.equal(X.crc32(data), v.getUint32(p + 16, true), 'checksum of ' + name);
    out[name] = data;
    p += 46 + nameLen;
  }
  return out;
}
const textOf = (files, name) => Buffer.from(files[name]).toString('utf8');

module.exports = { unzip, textOf };
