const { runCli } = require('./cliRunner');
const { parseTable } = require('./tableParser');
const { TOKEN_FILE, DEPOT_DIR } = require('./config');

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

// `cleanup` only touches local disk under --depot-store - no depot auth
// needed, unlike list/download.
async function deleteBinaries(ids) {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new Error('At least one binary id is required');
  }
  const { stdout } = await runCli(
    ['binaries', 'cleanup', `--id=${ids.join(',')}`, `--depot-store=${DEPOT_DIR}`],
    { requireToken: false }
  );
  return stdout;
}

module.exports = { listBinaries, deleteBinaries };
