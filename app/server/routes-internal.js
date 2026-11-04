const fs = require('fs');
const path = require('path');
const express = require('express');
const depotServe = require('./lib/depotServe');
const { getDepotStorage } = require('./lib/diskUsage');

const router = express.Router();

// Same depot-store stats the public GUI's own topbar shows, mirrored here
// so vcf-web-depot (which has no filesystem access of its own) can render
// the same storage bar.
router.get('/storage', async (req, res) => {
  const storage = await getDepotStorage();
  res.json(storage || { totalBytes: 0, usedBytes: 0, freeBytes: 0, usedPercent: 0, unavailable: true });
});

// Recursive total size of one directory - see depotServe.getDirSize for why
// this is a separate, on-demand endpoint rather than part of /depot/*.
router.get('/depot-size/*', async (req, res) => {
  const relativePath = req.params[0] || '';

  let resolved;
  try {
    resolved = depotServe.resolveSafePath(relativePath);
  } catch (err) {
    if (err instanceof depotServe.DepotPathError) {
      res.status(400).json({ error: err.message });
      return;
    }
    res.status(500).json({ error: 'Internal error resolving path.' });
    return;
  }

  let stat;
  try {
    stat = await fs.promises.stat(resolved);
  } catch (err) {
    res.status(404).json({ error: 'Not found.' });
    return;
  }

  if (!stat.isDirectory()) {
    res.status(400).json({ error: 'Not a directory.' });
    return;
  }

  try {
    const size = await depotServe.getDirSize(relativePath);
    res.json({ path: relativePath, size });
  } catch (err) {
    res.status(500).json({ error: 'Failed to compute directory size.' });
  }
});

// Internal-only surface (mounted on INTERNAL_PORT, never published to the
// host) for a separate depot-serving container that has no filesystem
// access of its own - see lib/depotServe.js for the path-safety guard this
// leans on. Directories come back as JSON; files are streamed directly via
// res.sendFile() (Range/conditional-request support for free via Express's
// own `send` dependency, no hand-rolled buffering).
router.get('/depot/*', async (req, res) => {
  const relativePath = (req.params[0] || '').replace(/^\/+|\/+$/g, '');

  let resolved;
  try {
    resolved = depotServe.resolveSafePath(relativePath);
  } catch (err) {
    if (err instanceof depotServe.DepotPathError) {
      res.status(400).json({ error: err.message });
      return;
    }
    res.status(500).json({ error: 'Internal error resolving path.' });
    return;
  }

  let stat;
  try {
    stat = await fs.promises.stat(resolved);
  } catch (err) {
    res.status(404).json({ error: 'Not found.' });
    return;
  }

  if (stat.isDirectory()) {
    try {
      const entries = await depotServe.listDir(relativePath);
      res.json({ type: 'dir', path: relativePath, entries });
    } catch (err) {
      res.status(500).json({ error: 'Failed to list directory.' });
    }
    return;
  }

  res.sendFile(resolved, { dotfiles: 'deny' }, (err) => {
    if (err && !res.headersSent) {
      res.status(err.status || 500).json({ error: 'Failed to send file.' });
    }
  });
});

// Uploads one file into an existing depot directory. This internal app has
// no body-parser middleware at all (see index.js), so `req` is still the
// raw request stream here - that's what lets a multi-GB VCF binary write
// straight to disk without ever buffering the whole thing in memory the way
// express.json()/multer would. Rejects overwriting anything that already
// exists rather than silently clobbering it - the caller re-uploads under a
// different name or deletes the old one first.
router.put('/depot/*', async (req, res) => {
  const relativePath = (req.params[0] || '').replace(/^\/+|\/+$/g, '');
  if (!relativePath || relativePath.endsWith('/')) {
    res.status(400).json({ error: 'A file name is required.' });
    return;
  }

  let resolved;
  try {
    resolved = depotServe.resolveSafePath(relativePath);
  } catch (err) {
    if (err instanceof depotServe.DepotPathError) {
      res.status(400).json({ error: err.message });
      return;
    }
    res.status(500).json({ error: 'Internal error resolving path.' });
    return;
  }

  let parentStat;
  try {
    parentStat = await fs.promises.stat(path.dirname(resolved));
  } catch (err) {
    parentStat = null;
  }
  if (!parentStat || !parentStat.isDirectory()) {
    res.status(400).json({ error: 'Target directory does not exist.' });
    return;
  }

  try {
    await fs.promises.access(resolved);
    res.status(409).json({ error: 'A file or folder with that name already exists.' });
    return;
  } catch (err) {
    // Doesn't exist yet - good, proceed to write it.
  }

  // 'wx' is the authoritative guard against overwriting (fails with EEXIST
  // if the target appears between the access() check above and this open) -
  // the check above just gives the common case a clearer error message.
  const writeStream = fs.createWriteStream(resolved, { flags: 'wx' });
  let responded = false;

  const fail = (status, message) => {
    if (responded) return;
    responded = true;
    writeStream.destroy();
    fs.promises.unlink(resolved).catch(() => {});
    if (!res.headersSent) res.status(status).json({ error: message });
  };

  req.on('error', () => fail(400, 'Upload interrupted.'));
  writeStream.on('error', (err) => {
    fail(err.code === 'EEXIST' ? 409 : 500, err.code === 'EEXIST'
      ? 'A file or folder with that name already exists.'
      : 'Failed to write file.');
  });
  writeStream.on('finish', async () => {
    if (responded) return;
    responded = true;
    let size = null;
    try {
      size = (await fs.promises.stat(resolved)).size;
    } catch (err) {
      // Written fine either way - size is just a nice-to-have in the response.
    }
    res.status(201).json({ name: path.basename(resolved), size });
  });

  req.pipe(writeStream);
});

module.exports = router;
