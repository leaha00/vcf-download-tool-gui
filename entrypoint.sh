#!/usr/bin/env bash
set -e

# A pod under a Pod Security "restricted" policy (see k8s/generic's
# securityContext: runAsUser 1500, runAsNonRoot: true) never reaches this
# script as root at all - Kubernetes enforces that UID at the container
# runtime level before any command in the image runs, so the branch below
# simply never executes there and PSA compliance is unaffected either way.
#
# This only ever fires for plain Docker/Compose, where nothing forces a UID
# and the image's own default is root - exactly the case where a volume
# from an older version of this image (root, or the old PUID/PGID scheme)
# still owns its files under a different UID than the current image's fixed
# 1500:1500, and the fixed-UID process has no capability to chown someone
# else's files itself. Idempotent - a fast no-op once a volume is already
# 1500:1500.
if [ "$(id -u)" = "0" ]; then
  chown -R 1500:1500 /data/token

  # NFS enforces root_squash by default, mapping this "root" to an
  # unprivileged remote identity before it reaches the export - chmod here
  # typically can't override existing permissions, so this is genuinely
  # best-effort, same as it always was. If it doesn't take (check with
  # `ls -l` on the mount from the host), the export needs to already permit
  # UID 1500 - see README.md "Permissions".
  if [ -d "$DEPOT_DIR" ]; then
    chmod -R a+rwx "$DEPOT_DIR" 2>/dev/null || true
  fi

  exec setpriv --reuid=1500 --regid=1500 --clear-groups --no-new-privs "$@"
fi

exec "$@"
