const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { DEPOT_DIR } = require('./config');

// The CLI writes Broadcom's own product version catalog into the depot on
// every `binaries download` (PROD/metadata/productVersionCatalog/v1/). Each
// file Broadcom publishes is listed there with its exact byte size and a
// SHA-256 ("fileName"/"size"/"checksum"), so a downloaded file can be
// checked against Broadcom's numbers without us carrying any manifest of
// our own. The catalog only describes what Broadcom ships - files someone
// dropped into the depot by hand (old 8.x ISOs etc.) simply aren't in it
// and are never flagged.
//
// The CLI reports "downloaded" on a clean exit and the depot index treats
// any matching filename as downloaded, so before this module a short file
// (interrupted copy, full volume, NFS hiccup) looked identical to a good
// one until something tried to use it.
const CATALOG_FILE = path.join(DEPOT_DIR, 'PROD', 'metadata', 'productVersionCatalog', 'v1', 'productVersionCatalog.json');

let cached = null; // { mtimeMs, files: Map<fileName, { size, checksum }> }

function collect(node, files) {
  if (Array.isArray(node)) {
    for (const n of node) collect(n, files);
  } else if (node && typeof node === 'object') {
    if (typeof node.fileName === 'string' && Number.isFinite(node.size)) {
      const entry = {
        size: node.size,
        checksum: typeof node.checksum === 'string' ? node.checksum.toLowerCase() : null,
      };
      const prev = files.get(node.fileName);
      if (!prev) files.set(node.fileName, entry);
      // Generic names (items.json, lib.json, ...) are reused by many bundles
      // with different contents, so the name alone says nothing about which
      // size is right. Mark the name ambiguous and drop it afterwards rather
      // than flag a healthy file.
      else if (prev.size !== entry.size || prev.checksum !== entry.checksum) prev.ambiguous = true;
    }
    for (const v of Object.values(node)) collect(v, files);
  }
}

// Parsed once per catalog revision (keyed on mtime) - it is ~1.5 MB and the
// depot index consults it on every rescan. Fail-soft: a missing/corrupt
// catalog (nothing downloaded yet, depot not mounted) just means "no
// reference numbers", never an error.
async function getCatalog() {
  try {
    const { mtimeMs } = await fsp.stat(CATALOG_FILE);
    if (cached && cached.mtimeMs === mtimeMs) return cached.files;
    const files = new Map();
    collect(JSON.parse(await fsp.readFile(CATALOG_FILE, 'utf8')), files);
    for (const [name, entry] of files) if (entry.ambiguous) files.delete(name);
    cached = { mtimeMs, files };
    return files;
  } catch (err) {
    return new Map();
  }
}

function sha256File(filePath, onProgress, totalBytes) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    let read = 0;
    let lastPct = -1;
    const stream = fs.createReadStream(filePath, { highWaterMark: 4 * 1024 * 1024 });
    stream.on('data', (chunk) => {
      hash.update(chunk);
      read += chunk.length;
      if (onProgress && totalBytes) {
        const pct = Math.floor((read / totalBytes) * 4) * 25; // 0/25/50/75/100
        if (pct !== lastPct) {
          lastPct = pct;
          onProgress(pct);
        }
      }
    });
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

// Verify one on-disk file against the catalog. Size is compared first
// (instant, and it is the failure that actually happens - a truncated file),
// the SHA-256 only when the size matches.
// Returns { status: 'ok' | 'size-mismatch' | 'checksum-mismatch' | 'unknown',
//           actualSize, expectedSize }
async function verifyFile(filePath, catalog, onProgress) {
  const ref = catalog.get(path.basename(filePath));
  const { size } = await fsp.stat(filePath);
  if (!ref) return { status: 'unknown', actualSize: size };
  if (size !== ref.size) {
    return { status: 'size-mismatch', actualSize: size, expectedSize: ref.size };
  }
  if (!ref.checksum) return { status: 'ok', actualSize: size, expectedSize: ref.size, hashed: false };
  const digest = await sha256File(filePath, onProgress, size);
  if (digest !== ref.checksum) {
    return { status: 'checksum-mismatch', actualSize: size, expectedSize: ref.size };
  }
  return { status: 'ok', actualSize: size, expectedSize: ref.size, hashed: true };
}

module.exports = { getCatalog, verifyFile, sha256File, CATALOG_FILE };
