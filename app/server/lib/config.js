const path = require('path');
const fs = require('fs');

const TOKEN_DIR = process.env.TOKEN_DIR || '/data/token';
const TOKEN_FILE = path.join(TOKEN_DIR, 'activation-code.txt');

// The CLI isn't bind-mounted anymore - it's uploaded through the GUI (see
// lib/cliInstall.js) and lives inside the same persistent volume as the
// token/job-history, so it's never configurable via env var. cli-staging is
// where an upload is extracted and validated before being swapped in;
// cli-previous is the one-generation rollback kept from the last swap.
const CLI_DIR = path.join(TOKEN_DIR, 'cli');
const CLI_BIN = path.join(CLI_DIR, 'bin', 'vcf-download-tool');
const CLI_STAGING_DIR = path.join(TOKEN_DIR, 'cli-staging');
const CLI_PREVIOUS_DIR = path.join(TOKEN_DIR, 'cli-previous');

// The CLI persists a per-installation "software depot ID" (a UUID that has
// to be registered against the activation code on the Broadcom portal). It
// writes this under $XDG_DATA_HOME/vmware/vdt/machine_id - redirect that
// into the same persistent volume as the token so it survives restarts,
// since the JVM resolves plain $HOME from /etc/passwd, not the env var.
const XDG_DATA_HOME = process.env.XDG_DATA_HOME || path.join(TOKEN_DIR, 'xdg-data');
const DEPOT_ID_FILE = path.join(XDG_DATA_HOME, 'vmware', 'vdt', 'machine_id');

const DEPOT_DIR = process.env.DEPOT_DIR || '/mnt/vcf-depot';

// Structured download job history (status/progress per binary) - reuses the
// token volume rather than adding a new one. Raw per-line CLI logs are kept
// in memory only and never written here.
const JOB_HISTORY_FILE = path.join(TOKEN_DIR, 'job-history.json');

// Lowest VCF major.minor to scan from when discovering releases dynamically.
// Anything released at or above this is picked up automatically - no code
// changes needed when Broadcom ships a new x.y.z.
const RELEASE_SCAN_START = process.env.RELEASE_SCAN_START_VERSION || '9.0';

// How long a discovered release list is cached in memory before a fresh
// scan is triggered automatically (in addition to the manual refresh button).
const RELEASE_CACHE_TTL_MS = Number(process.env.RELEASE_CACHE_TTL_MS || 15 * 60 * 1000);

const PORT = Number(process.env.PORT || 8080);

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
  CLI_PREVIOUS_DIR,
  TOKEN_DIR,
  TOKEN_FILE,
  XDG_DATA_HOME,
  DEPOT_ID_FILE,
  DEPOT_DIR,
  JOB_HISTORY_FILE,
  RELEASE_SCAN_START,
  RELEASE_CACHE_TTL_MS,
  PORT,
  APP_VERSION: pkgVersion,
};

for (const dir of [TOKEN_DIR, DEPOT_DIR, path.dirname(DEPOT_ID_FILE)]) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    // surfaced later when actually used
  }
}
