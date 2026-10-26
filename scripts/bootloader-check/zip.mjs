// Reads the .fwsc files out of a zip archive, for releases that ship their packages zipped.
//
// Only what's needed: the central directory, and entries stored or deflated. Each entry is limited
// in size before and while it's inflated, so a hostile archive can't exhaust memory.
import { inflateRawSync } from "node:zlib";

const endSignature = 0x06054b50;
const centralSignature = 0x02014b50;
const localSignature = 0x04034b50;

// The archive's entries whose names match, as { name, data }. Throws for a damaged archive.
export function filesInZip(archive, { match = /\.fwsc$/i, maximumBytes = 4 * 1024 * 1024, maximumFiles = 16 } = {}) {
  // The end of central directory record is in the last 64 KiB + 22 bytes.
  let end = -1;
  for (let offset = archive.length - 22; offset >= Math.max(0, archive.length - 65_557); offset--) {
    if (archive.readUInt32LE(offset) === endSignature) {
      end = offset;
      break;
    }
  }
  if (end === -1) throw new Error("not a zip archive");
  const count = archive.readUInt16LE(end + 10);
  let offset = archive.readUInt32LE(end + 16);

  const files = [];
  for (let index = 0; index < count && files.length < maximumFiles; index++) {
    if (offset + 46 > archive.length || archive.readUInt32LE(offset) !== centralSignature) {
      throw new Error("the zip's directory is damaged");
    }
    const method = archive.readUInt16LE(offset + 10);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const size = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const localOffset = archive.readUInt32LE(offset + 42);
    const name = archive.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    offset += 46 + nameLength + extraLength + commentLength;

    if (!match.test(name) || name.includes("__MACOSX/")) continue;
    if (size > maximumBytes || compressedSize > maximumBytes) continue;
    if (localOffset + 30 > archive.length || archive.readUInt32LE(localOffset) !== localSignature) {
      throw new Error(`the zip's entry ${name} is damaged`);
    }
    const dataStart = localOffset + 30 + archive.readUInt16LE(localOffset + 26) + archive.readUInt16LE(localOffset + 28);
    const stored = archive.subarray(dataStart, dataStart + compressedSize);
    if (stored.length !== compressedSize) throw new Error(`the zip's entry ${name} is cut short`);
    if (method === 0) {
      files.push({ name, data: Buffer.from(stored) });
    } else if (method === 8) {
      files.push({ name, data: inflateRawSync(stored, { maxOutputLength: maximumBytes }) });
    }
  }
  return files;
}
