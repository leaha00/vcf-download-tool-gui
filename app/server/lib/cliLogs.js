const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawn } = require('child_process');
const { CLI_LOG_DIR } = require('./config');

class CliLogPathError extends Error {}
class CliLogReadError extends Error {}

// Default tail size for the live vdt.log (most recent activity, e.g. the
// failure a user is chasing, is almost always at the end of the file).
const TAIL_BYTES = 512 * 1024;
// Hard ceiling even on an explicit "load full file" request.
const FULL_CAP_BYTES = 20 * 1024 * 1024;
// Rotated archives are closed and compressed, expected far smaller than the
// live log - a tighter cap is fine here.
const ARCHIVE_CAP_BYTES = 5 * 1024 * 1024;

// Mirrors depotServe.js's resolveSafePath, scoped to CLI_LOG_DIR instead of
// DEPOT_DIR. Duplicated rather than shared - each lib module here is
// self-contained, and this guard is small enough that generalizing it isn't
// worth touching a working, security-relevant function for.
function resolveSafePath(relativePath) {
  const decoded = decodeURIComponent(relativePath || '');
  if (decoded.split(/[/\\]/).includes('..')) {
    throw new CliLogPathError('Path escapes the log directory.');
  }

  const resolved = path.resolve(CLI_LOG_DIR, '.' + path.sep + decoded);
  if (resolved !== CLI_LOG_DIR && !resolved.startsWith(CLI_LOG_DIR + path.sep)) {
    throw new CliLogPathError('Path escapes the log directory.');
  }

  let real;
  try {
    real = fs.realpathSync(resolved);
  } catch (err) {
    return resolved;
  }
  if (real !== CLI_LOG_DIR && !real.startsWith(CLI_LOG_DIR + path.sep)) {
    throw new CliLogPathError('Path escapes the log directory (symlink).');
  }
  return resolved;
}

function classify(name) {
  const lower = name.toLowerCase();
  if (lower.endsWith('.log')) return 'text';
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz') || lower.endsWith('.gz')) return 'archive';
  return 'other';
}

async function listLogs() {
  let stat;
  try {
    stat = await fs.promises.stat(CLI_LOG_DIR);
  } catch (err) {
    if (err.code === 'ENOENT') return { exists: false, entries: [] };
    throw err;
  }
  if (!stat.isDirectory()) return { exists: false, entries: [] };

  const dirents = await fs.promises.readdir(CLI_LOG_DIR, { withFileTypes: true });
  const visible = dirents.filter((e) => !e.name.startsWith('.'));

  const entries = await Promise.all(
    visible.map(async (entry) => {
      const entryStat = await fs.promises.stat(path.join(CLI_LOG_DIR, entry.name));
      return {
        name: entry.name,
        isDir: entry.isDirectory(),
        size: entryStat.size,
        mtimeMs: entryStat.mtimeMs,
        kind: entry.isDirectory() ? 'other' : classify(entry.name),
      };
    })
  );
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);

  return { exists: true, entries };
}

// Seek-from-end read - cheap even on a large live log, unlike the archive
// case below which can't be seeked the same way without buffering the whole
// decompressed stream first.
async function readTextTail(filePath, maxBytes) {
  const stat = await fs.promises.stat(filePath);
  const size = stat.size;
  const readLength = Math.min(size, maxBytes);
  const position = Math.max(0, size - readLength);

  const handle = await fs.promises.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(readLength);
    await handle.read(buffer, 0, readLength, position);
    return { content: buffer.toString('utf8'), truncated: size > maxBytes, totalBytes: size };
  } finally {
    await handle.close();
  }
}

// Generous ceiling for the gzip layer alone, before we even know whether
// what's underneath is a tar archive or a bare gzipped log - kept above
// ARCHIVE_CAP_BYTES (the final content cap) so a genuine multi-file tar
// isn't truncated mid-structure before we get a chance to list its entries.
const DECOMPRESS_CAP_BYTES = 10 * 1024 * 1024;

const TAR_MAGIC_OFFSET = 257;
const TAR_MAGIC = 'ustar';

function looksLikeTar(buffer) {
  if (buffer.length < TAR_MAGIC_OFFSET + TAR_MAGIC.length) return false;
  return buffer.toString('ascii', TAR_MAGIC_OFFSET, TAR_MAGIC_OFFSET + TAR_MAGIC.length) === TAR_MAGIC;
}

