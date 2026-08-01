const fs = require('fs');
const { TOKEN_FILE } = require('./config');

function getStatus() {
  if (!fs.existsSync(TOKEN_FILE)) {
    return { saved: false };
  }
  const stat = fs.statSync(TOKEN_FILE);
  const content = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  const preview = content.length <= 8 ? '*'.repeat(content.length) : `${content.slice(0, 4)}...${content.slice(-4)}`;
  return { saved: true, savedAt: stat.mtime.toISOString(), preview };
}

function save(token) {
  const trimmed = (token || '').trim();
  if (!trimmed) {
    throw new Error('Activation code cannot be empty');
  }
  fs.writeFileSync(TOKEN_FILE, `${trimmed}\n`, { mode: 0o600 });
}

function clear() {
  if (fs.existsSync(TOKEN_FILE)) {
    fs.unlinkSync(TOKEN_FILE);
  }
}

module.exports = { getStatus, save, clear };
