const fs = require('fs');
const os = require('os');
const { getDepotStorage } = require('./diskUsage');
const { TOKEN_DIR } = require('./config');

const V2_ROOT = '/sys/fs/cgroup';
const V1_MEMORY_DIRS = ['/sys/fs/cgroup/memory'];
const V1_CPU_DIRS = ['/sys/fs/cgroup/cpu', '/sys/fs/cgroup/cpu,cpuacct'];
const V1_CPUACCT_DIRS = ['/sys/fs/cgroup/cpuacct', '/sys/fs/cgroup/cpu,cpuacct'];

// Debian/RHEL-family typically mount cpu+cpuacct combined; probe both
// layouts so we don't hardcode one distro's convention.
function firstExistingDir(candidates) {
  return candidates.find((dir) => fs.existsSync(dir)) || null;
}

// Docker Engine >=20.10 defaults to cgroupns=private, which makes the
// container's own cgroup root appear AT /sys/fs/cgroup directly - no
// path-walking needed. Ported from vcf-lab-toolkit's containerStats.js,
// which has the full reasoning/validation for this module.
function isCgroupV2() {
  return fs.existsSync(`${V2_ROOT}/cgroup.controllers`);
}

function readTrim(filePath) {
  return fs.readFileSync(filePath, 'utf8').trim();
}

function statField(statText, key) {
  const line = statText.split('\n').find((l) => l.startsWith(`${key} `));
  return line ? Number(line.split(' ')[1]) : 0;
}

const UNLIMITED_V1_THRESHOLD = 2 ** 62; // sentinel is ~2^63; anything near
                                          // that magnitude is "no real limit"

function buildMemory(usedBytes, limitBytes) {
  return {
    usedBytes,
    limitBytes, // null = unlimited
    usedPercent: limitBytes ? Number(((usedBytes / limitBytes) * 100).toFixed(1)) : null,
  };
}

function readMemory() {
  try {
    if (isCgroupV2()) {
      const current = Number(readTrim(`${V2_ROOT}/memory.current`));
      const maxRaw = readTrim(`${V2_ROOT}/memory.max`);
      const limitBytes = maxRaw === 'max' ? null : Number(maxRaw);
      const stat = readTrim(`${V2_ROOT}/memory.stat`);
      // docker stats only subtracts *inactive* (reclaimable) file cache,
      // not active_file - matching that keeps this number comparable.
      const usedBytes = current - statField(stat, 'inactive_file');
      return buildMemory(usedBytes, limitBytes);
    }

    const dir = firstExistingDir(V1_MEMORY_DIRS);
    if (!dir) return null;
    const current = Number(readTrim(`${dir}/memory.usage_in_bytes`));
    const limitRaw = Number(readTrim(`${dir}/memory.limit_in_bytes`));
    const limitBytes = limitRaw >= UNLIMITED_V1_THRESHOLD ? null : limitRaw;
    const stat = readTrim(`${dir}/memory.stat`);
    const usedBytes = current - statField(stat, 'total_inactive_file');
    return buildMemory(usedBytes, limitBytes);
  } catch (err) {
    return null;
  }
}

// --- CPU: needs a previous sample to compute a delta, kept module-level so
// a plain polled GET works with no background timer. ---
let previousCpuSample = null; // { atMs, usageUsec }

function readCpuUsageUsec() {
  if (isCgroupV2()) {
    return statField(readTrim(`${V2_ROOT}/cpu.stat`), 'usage_usec');
  }
  const dir = firstExistingDir(V1_CPUACCT_DIRS);
  if (!dir) throw new Error('cpuacct not found');
  const ns = Number(readTrim(`${dir}/cpuacct.usage`)); // cpuacct.usage is nanoseconds
  return ns / 1000; // normalize to usec so downstream math is version-agnostic
}

function readCpuLimitCores() {
  try {
    if (isCgroupV2()) {
      const [maxPart, periodPart] = readTrim(`${V2_ROOT}/cpu.max`).split(' ');
      return maxPart === 'max' ? null : Number(maxPart) / Number(periodPart);
    }
    const dir = firstExistingDir(V1_CPU_DIRS);
    if (!dir) return null;
    const quota = Number(readTrim(`${dir}/cpu.cfs_quota_us`));
    const period = Number(readTrim(`${dir}/cpu.cfs_period_us`));
    return quota <= 0 ? null : quota / period; // -1 = unlimited
  } catch (err) {
    return null; // limit unknown - treat as unlimited rather than failing the whole metric
  }
}

function readCpu() {
  let usageUsec;
  try {
    usageUsec = readCpuUsageUsec();
  } catch (err) {
    return null; // no usage counter available at all - nothing to report
  }

  const nowMs = Date.now();
  const limitCores = readCpuLimitCores();
  let percent = null;

  if (previousCpuSample) {
    const deltaUsec = usageUsec - previousCpuSample.usageUsec;
    const deltaMs = nowMs - previousCpuSample.atMs;
    if (deltaMs > 0 && deltaUsec >= 0) {
      const usedCores = deltaUsec / (deltaMs * 1000);
      const denominator = limitCores || os.cpus().length;
      percent = Number(((usedCores / denominator) * 100).toFixed(1));
    }
  }

  previousCpuSample = { atMs: nowMs, usageUsec };
  return { percent, limitCores };
}

// Reuses the existing depot-storage cache/statfs logic rather than
// duplicating it.
function readDepotDisk() {
  const depot = getDepotStorage();
  if (!depot) return null;
  return { ...depot, label: 'Depot' };
}

// TOKEN_DIR also holds the uploaded CLI binary and job history once in use
// (see lib/config.js) - shown as "Data" alongside the depot mount.
function readTokenDirDisk() {
  try {
    const s = fs.statfsSync(TOKEN_DIR);
    const totalBytes = s.blocks * s.bsize;
    const freeBytes = s.bavail * s.bsize;
    const usedBytes = totalBytes - s.bfree * s.bsize;
    const usedPercent = totalBytes > 0
      ? Number(((usedBytes / (usedBytes + freeBytes)) * 100).toFixed(1))
      : null;
    return { usedBytes, freeBytes, totalBytes, usedPercent, label: 'Data' };
  } catch (err) {
    return null;
  }
}

function getStats() {
  return {
    cpu: readCpu(),
    memory: readMemory(),
    disk: [readDepotDisk(), readTokenDirDisk()].filter(Boolean),
  };
}

module.exports = { getStats };
