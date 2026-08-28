const fs = require('fs');
const path = require('path');
const { DEPOT_DIR } = require('./config');

class DepotPathError extends Error {}

// Resolves a client-supplied relative path against DEPOT_DIR, refusing to
// leave it. path.resolve() alone already collapses ".." segments correctly,
// so the prefix check below is the authoritative guard - the literal ".."
// check is just a cheap fast-path. Symlinks are checked separately via
// realpath since resolve()/the prefix check operate on the un-followed path.
function resolveSafePath(relativePath) {
  const decoded = decodeURIComponent(relativePath || '');
  if (decoded.split(/[/\\]/).includes('..')) {
    throw new DepotPathError('Path escapes the depot root.');
  }

  const resolved = path.resolve(DEPOT_DIR, '.' + path.sep + decoded);
  if (resolved !== DEPOT_DIR && !resolved.startsWith(DEPOT_DIR + path.sep)) {
    throw new DepotPathError('Path escapes the depot root.');
  }

  let real;
  try {
    real = fs.realpathSync(resolved);
  } catch (err) {
    // Doesn't exist yet - nothing to symlink-check, the caller's stat/readdir
    // call will surface the not-found error.
    return resolved;
  }
  if (real !== DEPOT_DIR && !real.startsWith(DEPOT_DIR + path.sep)) {
    throw new DepotPathError('Path escapes the depot root (symlink).');
  }
  return resolved;
}

// Non-recursive by design, same as depotIndex.js's scan - callers walk one
// level at a time rather than this module trying to enumerate the whole
// tree (some components nest large internal RPM-repo mirrors many levels
// down that a depot browser has no reason to flatten).
async function listDir(relativePath) {
  const resolved = resolveSafePath(relativePath);
  const entries = await fs.promises.readdir(resolved, { withFileTypes: true });
  const visible = entries.filter((e) => !e.name.startsWith('.'));

  return Promise.all(
    visible.map(async (entry) => {
      const stat = await fs.promises.stat(path.join(resolved, entry.name));
      return {
        name: entry.name,
        isDir: entry.isDirectory(),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      };
    })
  );
}

// Recursive size total for a directory - deliberately not part of listDir
// (see the "non-recursive by design" note above: some components nest large
// internal RPM-repo mirrors many levels down). Callers only pay this cost
// when a browser actually asks for one directory's size, and results are
// cached briefly per resolved path so repeat requests within the TTL don't
// re-walk the tree. Symlinks are skipped rather than followed, same
// cycle/escape concern as resolveSafePath's realpath check.
const DIR_SIZE_CACHE_TTL_MS = 5 * 60 * 1000;
const dirSizeCache = new Map(); // resolvedPath -> { value, computedAt }

async function walkSize(dirPath) {
  let entries;
  try {
    entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
  } catch (err) {
    return 0;
  }

  // Each branch returns its own contribution rather than mutating a shared
  // running total - accumulating into a closed-over variable across `await`
  // points races, since `total += await x` reads `total` before suspending
  // and clobbers concurrent siblings' updates on resume.
  const sizes = await Promise.all(
    entries.map(async (entry) => {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) return 0;
      const entryPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        return walkSize(entryPath);
      }
      try {
        const stat = await fs.promises.stat(entryPath);
        return stat.size;
      } catch (err) {
        // Vanished or unreadable mid-walk - just skip it.
        return 0;
      }
    })
  );
  return sizes.reduce((sum, size) => sum + size, 0);
}

async function getDirSize(relativePath) {
  const resolved = resolveSafePath(relativePath);

  const cached = dirSizeCache.get(resolved);
  if (cached && Date.now() - cached.computedAt < DIR_SIZE_CACHE_TTL_MS) {
    return cached.value;
  }

  const value = await walkSize(resolved);
  dirSizeCache.set(resolved, { value, computedAt: Date.now() });
  return value;
}

module.exports = { DepotPathError, resolveSafePath, listDir, getDirSize };
