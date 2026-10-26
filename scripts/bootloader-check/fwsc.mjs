// Reads an FM-1 firmware package (.fwsc) and says whether the firmware in it has Felucca's update
// code with the old bootloader check, the fixed check, or neither.
//
// A package is untrusted data: this only parses it, and never runs anything in it.
//
// The package format:
// - The first 20 blocks of 48 bytes each carry 47 image bytes and one marker byte; the markers
//   spell the product identity (marker i is the character + i + 1, 0x7D for none). The image is
//   the file without those 20 bytes.
// - The image is a JieLi firmware container: a 64-byte header and a table of 80-byte entries,
//   each enciphered with JieLi's ENC cipher from key 0xFFFF and each checked by CRC-16. The
//   entries name the parts: flash.bin (type 0, the firmware image from flash address 0) and
//   ota.bin (type 100, the update loader).
// - flash.bin's app area starts at 0x4000, enciphered in 32-byte blocks keyed by the chip key and
//   the block's offset. It starts with a table of files, one of which is app.bin, the firmware's
//   code.
//
// The app area's layout and its block cipher follow M-Flasher's formats.rs
// (https://github.com/jvitkauskas/m-flasher, MIT License, Copyright (c) 2026 Julius Vitkauskas),
// by way of FM1Kit's ApplicationArea.swift (MIT). The container format follows kagaimiq's
// jl-misctools (MIT).

const blockCount = 20;
const blockSize = 48;
const imageBytesPerBlock = 47;
const unusedMarker = 0x7d;
const headerLength = 64;
const entryLength = 80;
const maximumEntries = 12;
const maximumFileLength = 2 * 1024 * 1024;
const flashType = 0;
const loaderType = 100;
const appAreaStart = 0x4000;
const appTableEntries = 16;
const appBlockSize = 32;

// The chip key FM-1 firmware is enciphered with.
export const fm1ChipKey = 0x980f;
// The text Felucca's update code recognises its own loader by.
export const feluccaLoaderMarker = Buffer.from("FELUCCA-LOADER-1");
// The text the fixed update code (ota_boot_valid) looks for in an m-bootloader container.
export const bootloaderCheckMarker = Buffer.from("AC79BLID");
// The SHA-256 of V15's flash.bin (0x93000 bytes). A firmware that accepts only the exact V15
// image (and so puts M-VAVE's bootloader back), as SikkenWorks' B1, BEETLE and ETCH do, carries it.
export const v15FlashDigest = Buffer.from("c1068a403c04a6378a626afb66cc217f72d13f10aa200e983b7a9817cc1dac03", "hex");

// The CRC-16 the container and the app area use: polynomial 0x1021, starting from 0.
export function crc16(bytes, start = 0) {
  let value = start;
  for (const byte of bytes) {
    value ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) {
      value = value & 0x8000 ? ((value << 1) ^ 0x1021) & 0xffff : (value << 1) & 0xffff;
    }
  }
  return value;
}

// JieLi's ENC cipher: each byte is XORed with the low byte of a 16-bit key that steps like the
// CRC-16 register. It's symmetric, so the same call enciphers and deciphers. Returns a copy.
export function jieliCipher(bytes, key = 0xffff) {
  const output = Buffer.from(bytes);
  let current = key & 0xffff;
  for (let index = 0; index < output.length; index++) {
    output[index] ^= current & 0xff;
    current = ((current << 1) ^ (current & 0x8000 ? 0x1021 : 0)) & 0xffff;
  }
  return output;
}

// The identity the header's markers spell, such as FM-1_916.
export function productOf(file) {
  let product = "";
  for (let block = 0; block < blockCount; block++) {
    const marker = file[block * blockSize + imageBytesPerBlock];
    if (marker !== unusedMarker) product += String.fromCharCode((marker - block - 1) & 0xff);
  }
  return product;
}

// The image the device reads: the file without the header blocks' marker bytes.
export function stripMarkers(file) {
  const parts = [];
  for (let block = 0; block < blockCount; block++) {
    parts.push(file.subarray(block * blockSize, block * blockSize + imageBytesPerBlock));
  }
  parts.push(file.subarray(blockCount * blockSize));
  return Buffer.concat(parts);
}

const text = (bytes) => {
  const end = bytes.indexOf(0);
  return bytes.subarray(0, end === -1 ? bytes.length : end).toString("latin1");
};

