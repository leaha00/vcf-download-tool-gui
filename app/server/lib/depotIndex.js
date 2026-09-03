const fs = require('fs');
const path = require('path');
const { DEPOT_DIR } = require('./config');

// Downloads land under <depot-store>/PROD/COMP/<COMPONENT>/... and every
// top-level filename the CLI writes embeds the exact "Version" string shown
// by `binaries list` (e.g. "Operations-Appliance-9.1.0.0.25346025.ova" for
// version "9.1.0.0.25346025"). There's no separate download-status index
// file to read, so we list what's actually on disk per component and match
// version strings against those names.
//
// Deliberately NOT recursive: some components (vCenter in particular) ship
// an internal per-build RPM repo mirror nested several levels down
// (vmw/<uuid>/<version>/package-pool/*.rpm), where individual packages
// carry their own unrelated internal version numbers. Recursing into that
// produced a real false positive - a sub-package inside the 9.1.0.0300
// patch bundle happened to be named "...9.1.0.0200-118136...rpm", making
// 9.1.0.0200 look downloaded when it wasn't. Every legitimate top-level
// artifact (iso/ova/zip/pak/tgz/...) lives directly in the component's own
// directory, so a flat listing is both sufficient and safe.
const COMP_ROOT = path.join(DEPOT_DIR, 'PROD', 'COMP');
const CACHE_TTL_MS = 2 * 60 * 1000;

let cache = null; // { fetchedAt, byComponent: Map<string, string[]> }
let inflight = null;

async function scan() {
  const byComponent = new Map();

  let entries;
  try {
    entries = await fs.promises.readdir(COMP_ROOT, { withFileTypes: true });
  } catch (err) {
    // Depot store not populated yet, or not mounted - nothing downloaded.
    return { fetchedAt: Date.now(), byComponent };
  }

  await Promise.all(
    entries
      .filter((e) => e.isDirectory())
      .map(async (e) => {
        const compDir = path.join(COMP_ROOT, e.name);
        try {
          const files = await fs.promises.readdir(compDir, { withFileTypes: true });
          byComponent.set(
            e.name,
            files.filter((f) => f.isFile()).map((f) => f.name)
          );
        } catch (err) {
          byComponent.set(e.name, []);
        }
      })
  );

  return { fetchedAt: Date.now(), byComponent };
}

async function getIndex({ forceRefresh = false } = {}) {
  const fresh = cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS;
  if (fresh && !forceRefresh) return cache;

  if (!inflight) {
    inflight = scan().finally(() => {
      inflight = null;
    });
  }
  cache = await inflight;
  return cache;
}

// The catalog's "Version" string is <vcf-version>.<catalog build id>, e.g.
// "9.1.0.0400.25541561" - but that trailing catalog build id doesn't always
// match the build id actually baked into the downloaded filename (seen in
// the wild: catalog said "...0400.25541561", the real file on disk was
// "Operations-Upgrade-9.1.0.0400.25541550.pak" - a different build id for
// the same nominal release). Match on just the 4-part vcf-version instead
// of the full catalog string so drift in that trailing id doesn't produce
// a false "not downloaded".
//
// A vcf-version substring alone isn't enough to tell INSTALL and PATCH
// apart though, since both rows share the same version string and the
// underlying artifacts can be genuinely different files. Packaging
// convention varies by component/vendor team, confirmed from real depot
// content:
//   - VROPS/NSX/SDDC Manager-style: OVA = install, .pak/.mub/.pub = upgrade.
//   - VCENTER: install is an .iso; the patch bundle ships an .ova *plus*
//     zips (e.g. an "-updaterepo.zip" and a "vlcm-operator...zip") - the
//     opposite of the default OVA=install assumption.
// Components not listed have no known type-exclusive extension (e.g.
// Salt's plain .tgz, used for both) and are matched on version alone.
const DEFAULT_RULE = { installExt: ['.ova', '.ovf'], upgradeExt: ['.pak', '.mub', '.pub'] };
const TYPE_EXTENSION_RULES = {
  VCENTER: { installExt: ['.iso'], upgradeExt: ['.ova', '.zip'] },
};

function isExcludedFor(component, type, filename) {
  const rule = TYPE_EXTENSION_RULES[component] || DEFAULT_RULE;
  const lower = filename.toLowerCase();
  if (type === 'INSTALL') {
    return rule.upgradeExt.some((ext) => lower.endsWith(ext)) || lower.includes('upgrade');
  }
  if (type === 'PATCH' || type === 'UPGRADE') {
    return rule.installExt.some((ext) => lower.endsWith(ext));
  }
  return false;
}

// A bare `filename.includes(vcfVersion)` substring test is too loose: the
// GA string "9.1.0.0" is a substring of every "9.1.0.0100"/"0200"/... patch
// filename, so a GA row would look downloaded whenever any patch of that
// family was on disk (and, worse, a fs-based delete of the GA would match
// the patch files). Require the version to be followed by a real separator
// - "." before the trailing build id, or "-"/"_" - so "9.1.0.0" matches
// "...-9.1.0.0.25346025.ova" but not "...-9.1.0.0400.25541550.pak".
function matchesVersion(filename, vcfVersion) {
  let from = 0;
  for (;;) {
    const i = filename.indexOf(vcfVersion, from);
    if (i === -1) return false;
    const next = filename[i + vcfVersion.length];
    if (next === '.' || next === '-' || next === '_' || next === undefined) return true;
    from = i + 1;
  }
}

function isDownloaded(index, component, version, type) {
  if (!version) return false;
  const files = index.byComponent.get(component);
  if (!files || files.length === 0) return false;
  const vcfVersion = version.split('.').slice(0, 4).join('.');
  const candidates = files.filter((f) => matchesVersion(f, vcfVersion));
  return candidates.some((f) => !isExcludedFor(component, type, f));
}

function invalidate() {
  cache = null;
}

module.exports = { getIndex, isDownloaded, invalidate, matchesVersion, isExcludedFor, COMP_ROOT };
