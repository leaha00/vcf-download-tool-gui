const path = require('path');
const express = require('express');
const { PORT } = require('./lib/config');
const apiRouter = require('./routes');

const app = express();
app.use(express.json());
app.use('/api', apiRouter);
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`VCF Download Tool GUI listening on port ${PORT}`);
});
