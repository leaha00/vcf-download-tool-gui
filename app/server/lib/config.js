const path = require('path');
const fs = require('fs');

const TOKEN_DIR = process.env.TOKEN_DIR || '/data/token';
const TOKEN_FILE = path.join(TOKEN_DIR, 'activation-code.txt');

// The CLI isn't bind-mounted anymore - it's uploaded through the GUI (see
// lib/cliInstall.js) and lives inside the same persistent volume as the
// token/job-history, so it's never configurable via env var. cli-staging is
// where an upload is extracted and validated before being swapped in.
const CLI_DIR = path.join(TOKEN_DIR, 'cli');
const CLI_BIN = path.join(CLI_DIR, 'bin', 'vcf-download-tool');
const CLI_STAGING_DIR = path.join(TOKEN_DIR, 'cli-staging');

// The CLI writes its own operational log here on first run (not created by
// us - see the mkdirSync loop at the bottom of this file, which
// deliberately excludes this dir so its absence stays a meaningful "CLI
// never run yet" signal rather than being papered over).
const CLI_LOG_DIR = path.join(CLI_DIR, 'log');

// The CLI persists a per-installation "software depot ID" (a UUID that has
// to be registered against the activation code on the Broadcom portal). It
// writes this under $XDG_DATA_HOME/vmware/vdt/machine_id - redirect that
// into the same persistent volume as the token so it survives restarts,
// since the JVM resolves plain $HOME from /etc/passwd, not the env var.
const XDG_DATA_HOME = process.env.XDG_DATA_HOME || path.join(TOKEN_DIR, 'xdg-data');
const DEPOT_ID_FILE = path.join(XDG_DATA_HOME, 'vmware', 'vdt', 'machine_id');

const DEPOT_DIR = process.env.DEPOT_DIR || '/mnt/vcf-depot';

// Structured download job history (status/progress per binary) - reuses the
// token volume rather than adding a new one. Raw per-line CLI logs are
// written separately, one file per job, under DOWNLOAD_LOGS_DIR below.
const JOB_HISTORY_FILE = path.join(TOKEN_DIR, 'job-history.json');

// Raw per-line CLI download logs, one file per job (<jobId>.log). Sibling of
// CLI_DIR/CLI_STAGING_DIR under the same persistent volume, so logs survive
// container restarts instead of living only in downloadJobs.js's in-memory
// liveJobs map.
const DOWNLOAD_LOGS_DIR = path.join(TOKEN_DIR, 'download-logs');

// Lowest VCF major.minor to scan from when discovering releases dynamically.
// Not configurable: the depot's anchor component this scan relies on
// (SDDC_MANAGER_VCF - see lib/releaseCache.js) only exists from 9.0 onward,
// so anything lower is a no-op here regardless of what it's set to. Pre-9.0
// releases are covered separately by LEGACY_RELEASE_VERSIONS below.
const RELEASE_SCAN_START = '9.0';

// VCF major.minor versions released before 9.0, hardcoded because the
// depot has no component whose own version tracks the release version 1:1
// for that era (unlike SDDC_MANAGER_VCF from 9.0 on), so they can't be
// discovered the same way. Safe to hardcode - this product line is EOL and
// Broadcom won't be shipping new releases under it. Sorted oldest first;
// releaseCache.js reverses this when building the newest-first release list.
const LEGACY_RELEASE_VERSIONS = ['5.0', '5.1', '5.2'];

// How long a discovered release list is cached in memory before a fresh
// scan is triggered automatically (in addition to the manual refresh button).
const RELEASE_CACHE_TTL_MS = Number(process.env.RELEASE_CACHE_TTL_MS || 15 * 60 * 1000);

// User-configured schedule (disabled by default) for triggering a force
// refresh of the release scan in the background - see lib/refreshScheduler.js.
const SCHEDULE_FILE = path.join(TOKEN_DIR, 'refresh-schedule.json');

const PORT = Number(process.env.PORT || 8080);

// Second Express instance/port, internal-only (never published in
// docker-compose.yml's `ports:`) - lets a separate depot-serving container
// list/stream files under DEPOT_DIR over the Docker network without ever
// mounting the depot volume itself. See lib/depotServe.js.
const INTERNAL_PORT = Number(process.env.INTERNAL_PORT || 10080);

let pkgVersion = '0.0.0';
try {
  pkgVersion = require('../../package.json').version;
} catch (e) {
  // ignore, keep default
}

module.exports = {
  CLI_DIR,
  CLI_BIN,
  CLI_STAGING_DIR,
  CLI_LOG_DIR,
  TOKEN_DIR,
  TOKEN_FILE,
  XDG_DATA_HOME,
  DEPOT_ID_FILE,
  DEPOT_DIR,
  JOB_HISTORY_FILE,
  DOWNLOAD_LOGS_DIR,
  RELEASE_SCAN_START,
  LEGACY_RELEASE_VERSIONS,
  RELEASE_CACHE_TTL_MS,
  SCHEDULE_FILE,
  PORT,
  INTERNAL_PORT,
  APP_VERSION: pkgVersion,
};

for (const dir of [TOKEN_DIR, DEPOT_DIR, path.dirname(DEPOT_ID_FILE), DOWNLOAD_LOGS_DIR]) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    // surfaced later when actually used
  }
}
