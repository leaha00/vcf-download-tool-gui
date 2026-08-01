const { runCli } = require('./cliRunner');

// Since the CLI is bind-mounted by the user rather than shipped with this
// image, we can't assume anything about its internal file layout - ask the
// binary itself via --version rather than reading conf/tool-version.txt.
// Cached briefly since it spawns a JVM; failures (CLI not mounted yet,
// wrong path, ...) are cached for a much shorter time so a fix takes effect
// quickly without hammering a broken/missing CLI on every request.
const SUCCESS_TTL_MS = 15 * 60 * 1000;
const FAILURE_TTL_MS = 30 * 1000;

let cache = null; // { value, fetchedAt, ttl }

async function getCliVersion() {
  if (cache && Date.now() - cache.fetchedAt < cache.ttl) {
    return cache.value;
  }

  let value = null;
  try {
    const { stdout } = await runCli(['--version'], { requireToken: false, ceip: false, timeoutMs: 20000 });
    // Banner prints "Version: 9.1.0.0400.25570101" (vcf-version + trailing
    // build number) - the GUI only wants the vcf-version part.
    const match = /^Version:\s*(\S+)/m.exec(stdout);
    if (match) value = match[1].split('.').slice(0, 4).join('.');
  } catch (err) {
    value = null;
  }

  cache = { value, fetchedAt: Date.now(), ttl: value ? SUCCESS_TTL_MS : FAILURE_TTL_MS };
  return value;
}

function invalidate() {
  cache = null;
}

module.exports = { getCliVersion, invalidate };
