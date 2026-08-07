// lib/zip.js: minimal dependency-free ZIP writer used by `forge archive`.
//
// Per-run diagnostic dirs are zipped so the archive repo can ship them under
// GitHub's 100 MB per-file limit. This runs in-process through node:zlib. The
// prior implementation shelled out to Windows PowerShell Compress-Archive,
// whose module auto-load is a stateful external dependency that failed
// mid-archive and left runs uncompressed.
//
// Scope is store and deflate entries. Zip64 records are emitted only when a
// run exceeds the classic limits of 65535 entries or a 4 GB directory, which
// the diagnostic capture dirs do.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const VERSION = 20;
const VERSION_ZIP64 = 45;
const FLAG_UTF8 = 0x0800;
const U16_MAX = 0xFFFF;
const U32_MAX = 0xFFFFFFFF;

// CRC-32 with the IEEE polynomial 0xEDB88320. Implemented here instead of
// zlib.crc32 so the writer works on the declared Node engine floor 22.13.
// zlib.crc32 only exists from Node 22.15 onward.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// ZIP stores modification time as DOS date and time. The DOS epoch is 1980,
// so clamp anything earlier to zero.
function dosDateTime(mtimeMs) {
  const d = new Date(mtimeMs);
  const dosYear = d.getFullYear() < 1980 ? 0 : d.getFullYear() - 1980;
  const date = (dosYear << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  return { date: date & 0xFFFF, time: time & 0xFFFF };
}

// Collect files as zip entry records. The entry name is the path relative to
// root using forward slashes. This mirrors Compress-Archive -Path "<root>\*",
// whose entries carry no top-level directory segment. Names are sorted so a
// given tree always produces the same entry order.
async function walkFiles(root) {
  const out = [];
  async function rec(dir) {
    const ents = await fs.readdir(dir, { withFileTypes: true });
    ents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of ents) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        await rec(abs);
      } else if (e.isFile()) {
        out.push({ abs, name: path.relative(root, abs).split(path.sep).join('/') });
      }
    }
  }
  await rec(root);
  return out;
}

async function writeAll(fh, buf) {
  let written = 0;
  while (written < buf.length) {
    const { bytesWritten } = await fh.write(buf, written, buf.length - written);
    if (bytesWritten === 0) {
      throw new Error('zip: file write made no progress');
    }
    written += bytesWritten;
  }
}

