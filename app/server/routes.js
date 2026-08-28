const os = require('os');
const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const { APP_VERSION, DEPOT_DIR, DOWNLOAD_LOGS_DIR } = require('./lib/config');
const tokenStore = require('./lib/tokenStore');
const depotId = require('./lib/depotId');
const scheduleStore = require('./lib/scheduleStore');
const { getReleases } = require('./lib/releaseCache');
const { listBinaries, deleteBinaries } = require('./lib/binaries');
const depotIndex = require('./lib/depotIndex');
const { startDownload, getLiveJob } = require('./lib/downloadJobs');
const jobStore = require('./lib/jobStore');
const cliLogs = require('./lib/cliLogs');
const { getCliVersion } = require('./lib/cliVersion');
const { getDepotStorage } = require('./lib/diskUsage');
const { getStats } = require('./lib/systemStats');
const cliInstall = require('./lib/cliInstall');
const { CliError } = require('./lib/cliRunner');

const router = express.Router();

function handleError(res, err) {
  const status = err instanceof CliError ? 502 : 400;
  res.status(status).json({ error: err.message });
}

// Disk storage, not memory - the archive can be several hundred MB. Written
// to a scratch dir and removed by cliInstall.installFromUpload() once
// extraction is done (success or failure).
const cliUpload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 2 * 1024 * 1024 * 1024, files: 1 },
});

// Instant and CLI-independent on purpose - this must never block on
// spawning/waiting for the CLI, which can be slow or, if something's wrong
// with the mount, hang for a long time. The CLI's own version is fetched
// separately (see /cli-version) so a slow/broken CLI can't freeze this.
router.get('/version', (req, res) => {
  res.json({ version: APP_VERSION, depotDir: DEPOT_DIR });
});

router.get('/cli-version', async (req, res) => {
  res.json({ cliVersion: await getCliVersion() });
});

router.get('/storage', (req, res) => {
  res.json(getDepotStorage() || { totalBytes: 0, usedBytes: 0, freeBytes: 0, usedPercent: 0, unavailable: true });
});

router.get('/system-stats', (req, res) => {
  res.json(getStats());
});

router.get('/cli/status', (req, res) => {
  res.json(cliInstall.getInstallStatus());
});

router.post('/cli/install', cliUpload.single('archive'), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'No file uploaded' });
    return;
  }
  try {
    await cliInstall.installFromUpload(req.file.path);
    res.json(cliInstall.getInstallStatus());
  } catch (err) {
    const status = err instanceof cliInstall.CliInstallError ? 400 : 500;
    res.status(status).json({ error: err.message });
  }
});

router.get('/cli-logs', async (req, res) => {
  try {
    res.json(await cliLogs.listLogs());
  } catch (err) {
    res.status(500).json({ error: 'Failed to list CLI log directory.' });
  }
});

router.get('/cli-logs/*', async (req, res) => {
  const relativePath = req.params[0] || '';
  try {
    res.json(await cliLogs.readLogEntry(relativePath, { full: req.query.full === 'true' }));
  } catch (err) {
    if (err instanceof cliLogs.CliLogPathError) {
      res.status(400).json({ error: err.message });
      return;
    }
    if (err.code === 'ENOENT') {
      res.status(404).json({ error: 'Log file not found.' });
      return;
    }
    if (err instanceof cliLogs.CliLogReadError) {
      res.status(502).json({ error: err.message });
      return;
    }
    res.status(500).json({ error: 'Failed to read log file.' });
  }
});

router.get('/token', (req, res) => {
  res.json(tokenStore.getStatus());
});

router.post('/token', (req, res) => {
  try {
    tokenStore.save(req.body && req.body.token);
    res.json(tokenStore.getStatus());
  } catch (err) {
    handleError(res, err);
  }
});

router.delete('/token', (req, res) => {
  tokenStore.clear();
  res.json(tokenStore.getStatus());
});

router.get('/depot-id', (req, res) => {
  res.json(depotId.getStatus());
});

router.post('/depot-id/generate', async (req, res) => {
  try {
    res.json(await depotId.generate());
  } catch (err) {
    handleError(res, err);
  }
});

router.post('/depot-id', (req, res) => {
  try {
    res.json(depotId.setExisting(req.body && req.body.id));
  } catch (err) {
    handleError(res, err);
  }
});

router.get('/schedule', (req, res) => {
  res.json({
    ...scheduleStore.getSchedule(),
    serverTime: new Date().toISOString(),
    serverTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
});

router.post('/schedule', (req, res) => {
  try {
    const { enabled, mode, time, days } = req.body || {};
    res.json(scheduleStore.setSchedule({ enabled, mode, time, days }));
  } catch (err) {
    handleError(res, err);
  }
});

router.get('/releases', async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === 'true';
    const data = await getReleases({ forceRefresh });
    res.json(data);
  } catch (err) {
    handleError(res, err);
  }
});

router.get('/binaries', async (req, res) => {
  try {
    const { version, sku, type } = req.query;
    const result = await listBinaries({ version, sku, type });
    const index = await depotIndex.getIndex();
    result.binaries = result.binaries.map((b) => ({
      ...b,
      downloaded: depotIndex.isDownloaded(index, b.component, b.version, b.type),
    }));
    res.json(result);
  } catch (err) {
    handleError(res, err);
  }
});

router.post('/delete', async (req, res) => {
  try {
    const ids = req.body && req.body.ids;
    await deleteBinaries(ids);
    depotIndex.invalidate();
    res.json({ ok: true });
  } catch (err) {
    handleError(res, err);
  }
});

router.get('/downloads', (req, res) => {
  res.json({ jobs: jobStore.listJobs() });
});

router.post('/download', (req, res) => {
  try {
    const ids = req.body && req.body.ids;
    const binaries = (req.body && req.body.binaries) || [];
    const jobId = startDownload(ids, binaries);
    res.json({ jobId });
  } catch (err) {
    handleError(res, err);
  }
});

router.get('/download/:jobId/stream', (req, res) => {
  const jobId = req.params.jobId;
  const jobRecord = jobStore.getJob(jobId);
  const live = getLiveJob(jobId);

  if (!jobRecord && !live) {
    res.status(404).json({ error: 'Unknown or expired download job' });
    return;
  }

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();

  let historicalLines = [];
  if (live) {
    historicalLines = live.lines;
  } else {
    try {
      historicalLines = fs
        .readFileSync(path.join(DOWNLOAD_LOGS_DIR, `${jobId}.log`), 'utf8')
        .split('\n')
        .filter(Boolean);
    } catch (err) {
      historicalLines = []; // no persisted log for this job (predates this feature, or was pruned)
    }
  }
  for (const line of historicalLines) {
    res.write(`data: ${line}\n\n`);
  }

  const isRunning = jobRecord ? jobRecord.status === 'running' : false;
  if (!isRunning || !live) {
    res.write(`event: done\ndata: ${jobRecord ? jobRecord.exitCode : ''}\n\n`);
    res.end();
    return;
  }

  const onLine = (line) => res.write(`data: ${line}\n\n`);
  const onDone = () => {
    const finalRecord = jobStore.getJob(jobId);
    res.write(`event: done\ndata: ${finalRecord ? finalRecord.exitCode : ''}\n\n`);
    res.end();
  };
  live.emitter.on('line', onLine);
  live.emitter.on('done', onDone);

  req.on('close', () => {
    live.emitter.off('line', onLine);
    live.emitter.off('done', onDone);
  });
});

module.exports = router;
