const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');
const { streamCli } = require('./cliRunner');
const { TOKEN_FILE, DEPOT_DIR, DOWNLOAD_LOGS_DIR } = require('./config');
const depotIndex = require('./depotIndex');
const artifactsIndex = require('./artifactsIndex');
const jobStore = require('./jobStore');
const { parseSize } = require('./sizeUtils');
const integrity = require('./integrity');
const { COMP_ROOT } = require('./depotIndex');
const { parseTable } = require('./tableParser');

const MAX_LINES = 500; // live-log tail kept in memory for the SSE modal - not persisted

// Live, in-process-only state for jobs currently streaming (the structured
// status/history lives in jobStore; this is just the raw log + emitter for
// whoever has the download modal open).
const liveJobs = new Map();

const PROGRESS_RE = /^Download Progress of\s*:\s*(.+?)\s*:\s*([\d.]+)\s*MB/;

// opts (all optional):
//   mode: 'binaries' (default) | 'artifacts' | 'esx' | 'verify'
//         ('verify' re-checks already-downloaded binaries against Broadcom's
//         catalog sizes/SHA-256 - no CLI involved, see verifyBinaries)
//   sku, vcfVersion: required for 'artifacts'
//   filter: { category } or { component } - required for 'artifacts'
function startDownload(ids, binaries, opts = {}) {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new Error('At least one binary id is required');
  }

  const mode =
    opts.mode === 'artifacts' ? 'artifacts' : opts.mode === 'esx' ? 'esx' : opts.mode === 'verify' ? 'verify' : 'binaries';

  const job = jobStore.createJob(binaries);
  const jobId = job.id;

  const emitter = new EventEmitter();
  const lines = [];
  liveJobs.set(jobId, { lines, emitter });

  // Persists the raw log alongside the in-memory tail so it survives past
  // the liveJobs TTL and a container restart - see routes.js's SSE endpoint,
  // which falls back to reading this file once a job is no longer live.
  const logStream = fs.createWriteStream(path.join(DOWNLOAD_LOGS_DIR, `${jobId}.log`), { flags: 'a' });
  logStream.on('error', () => {}); // best-effort - must never take the download down with it

  const emit = (line) => {
    lines.push(line);
    if (lines.length > MAX_LINES) lines.shift();
    emitter.emit('line', line);
    try {
      logStream.write(`${line}\n`);
    } catch (err) {
      // ignore - best-effort persistence only
    }
  };

  const finish = (code) => {
    jobStore.finishJob(jobId, { status: code === 0 ? 'complete' : 'error', exitCode: code });
    if (mode === 'verify') {
      emit(code === 0 ? 'Verification complete.' : 'Verification failed - see the files flagged above.');
    } else {
      emit(code === 0 ? 'Download complete.' : `Download failed (exit code ${code}).`);
    }
    if (code === 0) {
      depotIndex.invalidate();
      artifactsIndex.invalidate();
    }
    logStream.end();
    emitter.emit('done');
    scheduleCleanup(jobId);
    pruneOrphanLogs();
  };

  const runner =
    mode === 'artifacts'
      ? runArtifactsDownload(jobId, binaries, opts, emit)
      : mode === 'esx'
        ? runEsxDownload(jobId, binaries, emit)
        : mode === 'verify'
          ? Promise.resolve(0) // statuses are set by verifyBinaries below
          : runBinariesDownload(jobId, ids, binaries, emit);

  runner
    .then(async (code) => {
      if (mode === 'verify') {
        const failed = await verifyBinaries(jobId, binaries, emit);
        return failed.size > 0 ? 1 : 0;
      }
      if (mode === 'binaries') finalizeBinaryStatuses(jobId, binaries, lines, code);
      if (mode === 'binaries' && code === 0) {
        // The CLI exiting 0 only means it thinks it's finished - a short file
        // would still pass. Check what landed against Broadcom's catalog.
        const failed = await verifyBinaries(jobId, binaries, emit);
        if (failed.size > 0) return 1;
      }
      return code;
    })
    .then((code) => {
      if (mode === 'esx') finalizeEsxStatus(jobId, binaries, code);
      finish(code);
    })
    .catch((err) => {
      if (mode === 'binaries') finalizeBinaryStatuses(jobId, binaries, lines, -1);
      else markRemainingFailed(jobId, binaries);
      emit(`Failed to start download: ${err.message}`);
      finish(-1);
    });

  return jobId;
}

