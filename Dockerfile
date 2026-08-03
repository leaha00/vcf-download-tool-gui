# This image intentionally contains none of Broadcom's vcf-download-tool -
# it's proprietary ("Broadcom Confidential"), licensed per-account, and not
# ours to redistribute. Upload the tar.gz you downloaded from the Broadcom
# portal through the GUI's "Upload CLI" button once the container is
# running (see README.md) - it's extracted into the same persistent volume
# as the activation code/depot ID, so there's nothing to bind-mount and no
# build-time coupling to a specific CLI version.
#
# Base stays glibc (not Alpine/musl): the CLI you upload at runtime bundles
# its own JRE, and that JRE's `java` binary is dynamically linked against
# glibc (verified via `ldd` against a real downloaded CLI archive) - it
# won't run under musl. Vulnerability scans are instead addressed by
# trimming what's actually shipped (see below) and picking up whatever
# Debian security patches are available at build time.
FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY app/package.json ./
RUN npm install --omit=dev

FROM node:20-bookworm-slim

# Picks up whatever Debian security-repo fixes exist as of build time
# (e.g. libgnutls30, libcap2) rather than whatever the base image snapshot
# shipped with.
RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*

ENV TOKEN_DIR=/data/token \
    XDG_DATA_HOME=/data/token/xdg-data \
    DEPOT_DIR=/mnt/vcf-depot \
    PORT=8080 \
    NODE_ENV=production

WORKDIR /app
COPY app/package.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY app/server ./server
COPY entrypoint.sh /entrypoint.sh

# npm/npx/corepack are only ever used at build time (in the deps stage
# above) - this image runs `node server/index.js` directly and never
# invokes them. Their own bundled dependency tree (tar, minimatch, glob,
# brace-expansion, cross-spawn, sigstore, ...) otherwise shows up in
# vulnerability scans despite never executing here.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

# Placeholder UID/GID (1500 just to avoid colliding with the base image's
# built-in "node" user at 1000) - entrypoint.sh remaps this to PUID/PGID
# (default 1000:1000) on every container start, so an NFS depot share owned
# by someone else works without rebuilding the image. See README.md
# "Permissions".
RUN groupadd -r -g 1500 vcfgui \
    && useradd -r -u 1500 -g vcfgui -d /app vcfgui \
    && mkdir -p /data/token /mnt/vcf-depot \
    && chown -R vcfgui:vcfgui /app /data/token /mnt/vcf-depot \
    && chmod +x /entrypoint.sh

EXPOSE 8080
ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "server/index.js"]
