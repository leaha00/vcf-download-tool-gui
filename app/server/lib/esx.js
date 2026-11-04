const { runCli } = require('./cliRunner');
const { TOKEN_FILE } = require('./config');

// --- `esx configuration` / `esx download` ----------------------------------
//
// Unlike `binaries`/`artifacts`, `esx download` takes no --vcf-version, no
// --id, no per-item selection at all (confirmed against `esx download
// --help` on CLI 9.1.1.0) - it just pulls everything from 4 fixed, non-
// removable depot sources (base images, IOVP drivers, vendor add-ons,
// VMware Tools) for whichever ESXi "host platform" lines are currently
// enabled. There's no way to fetch vendor add-ons on their own - they
// always come bundled with the other 3 sources in one `esx download`.
//
// Scoping happens separately, beforehand, via `esx configuration
// --enable-host=<HOST_PLATFORMS>` / `--disable-host=<HOST_PLATFORMS>`,
// which persists in the CLI's own config rather than being a download-time
// flag. So the GUI's job is: sync that config to match what the user
// checked, then run the one unscoped `esx download`.
//
// Only 8.0+ lines are ever offered - 6.7 and 7.0 are EOL for anything this
// GUI targets (VCF 9.x) and are force-disabled on every sync below,
// regardless of what's checked, so they can never be silently re-enabled.
const HOST_PLATFORMS = [
  { key: 'embeddedEsx-8.0-INTL', label: 'ESXi 8.0 (embeddedEsx)' },
  { key: 'embeddedEsx-9.0-INTL', label: 'ESXi 9.0 (embeddedEsx)' },
  { key: 'embeddedEsx-9.1-INTL', label: 'ESXi 9.1 (embeddedEsx)' },
  { key: 'esxio-8.0-INTL', label: 'ESXi 8.0 (esxio)' },
  { key: 'esxio-9.0-INTL', label: 'ESXi 9.0 (esxio)' },
  { key: 'esxio-9.1-INTL', label: 'ESXi 9.1 (esxio)' },
  { key: 'armEsx-9.1-INTL', label: 'ESXi 9.1 (ARM)' },
];
const HOST_KEYS = new Set(HOST_PLATFORMS.map((h) => h.key));

// The exact 6.7/7.0 lines `esx configuration --get` reports by default -
// verbatim strings the CLI itself printed, not guessed. Never offered in
// the GUI; always pushed onto --disable-host alongside whatever the user
// unchecked.
const ALWAYS_DISABLE = ['embeddedEsx-6.7-INTL', 'embeddedEsx-7.0-INTL'];

// `esx configuration --get` has no [DEPOT] auth group in its own --help -
// it reads/writes the CLI's local config, no activation code needed. And
// no --ceip option either (same family as `configuration generate|get` -
// see cliRunner.js's README note), so it must be called with ceip: false.
async function getEsxConfig() {
  const { stdout } = await runCli(['esx', 'configuration', '--get'], {
    requireToken: false,
    ceip: false,
  });

  // The URL table up top is a normal pipe table; the host-version scoping
  // list below it is freeform text, one key per line, under this heading -
  // parse it directly rather than trying to force it through parseTable.
  const marker = 'Host Versions for which patch content will be downloaded:';
  const idx = stdout.indexOf(marker);
  const enabled = new Set(
    idx === -1
      ? []
      : stdout
          .slice(idx + marker.length)
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .filter((l) => !l.startsWith('Log file'))
  );

  return {
    hostPlatforms: HOST_PLATFORMS.map((h) => ({ ...h, enabled: enabled.has(h.key) })),
  };
}

// Syncs the persisted `esx configuration` host-platform scoping to exactly
// `enabledKeys` (any unknown/6.7/7.0 keys in it are ignored - the 8.0+
// candidate list here is the only thing ever enabled). Every unlisted
// candidate, plus the two always-excluded 6.7/7.0 lines, goes onto
// --disable-host. Each `esx configuration` call takes exactly one action
// (its own --help marks --get/--add-url/--remove-url/--enable-host/
// --disable-host all as mutually exclusive top-level actions), so this is
// up to two CLI invocations rather than one combined call.
async function syncHostVersions(enabledKeys) {
  const wanted = new Set((Array.isArray(enabledKeys) ? enabledKeys : []).filter((k) => HOST_KEYS.has(k)));
  const toDisable = [...ALWAYS_DISABLE, ...HOST_PLATFORMS.filter((h) => !wanted.has(h.key)).map((h) => h.key)];
  const toEnable = [...wanted];

  if (toDisable.length > 0) {
    await runCli(['esx', 'configuration', `--disable-host=${toDisable.join(',')}`], {
      requireToken: false,
      ceip: false,
    });
  }
  if (toEnable.length > 0) {
    await runCli(['esx', 'configuration', `--enable-host=${toEnable.join(',')}`], {
      requireToken: false,
      ceip: false,
    });
  }

  return getEsxConfig();
}

module.exports = { getEsxConfig, syncHostVersions, HOST_PLATFORMS, HOST_KEYS };
