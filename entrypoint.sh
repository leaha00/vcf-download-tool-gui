#!/usr/bin/env bash
set -e

# Starts as root so it can remap the app user's UID/GID and grant it access
# to the NFS depot share, then drops privileges for the actual Node
# process. No fixed default is "correct" for everyone - a fresh depot share
# needs no thought at all (1000:1000 just works), one with pre-existing
# content owned by someone else needs PUID/PGID set to match it. Either
# way, no rebuild required.
PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

groupmod -o -g "$PGID" vcfgui
usermod -o -u "$PUID" vcfgui

# Only chown paths this image itself owns. /mnt/vcf-depot is the user's own
# mount - overwriting its ownership would be a surprising thing for this
# container to do to someone else's files. /app and /data/token cover
# everything the app writes itself, including the CLI once it's uploaded
# (it lives under /data/token/cli - see cliInstall.js) - no separate step
# needed for that, this chown already reaches it.
chown -R vcfgui:vcfgui /app /data/token

# NFS (unlike most local filesystems) enforces root_squash by default, which
# maps this container's root to an unprivileged remote identity - chmod as
# "root" here typically can't override existing permissions, so this is
# genuinely best-effort. If it doesn't take (check with `ls -l` on the NFS
# mount from the host), PUID/PGID has to match the share's real owner - see
# README.md "Permissions".
if [ -d "$DEPOT_DIR" ]; then
  chmod -R a+rwx "$DEPOT_DIR" 2>/dev/null || true
fi

exec setpriv --reuid="$PUID" --regid="$PGID" --clear-groups --no-new-privs "$@"
