const fs = require('fs');
const crypto = require('crypto');
const { JOB_HISTORY_FILE } = require('./config');

const MAX_HISTORY = 50; // finished jobs kept on disk; running jobs are always kept
const MAX_IN_MEMORY = 200; // generous safety cap so a long-lived process can't grow unbounded

function loadFromDisk() {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(JOB_HISTORY_FILE, 'utf8'));
  } catch (err) {
    return [];
  }

  // Any job still "running" belonged to a previous process instance - that
  // CLI process is definitely gone now, so it can never finish on its own.
  for (const job of parsed) {
    if (job.status === 'running') {
      job.status = 'error';
      job.finishedAt = job.finishedAt || Date.now();
      job.exitCode = job.exitCode ?? -1;
      for (const b of job.binaries) {
        if (b.status === 'pending' || b.status === 'downloading') b.status = 'failed';
      }
    }
  }
  return parsed;
}

let jobs = loadFromDisk();

function persist() {
  try {
    const running = jobs.filter((j) => j.status === 'running');
    const finished = jobs.filter((j) => j.status !== 'running').slice(0, MAX_HISTORY);
    fs.writeFileSync(JOB_HISTORY_FILE, JSON.stringify([...running, ...finished], null, 2));
  } catch (err) {
    // Best-effort - history persistence shouldn't take a download down with it.
  }
}

function createJob(binaries) {
  const job = {
    id: crypto.randomUUID(),
    status: 'running',
    exitCode: null,
    startedAt: Date.now(),
    finishedAt: null,
    binaries: binaries.map((b) => ({
      id: b.id,
      component: b.component,
      fullName: b.component_full_name || b.fullName || '',
      version: b.version,
      size: b.size,
      status: 'pending',
      percent: 0,
    })),
  };

  jobs.unshift(job);
  if (jobs.length > MAX_IN_MEMORY) jobs.length = MAX_IN_MEMORY;
  persist();
  return job;
}

function getJob(id) {
  return jobs.find((j) => j.id === id);
}

function listJobs() {
  return jobs;
}

function updateBinaryStatus(jobId, binaryId, { status, percent }) {
  const job = getJob(jobId);
  if (!job) return;
  const binary = job.binaries.find((b) => b.id === binaryId);
  if (!binary) return;

  const statusChanged = status !== undefined && status !== binary.status;
  if (status !== undefined) binary.status = status;
  if (percent !== undefined) binary.percent = percent;

  // Persist on status transitions only - percent ticks stay in-memory-only
  // to avoid hammering disk every second during a long download.
  if (statusChanged) persist();
}

function finishJob(jobId, { status, exitCode }) {
  const job = getJob(jobId);
  if (!job) return;
  job.status = status;
  job.exitCode = exitCode;
  job.finishedAt = Date.now();
  persist();
}

module.exports = { createJob, getJob, listJobs, updateBinaryStatus, finishJob };
