// lib/tar-zst.js — solid tar + zstd container for forge archive runs and
// pack-analysis exports. Matches forge-archive convention: one compressed
// stream so many small near-duplicate files share a dictionary (zip cannot).
//
// In-process via node:zlib zstd. No shell tar. Requires Node >= 22.15
// (zlib.zstdCompressSync). Long paths use POSIX pax headers so bsdtar/GNU tar
// can list and extract the same bytes.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const BLOCK = 512;
const USTAR_MAGIC = Buffer.from('ustar\0', 'utf8');
const USTAR_VERSION = Buffer.from('00', 'utf8');
const PAX_PATH_KEY = 'path';

function requireZstd() {
  if (typeof zlib.zstdCompressSync !== 'function' || typeof zlib.zstdDecompressSync !== 'function') {
    throw new Error(
      'tar.zst requires Node.js zlib.zstdCompressSync (Node >= 22.15). '
      + `This process is ${process.version}.`,
    );
  }
}

function padBlock(buf) {
  const rem = buf.length % BLOCK;
  if (rem === 0) {
    return buf;
  }
  return Buffer.concat([buf, Buffer.alloc(BLOCK - rem)]);
}

function octalField(value, size) {
  // size includes the trailing NUL (or space) that classic tar expects.
  const bodyLen = size - 1;
  const s = Number(value).toString(8).padStart(bodyLen, '0');
  if (s.length > bodyLen) {
    throw new Error(`tar: value ${value} does not fit octal field width ${bodyLen}`);
  }
  const out = Buffer.alloc(size, 0);
  out.write(s, 0, 'ascii');
  return out;
}

function writeNameField(buf, offset, size, text) {
  const raw = Buffer.from(text, 'utf8');
  if (raw.length >= size) {
    return false;
  }
  raw.copy(buf, offset);
  return true;
}

function checksumHeader(header) {
  // Checksum field is 8 bytes of ASCII spaces while summing.
  const tmp = Buffer.from(header);
  tmp.fill(0x20, 148, 156);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) {
    sum += tmp[i];
  }
  return sum;
}

function encodePaxRecords(records) {
  // "LEN key=value\n" where LEN is the decimal length of the whole record.
  let body = '';
  for (const [key, value] of Object.entries(records)) {
    const content = `${key}=${value}\n`;
    let len = Buffer.byteLength(content, 'utf8') + 1;
    for (;;) {
      const rec = `${len} ${content}`;
      const actual = Buffer.byteLength(rec, 'utf8');
      if (actual === len) {
        body += rec;
        break;
      }
      len = actual;
    }
  }
  return Buffer.from(body, 'utf8');
}

function buildUstarHeader({ name, size, mtimeSec, typeflag, linkname = '' }) {
  const header = Buffer.alloc(BLOCK, 0);
  // name 0-99, mode 100-107, uid 108-115, gid 116-123, size 124-135,
  // mtime 136-147, chksum 148-155, typeflag 156, linkname 157-256,
  // magic 257-262, version 263-264, uname 265-296, gname 297-328
  if (!writeNameField(header, 0, 100, name)) {
    throw new Error(`tar: name too long for ustar field: ${name}`);
  }
  octalField(0o644, 8).copy(header, 100);
  octalField(0, 8).copy(header, 108);
  octalField(0, 8).copy(header, 116);
  octalField(size, 12).copy(header, 124);
  octalField(mtimeSec, 12).copy(header, 136);
  header[156] = typeflag.charCodeAt(0);
  if (linkname && !writeNameField(header, 157, 100, linkname)) {
    throw new Error(`tar: linkname too long: ${linkname}`);
  }
  USTAR_MAGIC.copy(header, 257);
  USTAR_VERSION.copy(header, 263);
  const sum = checksumHeader(header);
  // Six octal digits, NUL, space — common portable form.
  const chk = sum.toString(8).padStart(6, '0');
  header.write(chk, 148, 'ascii');
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

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
        out.push({
          abs,
          name: path.relative(root, abs).split(path.sep).join('/'),
        });
      }
    }
  }
  await rec(root);
  return out;
}