// --- binaries download (the CLI's `binaries download --id=...`) -----------
// Unchanged behaviour: one CLI invocation for the whole selection, with
// per-binary progress attributed by matching the version string in each
// downloaded filename.
function runBinariesDownload(jobId, ids, binaries, emit) {
  // Per-binary progress tracking. A binary/bundle can span several files
  // (tgz, yaml manifest, config schema, ...) and the CLI only reports
  // cumulative bytes per *file*, not per bundle - sum every file we've seen
  // for a given binary against its declared total size.
  const totalBytesById = new Map();
  for (const b of binaries) totalBytesById.set(b.id, parseSize(b.size));
  const fileBytes = new Map(); // filename -> cumulative bytes
  const fileBinary = new Map(); // filename -> binary id

  const handleProgress = (line) => {
    const m = PROGRESS_RE.exec(line);
    if (!m) return;
    const [, filename, mb] = m;
    fileBytes.set(filename, parseFloat(mb) * 1_000_000);

    let binaryId = fileBinary.get(filename);
    if (!binaryId) {
      const match = binaries.find((b) => b.version && filename.includes(b.version));
      if (!match) return;
      binaryId = match.id;
      fileBinary.set(filename, binaryId);
    }

    const totalBytes = totalBytesById.get(binaryId);
    if (!totalBytes) return;

    let downloaded = 0;
    for (const [f, bid] of fileBinary) {
      if (bid === binaryId) downloaded += fileBytes.get(f) || 0;
    }

    const percent = Math.min(99, Math.round((downloaded / totalBytes) * 100));
    jobStore.updateBinaryStatus(jobId, binaryId, { status: 'downloading', percent });
  };

  emit(`Starting download of ${ids.length} binaries to ${DEPOT_DIR} ...`);

  return streamCli(
    [
      'binaries',
      'download',
      `--depot-download-activation-code-file=${TOKEN_FILE}`,
      `--id=${ids.join(',')}`,
      `--depot-store=${DEPOT_DIR}`,
    ],
    (line) => {
      emit(line);
      handleProgress(line);
    }
  ).then((child) => new Promise((resolve) => child.on('close', (code) => resolve(code ?? -1))));
}

// --- artifacts download (CLI >= 9.1.1 `artifacts download`) --------------
// The artifacts command's filters (--category / --component) plus
// --component-version pin one workload-component build at a time, so a
// multi-select is run as a sequence of CLI invocations - one per selected
// row - rather than a single --id list. Each still shares the global CLI
// lock (streamCli), so a list/other download queues behind the whole batch.
async function runArtifactsDownload(jobId, binaries, opts, emit) {
  const sku = opts.sku || 'VCF';
  const vcfVersion = opts.vcfVersion;
  const filter = opts.filter || {};
  if (!vcfVersion) throw new Error('vcfVersion is required for artifact downloads');
  if (!filter.category && !filter.component) {
    throw new Error('an artifact category or component is required');
  }

  emit(
    `Starting download of ${binaries.length} artifact${binaries.length === 1 ? '' : 's'} to ${DEPOT_DIR} ...`
  );

  let anyFailed = false;
  for (const b of binaries) {
    jobStore.updateBinaryStatus(jobId, b.id, { status: 'downloading', percent: 0 });
    const label = b.component_full_name || b.fullName || b.component || 'artifact';
    emit(`\n--- ${label} ${b.version} ---`);

    const args = [
      'artifacts',
      'download',
      `--depot-download-activation-code-file=${TOKEN_FILE}`,
      `--sku=${sku}`,
      `--vcf-version=${vcfVersion}`,
      `--depot-store=${DEPOT_DIR}`,
      `--component-version=${b.version}`,
    ];
    if (filter.category) args.push(`--category=${filter.category}`);
    if (filter.component) args.push(`--component=${filter.component}`);

    const total = parseSize(b.size);
    const onLine = (line) => {
      emit(line);
      const m = PROGRESS_RE.exec(line);
      if (!m || !total) return;
      const mb = parseFloat(m[2]);
      const percent = Math.min(99, Math.round(((mb * 1_000_000) / total) * 100));
      jobStore.updateBinaryStatus(jobId, b.id, { status: 'downloading', percent });
    };

    let code;
    try {
      const child = await streamCli(args, onLine);
      code = await new Promise((resolve) => child.on('close', (c) => resolve(c ?? -1)));
    } catch (err) {
      emit(`Error: ${err.message}`);
      code = -1;
    }

    const ok = code === 0;
    jobStore.updateBinaryStatus(jobId, b.id, {
      status: ok ? 'done' : 'failed',
      percent: ok ? 100 : undefined,
    });
    emit(ok ? 'Artifact download complete.' : `Artifact download failed (exit code ${code}).`);
    if (!ok) anyFailed = true;
  }

  return anyFailed ? 1 : 0;
}