// Decompresses just the gzip layer via Node's own zlib (no shell-out needed
// for this part), cut off early past maxBytes.
function gunzipCapped(filePath, maxBytes) {
  return new Promise((resolve, reject) => {
    const gunzip = zlib.createGunzip();
    const input = fs.createReadStream(filePath);
    let out = Buffer.alloc(0);
    let settled = false;

    const finish = (err, result) => {
      if (settled) return;
      settled = true;
      input.destroy();
      gunzip.destroy();
      if (err) reject(err);
      else resolve(result);
    };

    gunzip.on('data', (chunk) => {
      out = Buffer.concat([out, chunk]);
      if (out.length > maxBytes) {
        finish(null, { buffer: out.subarray(0, maxBytes), truncated: true });
      }
    });
    gunzip.on('end', () => finish(null, { buffer: out, truncated: false }));
    gunzip.on('error', (err) => finish(new CliLogReadError(`Not a valid gzip file: ${err.message}`)));
    input.on('error', (err) => finish(new CliLogReadError(`Failed to read archive: ${err.message}`)));

    input.pipe(gunzip);
  });
}

// Broadcom's log rotation names files `.tar.gz` regardless of whether the
// contents are actually a tar - in practice these are frequently a single
// gzipped log file with no tar structure at all (confirmed against a real
// deployment: `tar -tzf`/`-xzOf` fail on them with "This does not look
// like a tar archive"). So: always decompress the gzip layer ourselves
// first via zlib, then only hand the result to the system `tar` binary
// (same shell-out convention as cliInstall.js) if it actually looks like
// one (ustar magic at the standard offset). Otherwise the decompressed
// bytes *are* the log content.
async function readArchiveEntryConcat(archivePath, maxBytes) {
  const { buffer, truncated: gzTruncated } = await gunzipCapped(archivePath, DECOMPRESS_CAP_BYTES);

  if (!looksLikeTar(buffer)) {
    const capped = buffer.length > maxBytes;
    return {
      content: buffer.subarray(0, maxBytes).toString('utf8'),
      truncated: gzTruncated || capped,
      multipleEntries: false,
    };
  }

  // Real tar structure - write the already-decompressed bytes to a scratch
  // file and shell out to `tar` uncompressed (-tf/-xOf, no -z: the gzip
  // layer is already handled above).
  const tmpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vdt-log-')), 'archive.tar');
  fs.writeFileSync(tmpFile, buffer);
  try {
    return await extractTarConcat(tmpFile, maxBytes);
  } finally {
    fs.rm(path.dirname(tmpFile), { recursive: true, force: true }, () => {});
  }
}

// Lists entries first (to detect the multi-file case), then streams all
// regular-file content concatenated to stdout, cut off early past maxBytes.
function extractTarConcat(tarPath, maxBytes) {
  return new Promise((resolve, reject) => {
    const list = spawn('tar', ['-tf', tarPath]);
    let listOut = '';
    let listErr = '';
    list.stdout.on('data', (d) => (listOut += d.toString('utf8')));
    list.stderr.on('data', (d) => (listErr += d.toString('utf8')));
    list.on('error', (err) => reject(new CliLogReadError(`Failed to run tar: ${err.message}`)));
    list.on('close', (listCode) => {
      if (listCode !== 0) {
        reject(new CliLogReadError(`Failed to list archive (tar exit ${listCode}: ${listErr.trim()})`));
        return;
      }

      const fileEntries = listOut
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.endsWith('/'));
      const multipleEntries = fileEntries.length > 1;

      const extract = spawn('tar', ['-xOf', tarPath]);
      let stdout = Buffer.alloc(0);
      let stderr = '';
      let truncated = false;

      extract.stdout.on('data', (chunk) => {
        if (truncated) return;
        stdout = Buffer.concat([stdout, chunk]);
        if (stdout.length > maxBytes) {
          truncated = true;
          stdout = stdout.subarray(0, maxBytes);
          extract.kill('SIGKILL');
        }
      });
      extract.stderr.on('data', (d) => (stderr += d.toString('utf8')));
      extract.on('error', (err) => reject(new CliLogReadError(`Failed to run tar: ${err.message}`)));
      extract.on('close', (code) => {
        if (code !== 0 && !truncated) {
          reject(new CliLogReadError(`Failed to read archive (tar exit ${code}: ${stderr.trim()})`));
          return;
        }
        resolve({ content: stdout.toString('utf8'), truncated, multipleEntries });
      });
    });
  });
}

async function readLogEntry(relativePath, { full = false } = {}) {
  const resolved = resolveSafePath(relativePath);
  const stat = await fs.promises.stat(resolved);
  if (stat.isDirectory()) {
    throw new CliLogPathError('Not a file.');
  }

  const kind = classify(path.basename(resolved));
  if (kind === 'text') {
    const result = await readTextTail(resolved, full ? FULL_CAP_BYTES : TAIL_BYTES);
    return { kind, ...result };
  }
  if (kind === 'archive') {
    const result = await readArchiveEntryConcat(resolved, ARCHIVE_CAP_BYTES);
    return { kind, ...result };
  }
  return { unsupported: true, kind: 'other', size: stat.size, mtimeMs: stat.mtimeMs };
}

module.exports = { CliLogPathError, CliLogReadError, resolveSafePath, listLogs, readLogEntry };