// Reads a package. Throws an Error saying what's wrong when the file isn't a well-formed package.
// Returns its identity, chip, parts, and flash.bin's bytes (or null for an installer package).
export function parseFwsc(file) {
  if (file.length <= blockCount * blockSize) throw new Error("too short to be a package");
  if (file.length > maximumFileLength) throw new Error("too large to be a package");
  const product = productOf(file);
  const image = stripMarkers(file);
  const header = jieliCipher(image.subarray(0, headerLength));
  if (header.readUInt16LE(0) !== crc16(header.subarray(2))) throw new Error("the header's CRC is wrong");
  if (header.readUInt32LE(4) !== image.length) throw new Error("the header's length isn't the image's");
  const count = header.readUInt16LE(8);
  const tableEnd = headerLength + count * entryLength;
  if (count < 1 || count > maximumEntries || tableEnd > image.length) throw new Error("the table is damaged");
  if (header.readUInt16LE(2) !== crc16(image.subarray(headerLength, tableEnd))) {
    throw new Error("the table's CRC is wrong");
  }
  const chip = text(header.subarray(16, 32));

  const parts = [];
  for (let index = 0; index < count; index++) {
    const start = headerLength + index * entryLength;
    const fields = jieliCipher(image.subarray(start, start + entryLength));
    const part = {
      type: fields.readUInt16LE(0),
      checksum: fields.readUInt16LE(4),
      offset: fields.readUInt32LE(8),
      size: fields.readUInt32LE(12),
      encipheredLength: fields.readUInt32LE(24),
      name: text(fields.subarray(64)),
    };
    if (part.offset < tableEnd || part.offset + part.size > image.length) {
      throw new Error(`part ${part.name} is outside the image`);
    }
    if (part.encipheredLength === 0 && crc16(image.subarray(part.offset, part.offset + part.size)) !== part.checksum) {
      throw new Error(`part ${part.name} is damaged`);
    }
    parts.push(part);
  }
  const flashPart = parts.find((part) => part.type === flashType && part.encipheredLength === 0);
  const loaderPart = parts.find((part) => part.type === loaderType && part.encipheredLength === 0);
  const slice = (part) => (part ? image.subarray(part.offset, part.offset + part.size) : null);
  return { product, chip, parts, flash: slice(flashPart), loader: slice(loaderPart) };
}

// Deciphers bytes of flash.bin's app area, from offset within the area.
export function appAreaBytes(flash, offset, count, chipKey = fm1ChipKey) {
  const parts = [];
  let block = offset - (offset % appBlockSize);
  while (block < offset + count && appAreaStart + block + appBlockSize <= flash.length) {
    const start = appAreaStart + block;
    parts.push(jieliCipher(flash.subarray(start, start + appBlockSize), chipKey ^ ((block >> 2) & 0xffff)));
    block += appBlockSize;
  }
  const plain = Buffer.concat(parts);
  return plain.subarray(offset % appBlockSize, (offset % appBlockSize) + count);
}

// The app area's table of files and regions, up to the first record whose CRC fails.
export function appAreaTable(flash, chipKey = fm1ChipKey) {
  const records = [];
  for (let index = 0; index < appTableEntries; index++) {
    const raw = appAreaBytes(flash, index * appBlockSize, appBlockSize, chipKey);
    if (raw.length < appBlockSize || crc16(raw.subarray(2)) !== raw.readUInt16LE(0)) break;
    records.push({
      address: raw.readUInt32LE(4),
      length: raw.readUInt32LE(8),
      attribute: raw[12],
      name: text(raw.subarray(16)),
    });
  }
  return records;
}

// The firmware's app.bin, deciphered, or null if the table names none inside flash.bin.
export function appBin(flash, chipKey = fm1ChipKey) {
  const record = appAreaTable(flash, chipKey).find((entry) => entry.name === "app.bin");
  if (!record || appAreaStart + record.address + record.length > flash.length) return null;
  return appAreaBytes(flash, record.address, record.length, chipKey);
}

// Says what a package's firmware does when asked to install V15 on an FM-1 whose bootloader has
// changed: "affected" (Felucca's update code with the old check), "ok" (with the fix, or pinning
// V15's image) or "other" (not Felucca's update code, an installer, or not an FM-1 package).
// Throws for a damaged file.
//
// It can't see a firmware that installs every package with its own loader (TransitFM1): that
// takes an override.
export function classifyPackage(file) {
  const fwsc = parseFwsc(file);
  const result = (status, reason) => ({ status, reason, product: fwsc.product });
  if (fwsc.chip !== "AC791N") return result("other", `for the ${fwsc.chip || "unknown"} chip`);
  if (!fwsc.flash) return result("other", "no firmware image (an installer)");
  const code = appBin(fwsc.flash);
  if (!code) return result("other", "no app.bin in the firmware image");
  const felucca = code.includes(feluccaLoaderMarker);
  const fixed = code.includes(bootloaderCheckMarker);
  if (felucca && !fixed && code.includes(v15FlashDigest)) {
    return result("ok", "Felucca's update code, accepting only the exact V15 image");
  }
  if (felucca && !fixed) return result("affected", "Felucca's update code, without the fix");
  if (felucca && fixed) return result("ok", "Felucca's update code, with the fix");
  return result("other", "not Felucca's update code");
}

// The worst of several packages' statuses (a release can carry more than one).
export function combinePackageStatuses(statuses) {
  if (statuses.length === 0) return "none";
  for (const status of ["affected", "ok"]) {
    if (statuses.includes(status)) return status;
  }
  return "other";
}
