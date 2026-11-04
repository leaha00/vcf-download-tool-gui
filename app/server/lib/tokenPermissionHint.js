// A stale /data/token volume - carried over from before v1.5.1.3's non-root
// security hardening (root + PUID/PGID -> a fixed, capability-less UID/GID
// 1500:1500) - surfaces as a plain EACCES/EPERM from Node with no clue what
// to actually do about it. Both the CLI-install and CLI-run paths recognize
// that specific failure and append this instead of just the raw OS error.
//
// entrypoint.sh already self-heals this automatically on every container
// start under plain Docker/Compose (no user override), so a container
// running that entrypoint shouldn't actually reach this message anymore
// after a restart - this is the fallback for Kubernetes (or anything else
// that forces a non-root UID at the container-runtime level, so the
// entrypoint's root-only fixup branch never runs), where it takes an
// explicit one-off privileged fix outside the app's own container.
function isPermissionError(err) {
  return !!err && (err.code === 'EACCES' || err.code === 'EPERM');
}

const PERMISSION_HINT = 'This usually means /data/token still has files owned by an older '
  + "container UID from before v1.5.1.3's non-root security hardening. On plain Docker/Compose "
  + 'this should self-heal automatically on the next container restart - try that first. If '
  + "it persists (e.g. under Kubernetes, where nothing here ever runs as root), fix ownership "
  + 'once from outside the container: `docker run --rm -v <your-token-volume>:/data/token busybox '
  + 'chown -R 1500:1500 /data/token` (or the equivalent one-off Kubernetes Job against the same '
  + 'PVC). See README.md "Upgrading from before v1.5.1.3".';

module.exports = { isPermissionError, PERMISSION_HINT };
