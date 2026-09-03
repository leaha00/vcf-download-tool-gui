const fs = require('fs');
const { DEPOT_DIR } = require('./config');

// statfs() on the depot mount is an NFS round-trip, and under heavy write
// load (a large download in progress) it can stall for many seconds - or
// indefinitely if the mount goes stale. The synchronous form used to live
// here blocked the whole Node event loop while it waited, freezing every
// other request including static asset serving. Everything in this module
// is only ever used for dashboard storage bars where a slightly stale
// number is fine, so it must never block:
//   - keep the last known good value in a cache
//   - refresh it in the background with the async statfs, capped by a
//     timeout so a wedged mount can't pile up pending calls
//   - hand callers whatever we last knew immediately; only ever await the
//     refresh when there's no cached value at all to fall back on
const CACHE_TTL_MS = 15 * 1000;
const STATFS_TIMEOUT_MS = 3 * 1000;

let cache = null; // { fetchedAt, value } - value may be null (statfs failed)
let inflight = null;

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('statfs timed out')), ms);
    if (timer.unref) timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Raw async statfs for one path, timeout-capped. Rejects on error/timeout.
// Shared with systemStats.js's data-volume card so that one can't block
// either.
function statfs(dir, timeoutMs = STATFS_TIMEOUT_MS) {
  return withTimeout(fs.promises.statfs(dir), timeoutMs);
}

async function readDepot() {
  const stats = await statfs(DEPOT_DIR);
  const totalBytes = stats.blocks * stats.bsize;
  // bavail (available to an unprivileged process), not bfree, since that's
  // what actually limits how much more this app can write.
  const freeBytes = stats.bavail * stats.bsize;
  const usedBytes = totalBytes - stats.bfree * stats.bsize;
  return {
    totalBytes,
    usedBytes,
    freeBytes,
    usedPercent: totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 100) : 0,
  };
}

// Async, non-blocking. Returns the depot storage figures, the last cached
// value while a refresh is still running, or null if a statfs has never
// once succeeded. Never blocks the event loop; only ever awaits anything
// on the very first call before any value has been cached.
async function getDepotStorage() {
  const fresh = cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS;
  if (fresh) return cache.value;

  if (!inflight) {
    inflight = readDepot()
      .then((value) => {
        cache = { fetchedAt: Date.now(), value };
        return value;
      })
      .catch(() => {
        // Keep serving the previous value on a slow/failed refresh rather
        // than flapping to null; only report null if we never had one.
        cache = { fetchedAt: Date.now(), value: cache ? cache.value : null };
        return cache.value;
      })
      .finally(() => {
        inflight = null;
      });
  }

  // Any cached value (even expired) beats waiting on the refresh - hand it
  // over now and let the refresh land for next time.
  if (cache) return cache.value;
  return inflight;
}

module.exports = { getDepotStorage, statfs };
