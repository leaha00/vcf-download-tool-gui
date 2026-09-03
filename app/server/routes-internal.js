const fs = require('fs');
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

module.exports = router;
