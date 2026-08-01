const { runCli } = require('./cliRunner');
const { parseTable } = require('./tableParser');
const {
  TOKEN_FILE,
  RELEASE_SCAN_START,
  LEGACY_RELEASE_VERSIONS,
  RELEASE_CACHE_TTL_MS,
} = require('./config');

// SDDC_MANAGER_VCF's own component version tracks the VCF release version
// 1:1 (e.g. row version "9.1.0.0100.25428926" == vcf-version "9.1.0.0100",
// plus a trailing build number). Scanning just this one component against
// an open-ended range ("9.0..") is enough to discover every released VCF
// version without hardcoding anything - new releases show up automatically
// next time the cache refreshes.
const ANCHOR_COMPONENT = 'SDDC_MANAGER_VCF';

let cache = null; // { fetchedAt, releases }
let inflight = null;

function versionSortKey(v) {
  return v.split('.').map((n) => parseInt(n, 10) || 0);
}

function compareVersions(a, b) {
  const ka = versionSortKey(a);
  const kb = versionSortKey(b);
  for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
    const diff = (ka[i] || 0) - (kb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

async function scanReleases() {
  const { stdout } = await runCli([
    'binaries',
    'list',
    `--depot-download-activation-code-file=${TOKEN_FILE}`,
    `--vcf-version=${RELEASE_SCAN_START}..`,
    '--sku=VCF',
    '--type=INSTALL',
    `--component=${ANCHOR_COMPONENT}`,
  ]);

  const rows = parseTable(stdout);

  // "9.1.0.0100.25428926" -> vcfVersion "9.1.0.0100", releaseDate, build "25428926"
  const versions = new Map();
  for (const row of rows) {
    const full = row.version || '';
    const parts = full.split('.');
    if (parts.length < 5) continue; // not the a.b.c.d.build shape we expect
    const vcfVersion = parts.slice(0, 4).join('.');
    const bucket = parts.slice(0, 3).join('.');
    versions.set(vcfVersion, {
      vcfVersion,
      bucket,
      releaseDate: row.release_date || null,
    });
  }

  const byBucket = new Map();
  for (const v of versions.values()) {
    if (!byBucket.has(v.bucket)) byBucket.set(v.bucket, []);
    byBucket.get(v.bucket).push(v);
  }

  const releases = [...byBucket.entries()]
    .map(([bucket, vs]) => ({
      bucket,
      label: `${bucket}.x`,
      versions: vs.sort((a, b) => compareVersions(a.vcfVersion, b.vcfVersion)),
    }))
    .sort((a, b) => compareVersions(a.bucket, b.bucket))
    .reverse(); // newest release family first

  for (const r of releases) {
    r.versions.reverse(); // newest patch first within a family
  }

  return releases;
}

// Pre-9.0 releases have no anchor component to scan with (see
// LEGACY_RELEASE_VERSIONS in config.js), so each hardcoded major.minor is
// checked directly instead - the same query a manual "5.2" search runs,
// just used to confirm the release exists rather than to list its binaries.
// One release group per version, since there's no way to discover
// individual patch builds (a.b.c.0100, ...) within it the way the dynamic
// scan does for 9.x.
async function scanLegacyReleases() {
  const checks = await Promise.all(
    LEGACY_RELEASE_VERSIONS.map(async (version) => {
      const { stdout } = await runCli([
        'binaries',
        'list',
        `--depot-download-activation-code-file=${TOKEN_FILE}`,
        `--vcf-version=${version}`,
        '--sku=VCF',
        '--type=INSTALL',
      ]);
      const exists = parseTable(stdout).length > 0;
      return { version, exists };
    })
  );

  return checks
    .filter((c) => c.exists)
    .sort((a, b) => compareVersions(a.version, b.version))
    .reverse() // newest legacy family first, matching the dynamic list
    .map(({ version }) => ({
      bucket: version,
      label: `${version}.x`,
      versions: [{ vcfVersion: version, bucket: version, releaseDate: null }],
    }));
}

async function scanAllReleases() {
  const [dynamic, legacy] = await Promise.all([scanReleases(), scanLegacyReleases()]);
  return [...dynamic, ...legacy];
}

async function getReleases({ forceRefresh = false } = {}) {
  const fresh = cache && Date.now() - cache.fetchedAt < RELEASE_CACHE_TTL_MS;
  if (fresh && !forceRefresh) {
    return { releases: cache.releases, fetchedAt: cache.fetchedAt, cached: true };
  }

  if (!inflight) {
    inflight = scanAllReleases()
      .then((releases) => {
        cache = { releases, fetchedAt: Date.now() };
        return cache;
      })
      .finally(() => {
        inflight = null;
      });
  }

  const result = await inflight;
  return { releases: result.releases, fetchedAt: result.fetchedAt, cached: false };
}

module.exports = { getReleases };
