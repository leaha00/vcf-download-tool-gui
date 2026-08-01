const { EventEmitter } = require('events');
const { streamCli } = require('./cliRunner');
const { TOKEN_FILE, DEPOT_DIR } = require('./config');
const depotIndex = require('./depotIndex');
const jobStore = require('./jobStore');
const { parseSize } = require('./sizeUtils');
const { parseTable } = require('./tableParser');

const MAX_LINES = 500; // live-log tail kept in memory for the SSE modal - not persisted

// Live, in-process-only state for jobs currently streaming (the structured
// status/history lives in jobStore; this is just the raw log + emitter for
// whoever has the download modal open).
const liveJobs = new Map();

const PROGRESS_RE = /^Download Progress of\s*:\s*(.+?)\s*:\s*([\d.]+)\s*MB/;

function startDownload(ids, binaries) {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new Error('At least one binary id is required');
  }

  const job = jobStore.createJob(binaries);
  const jobId = job.id;

  const emitter = new EventEmitter();
  const lines = [];
  liveJobs.set(jobId, { lines, emitter });

  const emit = (line) => {
    lines.push(line);
    if (lines.length > MAX_LINES) lines.shift();
    emitter.emit('line', line);
  };

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

  streamCli(
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
  )
    .then((child) => {
      child.on('close', (code) => {
        finalizeBinaryStatuses(jobId, binaries, lines, code);
        jobStore.finishJob(jobId, { status: code === 0 ? 'complete' : 'error', exitCode: code });
        emit(code === 0 ? 'Download complete.' : `Download failed (exit code ${code}).`);
        if (code === 0) depotIndex.invalidate();
        emitter.emit('done');
        scheduleCleanup(jobId);
      });
    })
    .catch((err) => {
      finalizeBinaryStatuses(jobId, binaries, lines, -1);
      jobStore.finishJob(jobId, { status: 'error', exitCode: -1 });
      emit(`Failed to start download: ${err.message}`);
      emitter.emit('done');
      scheduleCleanup(jobId);
    });

  return jobId;
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

// Live log access (for the SSE modal) - falls back to an empty/closed view
// once a job has aged out of liveJobs, since jobStore still has its status.
function getLiveJob(jobId) {
  return liveJobs.get(jobId);
}

module.exports = { startDownload, getLiveJob };