// Write every file under srcDir into zipPath and return the entry count. The
// count lets the caller gate on completeness before deleting the source tree.
export async function zipDirContents(srcDir, zipPath) {
  const files = await walkFiles(srcDir);
  const central = [];
  let offset = 0;
  const fh = await fs.open(zipPath, 'w');
  try {
    for (const f of files) {
      const data = await fs.readFile(f.abs);
      const stat = await fs.stat(f.abs);
      const { date, time } = dosDateTime(stat.mtimeMs);
      const crc = crc32(data);
      const deflated = zlib.deflateRawSync(data, { level: 9 });
      // Store the file uncompressed when deflate does not shrink it. Tiny or
      // already-compressed inputs can otherwise grow.
      const useStore = deflated.length >= data.length;
      const method = useStore ? 0 : 8;
      const body = useStore ? data : deflated;
      const nameBuf = Buffer.from(f.name, 'utf8');

      const local = Buffer.alloc(30);
      local.writeUInt32LE(LOCAL_SIG, 0);
      local.writeUInt16LE(VERSION, 4);
      local.writeUInt16LE(FLAG_UTF8, 6);
      local.writeUInt16LE(method, 8);
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(date, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(body.length, 18);
      local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(nameBuf.length, 26);
      local.writeUInt16LE(0, 28);
      await writeAll(fh, local);
      await writeAll(fh, nameBuf);
      await writeAll(fh, body);

      central.push({
        name: nameBuf, method, time, date, crc,
        comp: body.length, uncomp: data.length, offset,
      });
      offset += local.length + nameBuf.length + body.length;
    }

    const cdStart = offset;
    let cdSize = 0;
    for (const c of central) {
      // Diagnostic run dirs can hold hundreds of thousands of tiny capture
      // files. A single dir can exceed the 4 GB archive size where local
      // header offsets no longer fit in 32 bits, so promote size and offset
      // to the zip64 extended-information extra field when they overflow.
      const needsZip64 = c.uncomp >= U32_MAX || c.comp >= U32_MAX || c.offset >= U32_MAX;
      let extra = Buffer.alloc(0);
      if (needsZip64) {
        extra = Buffer.alloc(4 + 24);
        extra.writeUInt16LE(0x0001, 0);
        extra.writeUInt16LE(24, 2);
        extra.writeBigUInt64LE(BigInt(c.uncomp), 4);
        extra.writeBigUInt64LE(BigInt(c.comp), 12);
        extra.writeBigUInt64LE(BigInt(c.offset), 20);
      }
      const hdr = Buffer.alloc(46);
      hdr.writeUInt32LE(CENTRAL_SIG, 0);
      hdr.writeUInt16LE(needsZip64 ? VERSION_ZIP64 : VERSION, 4);
      hdr.writeUInt16LE(needsZip64 ? VERSION_ZIP64 : VERSION, 6);
      hdr.writeUInt16LE(FLAG_UTF8, 8);
      hdr.writeUInt16LE(c.method, 10);
      hdr.writeUInt16LE(c.time, 12);
      hdr.writeUInt16LE(c.date, 14);
      hdr.writeUInt32LE(c.crc, 16);
      hdr.writeUInt32LE(needsZip64 ? U32_MAX : c.comp, 20);
      hdr.writeUInt32LE(needsZip64 ? U32_MAX : c.uncomp, 24);
      hdr.writeUInt16LE(c.name.length, 28);
      hdr.writeUInt16LE(extra.length, 30);
      hdr.writeUInt16LE(0, 32);
      hdr.writeUInt16LE(0, 34);
      hdr.writeUInt16LE(0, 36);
      hdr.writeUInt32LE(0, 38);
      hdr.writeUInt32LE(needsZip64 ? U32_MAX : c.offset, 42);
      await writeAll(fh, hdr);
      await writeAll(fh, c.name);
      if (extra.length > 0) {
        await writeAll(fh, extra);
      }
      cdSize += hdr.length + c.name.length + extra.length;
    }

    // The classic end-of-central-directory record stores the entry count as
    // 16 bits and the directory size and offset as 32 bits. When any of those
    // overflow, a zip64 record and locator carry the true values and the
    // classic record holds sentinels. This is what lets a run dir with more
    // than 65535 files archive at all.
    const count = central.length;
    const needZip64Eocd = count > U16_MAX || cdStart >= U32_MAX || cdSize >= U32_MAX;
    if (needZip64Eocd) {
      const z64 = Buffer.alloc(56);
      z64.writeUInt32LE(ZIP64_EOCD_SIG, 0);
      z64.writeBigUInt64LE(BigInt(44), 4);
      z64.writeUInt16LE(VERSION_ZIP64, 12);
      z64.writeUInt16LE(VERSION_ZIP64, 14);
      z64.writeUInt32LE(0, 16);
      z64.writeUInt32LE(0, 20);
      z64.writeBigUInt64LE(BigInt(count), 24);
      z64.writeBigUInt64LE(BigInt(count), 32);
      z64.writeBigUInt64LE(BigInt(cdSize), 40);
      z64.writeBigUInt64LE(BigInt(cdStart), 48);
      await writeAll(fh, z64);

      const loc = Buffer.alloc(20);
      loc.writeUInt32LE(ZIP64_LOCATOR_SIG, 0);
      loc.writeUInt32LE(0, 4);
      loc.writeBigUInt64LE(BigInt(cdStart + cdSize), 8);
      loc.writeUInt32LE(1, 16);
      await writeAll(fh, loc);
    }

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(EOCD_SIG, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(Math.min(count, U16_MAX), 8);
    eocd.writeUInt16LE(Math.min(count, U16_MAX), 10);
    eocd.writeUInt32LE(Math.min(cdSize, U32_MAX), 12);
    eocd.writeUInt32LE(Math.min(cdStart, U32_MAX), 16);
    eocd.writeUInt16LE(0, 20);
    await writeAll(fh, eocd);
  } finally {
    await fh.close();
  }
  return { files: files.length };
}

// Read every entry from a zip written by zipDirContents (store or deflate,
// classic or zip64 EOCD). Returns Map<entryName, Buffer>. Used by
// pack-analysis verify so inspection never depends on an external unzip tool.
export function readZipEntries(buf) {
  let p = buf.length - 22;
  while (p >= 0 && buf.readUInt32LE(p) !== EOCD_SIG) {
    p--;
  }
  if (p < 0) {
    throw new Error('zip: end-of-central-directory record not found');
  }
  let total = buf.readUInt16LE(p + 10);
  let cdOffset = buf.readUInt32LE(p + 16);
  if (total === U16_MAX || cdOffset === U32_MAX) {
    const locPos = p - 20;
    if (buf.readUInt32LE(locPos) !== ZIP64_LOCATOR_SIG) {
      throw new Error('zip: missing zip64 locator');
    }
    const z64Pos = Number(buf.readBigUInt64LE(locPos + 8));
    if (buf.readUInt32LE(z64Pos) !== ZIP64_EOCD_SIG) {
      throw new Error('zip: missing zip64 end-of-central-directory');
    }
    total = Number(buf.readBigUInt64LE(z64Pos + 32));
    cdOffset = Number(buf.readBigUInt64LE(z64Pos + 48));
  }
  const entries = new Map();
  let q = cdOffset;
  for (let i = 0; i < total; i++) {
    if (buf.readUInt32LE(q) !== CENTRAL_SIG) {
      throw new Error(`zip: bad central directory signature at ${q}`);
    }
    const method = buf.readUInt16LE(q + 10);
    const crc = buf.readUInt32LE(q + 16);
    let comp = buf.readUInt32LE(q + 20);
    let uncomp = buf.readUInt32LE(q + 24);
    const nameLen = buf.readUInt16LE(q + 28);
    const extraLen = buf.readUInt16LE(q + 30);
    const commentLen = buf.readUInt16LE(q + 32);
    let lho = buf.readUInt32LE(q + 42);
    const name = buf.toString('utf8', q + 46, q + 46 + nameLen);
    if (comp === U32_MAX || uncomp === U32_MAX || lho === U32_MAX) {
      const ex = q + 46 + nameLen;
      if (buf.readUInt16LE(ex) !== 0x0001) {
        throw new Error(`zip: missing zip64 extra for ${name}`);
      }
      uncomp = Number(buf.readBigUInt64LE(ex + 4));
      comp = Number(buf.readBigUInt64LE(ex + 12));
      lho = Number(buf.readBigUInt64LE(ex + 20));
    }
    if (buf.readUInt32LE(lho) !== LOCAL_SIG) {
      throw new Error(`zip: bad local header for ${name}`);
    }
    const lNameLen = buf.readUInt16LE(lho + 26);
    const lExtraLen = buf.readUInt16LE(lho + 28);
    const dataStart = lho + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + comp);
    const data = method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw);
    if (data.length !== uncomp) {
      throw new Error(`zip: uncompressed size mismatch for ${name}`);
    }
    if (crc32(data) !== crc) {
      throw new Error(`zip: crc mismatch for ${name}`);
    }
    entries.set(name, data);
    q += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}
