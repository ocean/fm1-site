// Tests for the package reader, on small packages made here (no real firmware is committed).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  appAreaTable,
  appBin,
  classifyPackage,
  combinePackageStatuses,
  crc16,
  fm1ChipKey,
  jieliCipher,
  parseFwsc,
  productOf,
  stripMarkers,
  v15FlashDigest,
} from "./fwsc.mjs";

// Enciphers an app area's plain bytes in 32-byte blocks, as flash holds it.
function encipherAppArea(plain, chipKey = fm1ChipKey) {
  const blocks = [];
  for (let offset = 0; offset < plain.length; offset += 32) {
    blocks.push(jieliCipher(plain.subarray(offset, offset + 32), chipKey ^ ((offset >> 2) & 0xffff)));
  }
  return Buffer.concat(blocks);
}

// A flash.bin: a blank boot area, then an app area whose table names app.bin holding code.
export function makeFlash(code) {
  const codeAddress = 512;
  const plain = Buffer.alloc(codeAddress + Math.ceil(code.length / 32) * 32, 0xff);
  const record = Buffer.alloc(32);
  record.writeUInt16LE(crc16(code), 2);
  record.writeUInt32LE(codeAddress, 4);
  record.writeUInt32LE(code.length, 8);
  record[12] = 0x82;
  record.write("app.bin", 16, "latin1");
  record.writeUInt16LE(crc16(record.subarray(2)), 0);
  record.copy(plain, 0);
  code.copy(plain, codeAddress);
  const flash = Buffer.concat([Buffer.alloc(0x4000), encipherAppArea(plain)]);
  return Buffer.concat([flash, Buffer.alloc((4096 - (flash.length % 4096)) % 4096)]);
}

// A .fwsc file holding the given parts, with the product spelt by the header's markers.
export function makePackage({ product = "FM-1_123", chip = "AC791N", flash = null, loader = Buffer.alloc(1200, 0x5a) } = {}) {
  const parts = [];
  if (flash) parts.push({ type: 0, name: "flash.bin", data: flash });
  if (loader) parts.push({ type: 100, name: "ota.bin", data: loader });
  const tableEnd = 64 + parts.length * 80;
  let offset = tableEnd;
  const entries = parts.map((part) => {
    const fields = Buffer.alloc(80);
    fields.writeUInt16LE(part.type, 0);
    fields.writeUInt16LE(crc16(part.data), 4);
    fields.writeUInt32LE(offset, 8);
    fields.writeUInt32LE(part.data.length, 12);
    fields.writeUInt32LE(part.data.length, 16);
    fields.write(part.name, 64, "latin1");
    offset += part.data.length;
    return jieliCipher(fields);
  });
  const table = Buffer.concat(entries);
  const header = Buffer.alloc(64);
  header.writeUInt16LE(crc16(table), 2);
  header.writeUInt32LE(offset, 4);
  header.writeUInt16LE(parts.length, 8);
  header.write(chip, 16, "latin1");
  header.writeUInt16LE(crc16(header.subarray(2)), 0);
  const image = Buffer.concat([jieliCipher(header), table, ...parts.map((part) => part.data)]);

  const blocks = [];
  for (let block = 0; block < 20; block++) {
    const marker = block < product.length ? (product.charCodeAt(block) + block + 1) & 0xff : 0x7d;
    blocks.push(image.subarray(block * 47, (block + 1) * 47), Buffer.from([marker]));
  }
  return Buffer.concat([...blocks, image.subarray(20 * 47)]);
}

const code = (...texts) =>
  Buffer.concat([Buffer.alloc(100, 0x11), ...texts.map((text) => Buffer.from(text, "latin1")), Buffer.alloc(77, 0x22)]);