// --- esx download (base images + IOVP drivers + vendor add-ons + Tools) --
// `esx download` has no per-item selection at all - no --vcf-version, no
// --id (confirmed against the CLI's own --help). What it pulls is governed
// entirely by `esx configuration` (enable-host/disable-host), which
// routes.js already synced before starting this job. So this is always a
// single CLI invocation with one synthetic "binary" row standing in for
// the whole depot - there's no per-file declared total to compute a
// percent against, so the row just flips pending -> downloading -> done/
// failed rather than showing a progress bar.
function runEsxDownload(jobId, binaries, emit) {
  emit(
    `Starting ESX depot download (base images, IOVP drivers, vendor add-ons, VMware Tools) to ${DEPOT_DIR} ...`
  );

  return streamCli(
    [
      'esx',
      'download',
      `--depot-download-activation-code-file=${TOKEN_FILE}`,
      `--depot-store=${DEPOT_DIR}`,
    ],
    emit
  ).then((child) => new Promise((resolve) => child.on('close', (code) => resolve(code ?? -1))));
}

function finalizeEsxStatus(jobId, binaries, exitCode) {
  const ok = exitCode === 0;
  for (const b of binaries) {
    jobStore.updateBinaryStatus(jobId, b.id, { status: ok ? 'done' : 'failed', percent: ok ? 100 : undefined });
  }
}

// Checks the files a set of binary rows own on disk against Broadcom's
// published size + SHA-256 (lib/integrity.js). Runs after every successful
// binaries download and on demand ('verify' mode). Returns the Set of binary
// ids that failed; those rows are flipped to 'failed' so a bad file can't
// sit behind a green "done".
async function verifyBinaries(jobId, binaries, emit) {
  const failed = new Set();
  const catalog = await integrity.getCatalog();
  if (catalog.size === 0) {
    emit('Integrity check skipped: Broadcom product version catalog not found in the depot.');
    return failed;
  }
  depotIndex.invalidate();
  const index = await depotIndex.getIndex({ forceRefresh: true });

  emit('\n--- Verifying downloaded files against Broadcom catalog ---');
  for (const b of binaries) {
    const files = depotIndex.filesFor(index, b.component, b.version, b.type);
    if (files.length === 0) {
      emit(`${b.component} ${b.version}: no files on disk to verify.`);
      jobStore.updateBinaryStatus(jobId, b.id, { status: 'failed' });
      failed.add(b.id);
      continue;
    }
    let bad = false;
    let checked = 0;
    for (const f of files) {
      const full = path.join(COMP_ROOT, b.component, f);
      try {
        const r = await integrity.verifyFile(full, catalog, (pct) => {
          if (pct > 0 && pct < 100) emit(`  ${f}: hashing ${pct}%`);
        });
        if (r.status === 'unknown') {
          emit(`  ${f}: not in Broadcom catalog - not checked`);
        } else if (r.status === 'ok') {
          checked++;
          emit(`  ${f}: OK (${r.actualSize} bytes${r.hashed ? ', SHA-256 match' : ''})`);
        } else if (r.status === 'size-mismatch') {
          bad = true;
          emit(`  ${f}: SIZE MISMATCH - ${r.actualSize} bytes on disk, Broadcom says ${r.expectedSize} (short by ${r.expectedSize - r.actualSize})`);
        } else {
          bad = true;
          emit(`  ${f}: CHECKSUM MISMATCH - size is right (${r.actualSize}) but SHA-256 differs from Broadcom's`);
        }
      } catch (err) {
        bad = true;
        emit(`  ${f}: could not be read (${err.message})`);
      }
    }
    if (bad) {
      failed.add(b.id);
      jobStore.updateBinaryStatus(jobId, b.id, { status: 'failed' });
    } else {
      jobStore.updateBinaryStatus(jobId, b.id, { status: 'done', percent: 100 });
      if (checked === 0) emit(`${b.component} ${b.version}: nothing in this row is covered by the catalog - presence only.`);
    }
  }
  if (failed.size > 0) {
    emit('\nDelete the flagged rows (Delete selected) and download them again.');
  }
  return failed;
}

