#!/bin/sh
set -e

# ── Railway / Docker volume permissions fix ──────────────────────────
#
# Railway mounts /app/data as an external volume. On first deploy the
# volume is often owned by root (UID 0), so the node user (UID 1000)
# cannot write to /app/data/logs/, /app/data/db_backups/, or the SQLite
# database itself.
#
# When this entrypoint runs as root (Dockerfile.railway: USER root set
# before the ENTRYPOINT line), we fix the ownership immediately and then
# drop to the `node` user before the CMD runs.
#
# When this entrypoint runs as the node user (original Dockerfile), we
# warn like before — the legacy behaviour is preserved.

# Hard Rule #13: never interpolate OMNIROUTE_BASE_PATH (or any runtime path)
# into sed/awk/shell. The Node guard reads process.env itself — invoke with a
# fixed argv only; do not pass the subpath as a CLI argument or script body.
if [ -f docker/ensure-docker-base-path.mjs ]; then
  node docker/ensure-docker-base-path.mjs || exit 1
fi

DATA_PATH="${DATA_DIR:-/app/data}"

if [ "$(id -u)" = "0" ]; then
  # Create writable subdirectories and fix volume ownership for the node user
  mkdir -p "$DATA_PATH/logs/application" "$DATA_PATH/db_backups"
  chown -R node:node "$DATA_PATH"
  echo "INFO: Fixed $DATA_PATH ownership for UID 1000 (node)"

elif [ -d "$DATA_PATH" ] && [ ! -w "$DATA_PATH" ]; then
  echo "WARNING: $DATA_PATH is not writable by the current user (UID $(id -u))."
  if [ "${CONTAINER_HOST:-}" = "podman" ]; then
    echo "Podman bind-mount permissions depend on whether the engine is local or"
    echo "reached through Podman Machine; this container cannot determine that topology."
    echo "Use the host-side fix for your topology:"
    echo "  https://github.com/diegosouzapw/OmniRoute/blob/main/contrib/podman/README.md#data-directory-permissions-by-topology"
  else
    echo "Run this on the host to fix:"
    echo "  sudo chown -R $(id -u):$(id -g) <host-data-dir>"
    echo "  chmod -R u+rwX <host-data-dir>"
  fi
fi

# ── Memory limit override ──────────────────────────────────────────
# If OMNIROUTE_MEMORY_MB is set, build NODE_OPTIONS dynamically so the
# user can tune heap size via environment without editing the Dockerfile.
if [ -n "$OMNIROUTE_MEMORY_MB" ]; then
  export NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=${OMNIROUTE_MEMORY_MB}"
fi

# ── Drop privileges when running as root ───────────────────────────
# The Dockerfile.railway sets USER root before ENTRYPOINT so we can fix
# volume permissions. Here we drop to the `node` user (UID 1000) before
# executing the CMD so the application never runs with root privileges.
if [ "$(id -u)" = "0" ]; then
  exec su -s /bin/sh node -c "exec $*"
fi

exec "$@"
