// tests/zip.test.js — in-process ZIP writer (lib/zip.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { zipDirContents } from '../lib/zip.js';

// Independent ZIP reader used only by the tests. It walks the central
// directory, inflates every entry, and returns name -> bytes so the round
// trip proves the writer emits a structurally valid, complete archive. It
// resolves the true entry count and directory offset from the zip64 records
// when the classic end-of-central-directory fields hold sentinels.
function readZip(buf) {
  let p = buf.length - 22;
  while (p >= 0 && buf.readUInt32LE(p) !== 0x06054b50) {
    p--;
  }
  assert.ok(p >= 0, 'end-of-central-directory record present');
  let total = buf.readUInt16LE(p + 10);
  let cdOffset = buf.readUInt32LE(p + 16);
  if (total === 0xFFFF || cdOffset === 0xFFFFFFFF) {
    const locPos = p - 20;
    assert.equal(buf.readUInt32LE(locPos), 0x07064b50, 'zip64 locator signature');
    const z64Pos = Number(buf.readBigUInt64LE(locPos + 8));
    assert.equal(buf.readUInt32LE(z64Pos), 0x06064b50, 'zip64 end-of-central-directory signature');
    total = Number(buf.readBigUInt64LE(z64Pos + 32));
    cdOffset = Number(buf.readBigUInt64LE(z64Pos + 48));
  }
  const entries = new Map();
  let q = cdOffset;
  for (let i = 0; i < total; i++) {
    assert.equal(buf.readUInt32LE(q), 0x02014b50, 'central directory signature');
    const method = buf.readUInt16LE(q + 10);
    const crc = buf.readUInt32LE(q + 16);
    let comp = buf.readUInt32LE(q + 20);
    let uncomp = buf.readUInt32LE(q + 24);
    const nameLen = buf.readUInt16LE(q + 28);
    const extraLen = buf.readUInt16LE(q + 30);
    const commentLen = buf.readUInt16LE(q + 32);
    let lho = buf.readUInt32LE(q + 42);
    const name = buf.toString('utf8', q + 46, q + 46 + nameLen);
    if (comp === 0xFFFFFFFF || uncomp === 0xFFFFFFFF || lho === 0xFFFFFFFF) {
      const ex = q + 46 + nameLen;
      assert.equal(buf.readUInt16LE(ex), 0x0001, 'zip64 extra field tag');
      uncomp = Number(buf.readBigUInt64LE(ex + 4));
      comp = Number(buf.readBigUInt64LE(ex + 12));
      lho = Number(buf.readBigUInt64LE(ex + 20));
    }
    assert.equal(buf.readUInt32LE(lho), 0x04034b50, 'local file header signature');
    const lNameLen = buf.readUInt16LE(lho + 26);
    const lExtraLen = buf.readUInt16LE(lho + 28);
    const dataStart = lho + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + comp);
    const data = method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw);
    assert.equal(data.length, uncomp, `uncompressed size for ${name}`);
    assert.equal(zlib.crc32(data), crc, `crc for ${name}`);
    entries.set(name, data);
    q += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

test('zipDirContents round-trips a nested tree with correct entries and bytes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-zip-'));
  try {
    const srcDir = path.join(root, 'run');
    await fs.mkdir(path.join(srcDir, 'captures'), { recursive: true });
    await fs.mkdir(path.join(srcDir, 'turn1'), { recursive: true });
    // Highly compressible JSON so deflate is exercised.
    const big = JSON.stringify({ event: 'x'.repeat(5000), n: Array(500).fill(0) });
    const files = {
      'manifest.json': JSON.stringify({ run: 1 }),
      'captures/00000_a.json': big,
      'turn1/sample-1.json': JSON.stringify({ x: 1 }),
    };
    for (const [rel, content] of Object.entries(files)) {
      await fs.writeFile(path.join(srcDir, ...rel.split('/')), content);
    }

    const zipPath = path.join(root, 'run.zip');
    const { files: count } = await zipDirContents(srcDir, zipPath);
    assert.equal(count, 3, 'reported entry count matches source files');

    const buf = await fs.readFile(zipPath);
    const entries = readZip(buf);
    assert.deepEqual([...entries.keys()].sort(), Object.keys(files).sort());
    for (const [rel, content] of Object.entries(files)) {
      assert.equal(entries.get(rel).toString('utf8'), content, `content for ${rel}`);
    }
    // The large repetitive entry must have actually compressed.
    assert.ok(buf.length < Buffer.byteLength(big), 'archive is smaller than the raw large file');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('zipDirContents produces a valid empty archive for an empty dir', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-zip-empty-'));
  try {
    const srcDir = path.join(root, 'run');
    await fs.mkdir(srcDir, { recursive: true });
    const zipPath = path.join(root, 'run.zip');
    const { files: count } = await zipDirContents(srcDir, zipPath);
    assert.equal(count, 0);
    const buf = await fs.readFile(zipPath);
    const entries = readZip(buf);
    assert.equal(entries.size, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('zipDirContents emits zip64 when a run exceeds 65535 entries', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-zip64-'));
  try {
    const srcDir = path.join(root, 'run');
    await fs.mkdir(srcDir, { recursive: true });
    // One past the 16-bit classic entry-count ceiling forces the zip64 path,
    // which is exactly the case that failed on real capture dirs.
    const n = 65536;
    const names = [];
    for (let i = 0; i < n; i++) {
      names.push(`c${String(i).padStart(6, '0')}.json`);
    }
    const batch = 2000;
    for (let i = 0; i < names.length; i += batch) {
      await Promise.all(names.slice(i, i + batch).map(
        name => fs.writeFile(path.join(srcDir, name), `{"i":${name.slice(1, 7)}}`),
      ));
    }

    const zipPath = path.join(root, 'run.zip');
    const { files: count } = await zipDirContents(srcDir, zipPath);
    assert.equal(count, n, 'writer reports all entries');

    const buf = await fs.readFile(zipPath);
    // The classic EOCD must carry the 0xFFFF entry-count sentinel, proving the
    // archive went through zip64 rather than truncating to 16 bits.
    let p = buf.length - 22;
    while (p >= 0 && buf.readUInt32LE(p) !== 0x06054b50) {
      p--;
    }
    assert.equal(buf.readUInt16LE(p + 10), 0xFFFF, 'classic EOCD holds zip64 sentinel count');

    const entries = readZip(buf);
    assert.equal(entries.size, n, 'reader recovers all entries via zip64');
    assert.equal(entries.get('c000000.json').toString('utf8'), '{"i":000000}');
    assert.equal(entries.get('c065535.json').toString('utf8'), '{"i":065535}');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
