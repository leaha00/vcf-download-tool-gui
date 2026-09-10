const fs = require('fs');
const path = require('path');
const { DEPOT_DIR } = require('./config');
const { matchesVersion } = require('./depotIndex');

// CLI >= 9.1.1 `artifacts download` writes each workload component under
// <depot>/PROD/COMP/<COMPONENT>/ - where <COMPONENT> is the internal enum
// shown in the "Component" column of `artifacts list` (SUPERVISOR_SERVICE_
// ARGOCD, SUPERVISOR_SERVICE_HARBOR, VKR, ...), NOT the friendly name. A
// component directory holds, all carrying the component-version in the
// name:
//   - <name>-<version>-<build>.json        (OCI-metadata anchor)
//   - <name>-<version>-<build>.yml/.yaml   (one or more manifests)
//   - <name>-<version>-<build>-images/     (present only when the component
//       ships OCI images) containing <bundle>.tar plus .tar.bundlesha and
//       .tar.sha256 sidecars. imgpkg writes .tar.bundlesha first and
//       .tar.sha256 last, so ".tar + .tar.sha256 both present" is the
//       "image fully pulled" signal.
//
// This is a separate scan from depotIndex.js (which is deliberately
// file-only and tuned for the binaries layout) so neither has to carry the
// other's edge cases.
const COMP_ROOT = path.join(DEPOT_DIR, 'PROD', 'COMP');
const CACHE_TTL_MS = 2 * 60 * 1000;

let cache = null; // { fetchedAt, byComponent: Map<string, CompDir> }
let inflight = null;

// CompDir: { files: string[], imageDirs: [{ name, hasTar, hasSha }] }
async function scanComp(compDir) {
  let entries;
  try {
    entries = await fs.promises.readdir(compDir, { withFileTypes: true });
  } catch (err) {
    return { files: [], imageDirs: [] };
  }

  const files = [];
  const imageDirs = [];
  // .json OCI-metadata anchors that actually reference OCI images (they name
  // the vcf.packages.broadcom.com registry). Their presence means the
  // component isn't fully downloaded until its -images dir has the tar.
  const ociJsonFiles = [];
  await Promise.all(
    entries.map(async (e) => {
      if (e.isFile()) {
        files.push(e.name);
        if (e.name.endsWith('.json')) {
          try {
            const txt = await fs.promises.readFile(path.join(compDir, e.name), 'utf8');
            if (txt.includes('packages.broadcom.com')) ociJsonFiles.push(e.name);
          } catch (err) {
            /* unreadable - treat as non-OCI */
          }
        }
        return;
      }
      if (e.isDirectory() && e.name.endsWith('-images')) {
        let inner = [];
        try {
          inner = await fs.promises.readdir(path.join(compDir, e.name));
        } catch (err) {
          inner = [];
        }
        imageDirs.push({
          name: e.name,
          hasTar: inner.some((n) => n.endsWith('.tar')),
          hasSha: inner.some((n) => n.endsWith('.tar.sha256')),
        });
      }
    })
  );
  return { files, imageDirs, ociJsonFiles };
}

async function scan() {
  const byComponent = new Map();
  let entries;
  try {
    entries = await fs.promises.readdir(COMP_ROOT, { withFileTypes: true });
  } catch (err) {
    return { fetchedAt: Date.now(), byComponent };
  }

  await Promise.all(
    entries
      .filter((e) => e.isDirectory())
      .map(async (e) => {
        byComponent.set(e.name, await scanComp(path.join(COMP_ROOT, e.name)));
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

function invalidate() {
  cache = null;
}

// 'downloaded' - metadata present, and every matching -images dir has a
//                completed .tar (+ .tar.sha256)
// 'partial'    - some but not all of the above (interrupted / in progress)
// 'none'       - nothing for this component-version on disk
function artifactState(index, component, version) {
  if (!component || !version) return 'none';
  const comp = index.byComponent.get(component);
  if (!comp) return 'none';

  // Any version-matching file that isn't a checksum sidecar counts as
  // "the component's own content is here" (json/yml manifests, or a plain
  // appliance image for e.g. DSM). Same presence-based limitation as the
  // binaries index - a half-written large file still reads as present.
  const contentFiles = comp.files.filter(
    (f) => matchesVersion(f, version) && !/\.(sha256|bundlesha)$/i.test(f)
  );
  const imageDirs = comp.imageDirs.filter((d) => matchesVersion(d.name, version));
  const ociExpected = comp.ociJsonFiles.some((f) => matchesVersion(f, version));

  if (contentFiles.length === 0 && imageDirs.length === 0) return 'none';

  // A component that declares OCI images (its .json names the registry) is
  // only "downloaded" once a matching -images dir holds the completed
  // <bundle>.tar (imgpkg writes .tar.bundlesha first, .tar.sha256 last).
  if (ociExpected) {
    const imagesComplete = imageDirs.length > 0 && imageDirs.every((d) => d.hasTar && d.hasSha);
    return contentFiles.length > 0 && imagesComplete ? 'downloaded' : 'partial';
  }

  // No OCI images declared - metadata-only, or a plain file download.
  const imagesInProgress = imageDirs.some((d) => !(d.hasTar && d.hasSha));
  return contentFiles.length > 0 && !imagesInProgress ? 'downloaded' : 'partial';
}

// Remove every file whose name carries `version` under
// <depot>/PROD/COMP/<component>/, plus any matching *-images directory.
// Flat + version-boundary matched (see matchesVersion), so it only touches
// the selected component-version and never a sibling build.
async function deleteArtifacts(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('At least one artifact is required');
  }

  const removed = [];
  const errors = [];

  for (const it of items) {
    if (!it || !it.component || !it.version) continue;
    const compDir = path.join(COMP_ROOT, it.component);

    let entries;
    try {
      entries = await fs.promises.readdir(compDir, { withFileTypes: true });
    } catch (err) {
      continue; // component dir already gone
    }

    for (const e of entries) {
      if (!matchesVersion(e.name, it.version)) continue;
      const target = path.join(compDir, e.name);
      try {
        const stat = await fs.promises.stat(target);
        await fs.promises.rm(target, { recursive: true, force: true });
        removed.push({ component: it.component, file: e.name, bytes: stat.isFile() ? stat.size : 0 });
      } catch (err) {
        if (err.code !== 'ENOENT') errors.push({ file: e.name, error: err.message });
      }
    }
  }

  return { removed, errors };
}

module.exports = { getIndex, invalidate, artifactState, deleteArtifacts, COMP_ROOT };
