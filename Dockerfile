# This image intentionally contains none of Broadcom's vcf-download-tool -
# it's proprietary ("Broadcom Confidential"), licensed per-account, and not
# ours to redistribute. Upload the tar.gz you downloaded from the Broadcom
# portal through the GUI's "Upload CLI" button once the container is
# running (see README.md) - it's extracted into the same persistent volume
# as the activation code/depot ID, so there's nothing to bind-mount and no
# build-time coupling to a specific CLI version.
FROM node:20-bookworm-slim

ENV TOKEN_DIR=/data/token \
    XDG_DATA_HOME=/data/token/xdg-data \
    DEPOT_DIR=/mnt/vcf-depot \
    PORT=8080 \
    NODE_ENV=production

WORKDIR /app
COPY app/package.json ./
RUN npm install --omit=dev
COPY app/server ./server
COPY entrypoint.sh /entrypoint.sh

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
