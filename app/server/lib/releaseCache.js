const { runCli } = require('./cliRunner');
const { parseTable } = require('./tableParser');
const { getCliVersion } = require('./cliVersion');
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

// Nests the flat bucket list (9.1.0.x, 9.0.2.x, 9.0.1.x, 9.0.0.x, 5.2.x, ...)
// one level deeper, grouped by "family" - everything but the bucket's last
// dot-segment (9.1.0 -> 9.1, 5.0 -> 5). Dynamic (9.x) buckets are
// major.minor.patch, so their family is major.minor ("9.0.x" containing
// 9.0.0.x/9.0.1.x/9.0.2.x); legacy buckets are major.minor only, so their
// family is major ("5.x" containing 5.0.x/5.1.x/5.2.x) - same rule either
// way, no legacy-specific branching needed. A future release (9.1.1, or a
// new legacy minor) just lands in the right family automatically since
// nothing here is hardcoded - it falls out of whatever scanReleases() /
// scanLegacyReleases() already discovered.
//
// Input is already sorted newest-bucket-first; since two buckets only share
// a family when they agree on every segment but the last, families stay
// contiguous in that order, so a single left-to-right pass preserves
// newest-family-first without a second sort.
function groupIntoFamilies(flatReleases) {
  const families = [];
  const byFamily = new Map();
  for (const group of flatReleases) {
    const segments = group.bucket.split('.');
    const family = segments.slice(0, -1).join('.');
    let entry = byFamily.get(family);
    if (!entry) {
      entry = { family, label: `${family}.x`, groups: [] };
      byFamily.set(family, entry);
      families.push(entry);
    }
    entry.groups.push(group);
  }
  return families;
}

// --- CLI >= 9.1.1: `releases list` ----------------------------------------
//
// 9.1.1.0 changed `binaries list` so any --vcf-version range (9.0..) now
// collapses to the newest build per component - verified against the CLI -
// which left the anchor scan above only ever able to see the latest release
// line. The same CLI added a top-level `releases list` subcommand that
// prints every VCF release line (a.b.c.d, always d=0), newest first, from
// 5.0 onward. Older CLIs (9.1.0.x) don't have it, but the anchor scan still
// works for them, so the path is chosen by installed CLI version - with a
// fallback to the anchor scan if `releases list` fails for any reason.
//
// Only release *lines* are available this way, not individual patch builds
// (9.1.0.0100/0200/...) - the new CLI won't list those for INSTALL under
// any flag combination anyway.
const RELEASES_LIST_MIN_CLI = '9.1.1';
const RELEASE_FLOOR = '5.0.0.0'; // `releases list` also emits 4.x; the GUI has only ever covered 5.0+

async function scanViaReleasesList() {
  const { stdout } = await runCli([
    'releases',
    'list',
    `--depot-download-activation-code-file=${TOKEN_FILE}`,
  ]);

  const versions = stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^\d+\.\d+\.\d+\.\d+$/.test(l)) // the CLI banner/status lines don't match
    .filter((v) => compareVersions(v, RELEASE_FLOOR) >= 0)
    .sort((a, b) => compareVersions(b, a)); // newest first, don't trust CLI ordering

  if (versions.length === 0) {
    throw new Error('`releases list` returned no recognisable versions');
  }

  // Normalise each release line into the {bucket,label,versions} shape the
  // anchor/legacy scans produce so groupIntoFamilies + the renderer work
  // unchanged: 9.x -> bucket a.b.c (family a.b), pre-9.0 -> bucket a.b
  // (family a), matching the old hardcoded 5.x behaviour. One leaf per
  // bucket, keyed to the bucket itself so it renders as a plain leaf.
  const seen = new Set();
  const groups = [];
  for (const v of versions) {
    const is9x = compareVersions(v, '9.0.0.0') >= 0;
    const bucket = v.split('.').slice(0, is9x ? 3 : 2).join('.');
    if (seen.has(bucket)) continue;
    seen.add(bucket);
    groups.push({
      bucket,
      label: `${bucket}.x`,
      versions: [{ vcfVersion: bucket, bucket, releaseDate: null }],
    });
  }

  return groupIntoFamilies(groups);
}

async function scanAllReleases() {
  const cliVersion = await getCliVersion();
  if (cliVersion && compareVersions(cliVersion, RELEASES_LIST_MIN_CLI) >= 0) {
    try {
      return await scanViaReleasesList();
    } catch (err) {
      // fall through to the anchor scan
    }
  }

  const [dynamic, legacy] = await Promise.all([scanReleases(), scanLegacyReleases()]);
  return groupIntoFamilies([...dynamic, ...legacy]);
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
