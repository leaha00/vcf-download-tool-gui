const path = require('path');
const express = require('express');
const { PORT, INTERNAL_PORT } = require('./lib/config');
const apiRouter = require('./routes');
const internalRouter = require('./routes-internal');
const refreshScheduler = require('./lib/refreshScheduler');

const publicApp = express();
publicApp.use(express.json());
publicApp.use('/api', apiRouter);
publicApp.use(express.static(path.join(__dirname, 'public')));

refreshScheduler.start();

publicApp.listen(PORT, () => {
  console.log(`VCF Download Tool GUI listening on port ${PORT}`);
});

// Separate Express instance (not a second app.listen() on the same app) so
// these internal, unauthenticated, filesystem-exposing routes can never
// become reachable through the public port's middleware stack - see
// routes-internal.js.
const internalApp = express();
internalApp.use('/internal', internalRouter);

internalApp.listen(INTERNAL_PORT, () => {
  console.log(`VCF Download Tool GUI internal depot API listening on port ${INTERNAL_PORT}`);
});
