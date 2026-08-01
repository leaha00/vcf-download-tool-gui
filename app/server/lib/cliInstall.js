const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { CLI_DIR, CLI_STAGING_DIR, CLI_PREVIOUS_DIR, XDG_DATA_HOME } = require('./config');
const { acquireCliLock } = require('./cliRunner');
const cliVersion = require('./cliVersion');

class CliInstallError extends Error {}

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

const EXTRACT_TIMEOUT_MS = 3 * 60 * 1000;
const VALIDATE_TIMEOUT_MS = 90 * 1000;

function extractArchive(archivePath, destDir) {
  return new Promise((resolve, reject) => {
    // No -P/--absolute-names - tar's own default protection against
    // absolute-path/traversal entries applies.
    const child = spawn('tar', ['-xzf', archivePath, '-C', destDir]);
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new CliInstallError(`Extraction timed out after ${EXTRACT_TIMEOUT_MS / 1000}s.`));
    }, EXTRACT_TIMEOUT_MS);

    child.stderr.on('data', (d) => (stderr += d.toString('utf8')));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new CliInstallError(`Failed to run tar: ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new CliInstallError(`Extraction failed - is this a valid vcf-download-tool tar.gz? (tar exit ${code}: ${stderr.trim()})`));
        return;
      }
      resolve();
    });
  });
}

// Broadcom's own tar.gz has no top-level wrapper directory - bin/, conf/,
// jre/ sit directly at the archive root (confirmed against a real
// download). But if someone uploads a re-packaged copy that does have one
// (e.g. they tar'd up their own already-extracted copy), detect and
// unwrap it one level rather than failing validation.
function unwrapIfNeeded(destDir) {
  if (fs.existsSync(path.join(destDir, 'bin', 'vcf-download-tool'))) return;

  const entries = fs.readdirSync(destDir);
  if (entries.length !== 1) return;

  const wrapped = path.join(destDir, entries[0]);
  if (!fs.statSync(wrapped).isDirectory()) return;
  if (!fs.existsSync(path.join(wrapped, 'bin', 'vcf-download-tool'))) return;

  for (const child of fs.readdirSync(wrapped)) {
    fs.renameSync(path.join(wrapped, child), path.join(destDir, child));
  }
  fs.rmdirSync(wrapped);
}

async function extract(archivePath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  await extractArchive(archivePath, destDir);
  unwrapIfNeeded(destDir);
}

// Uploading the archive fresh from Broadcom (rather than extract-then-copy
// through several hops, which is how earlier bind-mount deployments ended
// up with mangled permissions) means tar's own default permission
// preservation should already be correct. This is just a defensive
// fallback, not the primary fix it was in the bind-mount days.
function relaxPermissions(dir) {
  try {
    fs.chmodSync(dir, 0o755);
  } catch (err) {
    // best-effort
  }
}

function validate(stagingBin) {
  return new Promise((resolve) => {
    if (!fs.existsSync(stagingBin)) {
      resolve({ ok: false, reason: "bin/vcf-download-tool wasn't found in the uploaded archive - is this the right file?" });
      return;
    }

    const child = spawn(stagingBin, ['--version'], {
      env: { ...process.env, XDG_DATA_HOME },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({
        ok: false,
        reason: `The extracted CLI did not respond to --version within ${VALIDATE_TIMEOUT_MS / 1000}s (partial output: ${stdout.trim().slice(0, 300) || '<none>'}).`,
      });
    }, VALIDATE_TIMEOUT_MS);

    child.stdout.on('data', (d) => (stdout += d.toString('utf8')));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, reason: `Could not run the extracted CLI: ${err.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 || !/^Version:/m.test(stdout)) {
        resolve({ ok: false, reason: `The extracted CLI did not run correctly (exit code ${code}).` });
        return;
      }
      resolve({ ok: true });
    });
  });
}

// The whole extract+validate+swap runs under the same mutex as every other
// CLI invocation, so an install can't race an in-flight list/download and
// vice versa - it just queues, same as a second download already queues
// behind a first one.
async function installFromUpload(archivePath) {
  const release = await acquireCliLock();
  try {
    rmrf(CLI_STAGING_DIR);
    await extract(archivePath, CLI_STAGING_DIR);
    relaxPermissions(CLI_STAGING_DIR);

    const stagingBin = path.join(CLI_STAGING_DIR, 'bin', 'vcf-download-tool');
    const result = await validate(stagingBin);
    if (!result.ok) {
      rmrf(CLI_STAGING_DIR);
      throw new CliInstallError(result.reason);
    }

    // One generation of rollback safety: keep the previously-working CLI
    // rather than deleting it outright.
    rmrf(CLI_PREVIOUS_DIR);
    if (fs.existsSync(CLI_DIR)) fs.renameSync(CLI_DIR, CLI_PREVIOUS_DIR);
    fs.renameSync(CLI_STAGING_DIR, CLI_DIR);

    cliVersion.invalidate();
  } finally {
    fs.rm(archivePath, { force: true }, () => {});
    release();
  }
}

function getInstallStatus() {
  const installed = fs.existsSync(CLI_DIR);
  let installedAt = null;
  if (installed) {
    try {
      installedAt = fs.statSync(CLI_DIR).mtime.toISOString();
    } catch (err) {
      installedAt = null;
    }
  }
  return { installed, installedAt, hasPrevious: fs.existsSync(CLI_PREVIOUS_DIR) };
}

module.exports = { installFromUpload, getInstallStatus, CliInstallError };