function appendFileEntry(chunks, name, data, mtimeSec) {
  const nameUtf8 = Buffer.from(name, 'utf8');
  // ustar name max 99 bytes + NUL. Longer names get a pax 'x' header first.
  if (nameUtf8.length < 100) {
    chunks.push(buildUstarHeader({ name, size: data.length, mtimeSec, typeflag: '0' }));
  } else {
    const paxBody = encodePaxRecords({ [PAX_PATH_KEY]: name });
    const paxName = `PaxHeader/${nameUtf8.subarray(0, 64).toString('utf8').replace(/[^\w.-]+/g, '_')}`;
    // Prefer pure pax: typeflag 'x' with short dummy name.
    const dummy = nameUtf8.subarray(0, 99).toString('utf8');
    chunks.push(buildUstarHeader({
      name: paxName.length < 100 ? paxName : dummy,
      size: paxBody.length,
      mtimeSec,
      typeflag: 'x',
    }));
    chunks.push(padBlock(paxBody));
    chunks.push(buildUstarHeader({
      name: dummy,
      size: data.length,
      mtimeSec,
      typeflag: '0',
    }));
  }
  chunks.push(padBlock(data));
}

/**
 * Pack every file under root into a solid .tar.zst at outPath.
 * Entry names are relative to root with `/` separators (no top-level root name).
 * @returns {{ files: number, bytes: number }}
 */
export async function tarZstDirContents(root, outPath) {
  requireZstd();
  const files = await walkFiles(root);
  const chunks = [];
  for (const f of files) {
    const [data, st] = await Promise.all([fs.readFile(f.abs), fs.stat(f.abs)]);
    const mtimeSec = Math.floor(st.mtimeMs / 1000);
    appendFileEntry(chunks, f.name, data, mtimeSec);
  }
  // Two zero blocks end the archive.
  chunks.push(Buffer.alloc(BLOCK * 2));
  const tarBuf = Buffer.concat(chunks);
  const zst = zlib.zstdCompressSync(tarBuf);
  await fs.writeFile(outPath, zst);
  return { files: files.length, bytes: zst.length };
}

function readOctal(buf, start, len) {
  const raw = buf.toString('ascii', start, start + len).replace(/\0.*$/, '').trim();
  if (!raw) {
    return 0;
  }
  return parseInt(raw, 8);
}

function parsePax(body) {
  const text = body.toString('utf8');
  const out = {};
  let i = 0;
  while (i < text.length) {
    const sp = text.indexOf(' ', i);
    if (sp < 0) {
      break;
    }
    const len = Number(text.slice(i, sp));
    if (!Number.isFinite(len) || len <= 0) {
      break;
    }
    const rec = text.slice(i, i + len);
    const eq = rec.indexOf('=');
    if (eq > 0) {
      const key = rec.slice(sp - i + 1, eq);
      // strip trailing newline
      let val = rec.slice(eq + 1);
      if (val.endsWith('\n')) {
        val = val.slice(0, -1);
      }
      out[key] = val;
    }
    i += len;
  }
  return out;
}

/**
 * Decompress and parse a tar.zst written by tarZstDirContents.
 * @returns {Map<string, Buffer>}
 */
export function readTarZstEntries(buf) {
  requireZstd();
  let tar;
  try {
    tar = zlib.zstdDecompressSync(buf);
  } catch (e) {
    throw new Error(`tar.zst: decompress failed: ${e.message}`);
  }
  const entries = new Map();
  let p = 0;
  let pendingPax = null;
  while (p + BLOCK <= tar.length) {
    const header = tar.subarray(p, p + BLOCK);
    p += BLOCK;
    if (header.every((b) => b === 0)) {
      // End marker (first of two zero blocks).
      break;
    }
    const size = readOctal(header, 124, 12);
    const typeflag = String.fromCharCode(header[156] || 0x30);
    let name = header.toString('utf8', 0, 100).replace(/\0.*$/, '');
    const prefix = header.toString('utf8', 345, 500).replace(/\0.*$/, '');
    if (prefix) {
      name = `${prefix}/${name}`;
    }
    const dataEnd = p + size;
    const data = Buffer.from(tar.subarray(p, dataEnd));
    p = dataEnd + ((BLOCK - (size % BLOCK)) % BLOCK);

    if (typeflag === 'x' || typeflag === 'g') {
      pendingPax = parsePax(data);
      continue;
    }
    if (typeflag === 'L') {
      // GNU long name — next file header uses this name.
      pendingPax = { ...(pendingPax || {}), [PAX_PATH_KEY]: data.toString('utf8').replace(/\0.*$/, '') };
      continue;
    }
    if (typeflag !== '0' && typeflag !== '\0' && typeflag !== '') {
      // Skip non-regular entries (dirs, links).
      pendingPax = null;
      continue;
    }
    if (pendingPax && pendingPax[PAX_PATH_KEY]) {
      name = pendingPax[PAX_PATH_KEY];
    }
    pendingPax = null;
    if (!name) {
      continue;
    }
    entries.set(name, data);
  }
  return entries;
}