describe("the container's cipher and CRC", () => {
  it("computes CRC-16/XMODEM", () => {
    assert.equal(crc16(Buffer.from("123456789")), 0x31c3);
    assert.equal(crc16(Buffer.alloc(0)), 0);
  });

  it("enciphers with JieLi's ENC from key 0xFFFF", () => {
    const enciphered = jieliCipher(Buffer.alloc(4));
    // The key steps 0xFFFF, 0xEFDF, 0xCF9F, 0x8F1F: the low bytes are the keystream.
    assert.deepEqual([...enciphered], [0xff, 0xdf, 0x9f, 0x1f]);
  });

  it("deciphers what it enciphers, from any key", () => {
    const plain = Buffer.from("FELUCCA-LOADER-1 and some more text");
    assert.deepEqual(jieliCipher(jieliCipher(plain, 0x980f), 0x980f), plain);
    assert.notDeepEqual(jieliCipher(plain, 0x980f), plain);
  });
});

describe("the package's framing", () => {
  it("reads the product from the header's markers and strips them", () => {
    const file = makePackage({ flash: makeFlash(code("x")) });
    assert.equal(productOf(file), "FM-1_123");
    const image = stripMarkers(file);
    assert.equal(image.length, file.length - 20);
    assert.deepEqual(image.subarray(47, 94), file.subarray(48, 95));
  });

  it("finds flash.bin and ota.bin in the table", () => {
    const flash = makeFlash(code("x"));
    const fwsc = parseFwsc(makePackage({ flash }));
    assert.equal(fwsc.chip, "AC791N");
    assert.deepEqual(fwsc.parts.map((part) => [part.type, part.name]), [[0, "flash.bin"], [100, "ota.bin"]]);
    assert.deepEqual(fwsc.flash, flash);
    assert.equal(fwsc.loader.length, 1200);
  });

  it("reads app.bin out of the enciphered app area", () => {
    const app = code("hello");
    const flash = makeFlash(app);
    assert.deepEqual(appAreaTable(flash).map((record) => record.name), ["app.bin"]);
    assert.deepEqual(appBin(flash), app);
  });

  it("refuses damaged files", () => {
    assert.throws(() => parseFwsc(Buffer.alloc(500)), /too short/);
    const file = makePackage({ flash: makeFlash(code("x")) });
    const header = Buffer.from(file);
    header[10] ^= 0x01;
    assert.throws(() => parseFwsc(header), /header's CRC/);
    const part = Buffer.from(file);
    part[file.length - 400] ^= 0x01;
    assert.throws(() => parseFwsc(part), /damaged/);
    assert.throws(() => parseFwsc(Buffer.concat([file, Buffer.alloc(16)])), /length/);
  });
});

describe("classifyPackage", () => {
  const classify = (options) => classifyPackage(makePackage(options)).status;

  it("finds the old check: Felucca's loader marker without the fix's", () => {
    assert.equal(classify({ flash: makeFlash(code("..FELUCCA-LOADER-1..")) }), "affected");
  });

  it("finds the fix: both markers", () => {
    assert.equal(classify({ flash: makeFlash(code("FELUCCA-LOADER-1", "..AC79BLID..")) }), "ok");
  });

  it("finds a firmware that accepts only the exact V15 image by its pinned digest", () => {
    assert.equal(classify({ flash: makeFlash(code("FELUCCA-LOADER-1", "..", v15FlashDigest.toString("latin1"))) }), "ok");
  });

  it("says other for firmware without Felucca's update code", () => {
    assert.equal(classify({ flash: makeFlash(code("M-VAVE")) }), "other");
    assert.equal(classify({ flash: makeFlash(code("AC79BLID")) }), "other");
  });

  it("says other for an installer, another chip, or no app.bin", () => {
    assert.equal(classify({ flash: null }), "other");
    assert.equal(classify({ chip: "AC695N", flash: makeFlash(code("FELUCCA-LOADER-1")) }), "other");
    assert.equal(classify({ flash: Buffer.alloc(0x8000) }), "other");
  });

  it("keeps the product", () => {
    const result = classifyPackage(makePackage({ product: "FM-1_916", flash: makeFlash(code("x")) }));
    assert.equal(result.product, "FM-1_916");
  });
});

describe("combinePackageStatuses", () => {
  it("takes the worst of a release's packages", () => {
    assert.equal(combinePackageStatuses([]), "none");
    assert.equal(combinePackageStatuses(["ok", "affected"]), "affected");
    assert.equal(combinePackageStatuses(["other", "ok"]), "ok");
    assert.equal(combinePackageStatuses(["other"]), "other");
  });
});