function markRemainingFailed(jobId, binaries) {
  for (const b of binaries) {
    jobStore.updateBinaryStatus(jobId, b.id, { status: 'failed' });
  }
}

// The CLI prints a final pipe-table summarizing per-binary outcome, e.g.:
//   Component | Component Full Name | Version | Image Type | Status
//   TELEMETRY_ACCEPTOR | Telemetry | 9.1.0.0.25181946 | INSTALL | SUCCESS
// Isolate just that table (the log also contains an earlier, differently
// shaped "Binaries to be downloaded" table that would otherwise confuse the
// shared header-based parser) before reusing tableParser on it.
function finalizeBinaryStatuses(jobId, binaries, lines, exitCode) {
  const markerIdx = lines.findIndex((l) => l.includes('Binary Download Summary'));
  const summaryRows = markerIdx === -1 ? [] : parseTable(lines.slice(markerIdx).join('\n'));

  const STATUS_MAP = {
    SUCCESS: 'done',
    ALREADY_DOWNLOADED: 'done',
    FAILED: 'failed',
    CANCELLED: 'cancelled',
  };

  const resolved = new Set();
  for (const row of summaryRows) {
    const match = binaries.find((b) => b.component === row.component && b.version === row.version);
    if (!match) continue;
    resolved.add(match.id);
    const status = STATUS_MAP[row.status] || (exitCode === 0 ? 'done' : 'failed');
    jobStore.updateBinaryStatus(jobId, match.id, {
      status,
      percent: status === 'done' ? 100 : undefined,
    });
  }

  // Anything the summary table didn't mention (parsing edge case) falls
  // back to the overall job outcome rather than staying stuck pending.
  const fallbackStatus = exitCode === 0 ? 'done' : 'failed';
  for (const b of binaries) {
    if (resolved.has(b.id)) continue;
    jobStore.updateBinaryStatus(jobId, b.id, {
      status: fallbackStatus,
      percent: fallbackStatus === 'done' ? 100 : undefined,
    });
  }
}

const JOB_TTL_MS = 30 * 60 * 1000;
function scheduleCleanup(jobId) {
  setTimeout(() => liveJobs.delete(jobId), JOB_TTL_MS).unref();
}

// Keeps DOWNLOAD_LOGS_DIR bounded to whatever jobStore itself still
// remembers (MAX_HISTORY finished jobs + any still running) - called after
// every job finishes, plus once at module load to catch anything orphaned
// by a restart that happened before this cleanup could run.
function pruneOrphanLogs() {
  try {
    const validIds = new Set(jobStore.listJobs().map((j) => j.id));
    for (const file of fs.readdirSync(DOWNLOAD_LOGS_DIR)) {
      if (!file.endsWith('.log')) continue;
      const id = file.slice(0, -4);
      if (!validIds.has(id)) fs.unlinkSync(path.join(DOWNLOAD_LOGS_DIR, file));
    }
  } catch (err) {
    // best-effort - a cleanup failure shouldn't disrupt anything else
  }
}

pruneOrphanLogs();

// Live log access (for the SSE modal) - falls back to an empty/closed view
// once a job has aged out of liveJobs, since jobStore still has its status.
function getLiveJob(jobId) {
  return liveJobs.get(jobId);
}

module.exports = { startDownload, getLiveJob };
