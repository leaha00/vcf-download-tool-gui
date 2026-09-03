const path = require('path');
const fsp = require('fs/promises');
const { runCli } = require('./cliRunner');
const { parseTable } = require('./tableParser');
const { matchesVersion, isExcludedFor, COMP_ROOT } = require('./depotIndex');
const { TOKEN_FILE } = require('./config');

async function queryVersion(version, sku, types) {
  const results = await Promise.all(
    types.map((t) =>
      runCli([
        'binaries',
        'list',
        `--depot-download-activation-code-file=${TOKEN_FILE}`,
        `--vcf-version=${version}`,
        `--sku=${sku}`,
        `--type=${t}`,
      ]).then((r) => parseTable(r.stdout))
    )
  );

  const byId = new Map();
  for (const rows of results) {
    for (const row of rows) byId.set(row.id, row);
  }
  return [...byId.values()];
}

// The CLI only reliably supports exact a.b.c.d pinning for GA releases
// (d=0); async patch builds (a.b.c.0100, .0200, ...) are incremental
// updates layered onto the a.b.c family rather than standalone install
// targets, and querying them exactly returns zero rows even though the
// same build shows up fine in the a.b.c family listing. Fall back to the
// 3-part family query when an exact 4-part query comes back empty so the
// GUI still shows something useful instead of a blank table.
async function listBinaries({ version, sku = 'VCF', type = 'BOTH' }) {
  if (!version) throw new Error('version is required');
  const types = type === 'BOTH' ? ['INSTALL', 'UPGRADE'] : [type];

  const binaries = await queryVersion(version, sku, types);
  if (binaries.length > 0) {
    return { binaries, queriedVersion: version, fellBackToFamily: false };
  }

  const parts = version.split('.');
  if (parts.length >= 4) {
    const family = parts.slice(0, 3).join('.');
    const familyBinaries = await queryVersion(family, sku, types);
    if (familyBinaries.length > 0) {
      return { binaries: familyBinaries, queriedVersion: family, fellBackToFamily: true };
    }
  }

  return { binaries: [], queriedVersion: version, fellBackToFamily: false };
}

// Deleting downloaded binaries is pure local-disk work - the CLI's own
// `binaries cleanup` needs no depot auth for it either (its own help says
// so). Doing it with `fs` instead of spawning the CLI keeps it off the
// single global CLI lock (see cliRunner.js), so "free up space" still works
// while a large download is in progress - which is exactly when you need it.
//
// Files are matched the same way depotIndex.isDownloaded decides a binary
// shows as downloaded: top-level artifacts in <depot>/PROD/COMP/<COMPONENT>/
// whose name carries the 4-part vcf-version (boundary-checked - see
// matchesVersion) and isn't excluded for the row's INSTALL/UPGRADE type. So
// a delete flips exactly the rows the UI marked "downloaded" back to not,
// and nothing else. Deliberately flat, not recursive: some components nest
// an internal per-build RPM mirror many levels down whose sub-packages
// carry unrelated version numbers (the reason depotIndex's scan is flat
// too) - recursing risks deleting a file that belongs to a different build.
async function deleteBinaries(binaries) {
  if (!Array.isArray(binaries) || binaries.length === 0) {
    throw new Error('At least one binary is required');
  }

  const removed = [];
  const errors = [];

  for (const b of binaries) {
    if (!b || !b.component || !b.version) continue;
    const compDir = path.join(COMP_ROOT, b.component);

    let entries;
    try {
      entries = await fsp.readdir(compDir, { withFileTypes: true });
    } catch (err) {
      continue; // component dir gone already - nothing on disk to remove
    }

    const vcfVersion = String(b.version).split('.').slice(0, 4).join('.');
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!matchesVersion(entry.name, vcfVersion)) continue;
      if (isExcludedFor(b.component, b.type, entry.name)) continue;

      const filePath = path.join(compDir, entry.name);
      try {
        const { size } = await fsp.stat(filePath);
        await fsp.unlink(filePath);
        removed.push({ component: b.component, file: entry.name, bytes: size });
      } catch (err) {
        if (err.code !== 'ENOENT') errors.push({ file: entry.name, error: err.message });
      }
    }
  }

  return { removed, errors };
}

module.exports = { listBinaries, deleteBinaries };
