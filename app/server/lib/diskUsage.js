const fs = require('fs');
const { DEPOT_DIR } = require('./config');

// Cheap syscall, but avoid hammering it on every poll tick regardless.
const CACHE_TTL_MS = 15 * 1000;

let cache = null; // { fetchedAt, value }

function getDepotStorage() {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.value;
  }

  let value = null;
  try {
    const stats = fs.statfsSync(DEPOT_DIR);
    const totalBytes = stats.blocks * stats.bsize;
    // bavail (available to an unprivileged process), not bfree, since that's
    // what actually limits how much more this app can write.
    const freeBytes = stats.bavail * stats.bsize;
    const usedBytes = totalBytes - stats.bfree * stats.bsize;
    value = {
      totalBytes,
      usedBytes,
      freeBytes,
      usedPercent: totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 100) : 0,
    };
  } catch (err) {
    value = null;
  }

  cache = { fetchedAt: Date.now(), value };
  return value;
}

module.exports = { getDepotStorage };
