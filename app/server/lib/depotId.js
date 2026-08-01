const fs = require('fs');
const { DEPOT_ID_FILE } = require('./config');
const { runCli } = require('./cliRunner');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function getStatus() {
  if (!fs.existsSync(DEPOT_ID_FILE)) {
    return { set: false };
  }
  const id = fs.readFileSync(DEPOT_ID_FILE, 'utf8').trim();
  return {
    set: true,
    id,
    registerUrl: `https://vcf.broadcom.com/vcf/clm/download-manager/register?serviceId=${id}`,
  };
}

// Generates a brand new random depot ID via the CLI itself (no token
// required for this command) - for first-time setups with no existing ID.
async function generate() {
  const { stdout } = await runCli(['configuration', 'generate', '--software-depot-id', '--force'], {
    requireToken: false,
    ceip: false,
  });
  return { ...getStatus(), cliOutput: extractRegisterLine(stdout) };
}

// Writes a pre-existing depot ID directly (e.g. one already registered on
// the Broadcom portal against the user's activation code from a previous
// install of the CLI elsewhere).
function setExisting(id) {
  const trimmed = (id || '').trim();
  if (!UUID_RE.test(trimmed)) {
    throw new Error('Software depot ID must be a UUID, e.g. c3d3d097-73cc-4260-abd9-75e528ebbf33');
  }
  fs.mkdirSync(require('path').dirname(DEPOT_ID_FILE), { recursive: true });
  fs.writeFileSync(DEPOT_ID_FILE, `${trimmed}\n`, { mode: 0o600 });
  return getStatus();
}

function extractRegisterLine(stdout) {
  const line = stdout.split('\n').find((l) => l.includes('Use this link to register'));
  return line ? line.trim() : null;
}

module.exports = { getStatus, generate, setExisting };
