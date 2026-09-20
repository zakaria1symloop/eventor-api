#!/usr/bin/env bash
#
# Eventor — nightly backup: MySQL dump + STORAGE_ROOT archive.
#
# Reads .env.production (repository root by default) for DB_* and STORAGE_ROOT.
# Writes two timestamped files into $BACKUP_DIR and deletes anything older than
# $RETENTION_DAYS. Logs to stdout; any failure aborts with a non-zero exit.
#
#   sudo install -m 750 -o deploy -g deploy deploy/backup.sh /usr/local/bin/eventor-backup
#   sudo mkdir -p /var/backups/eventor && sudo chown deploy:deploy /var/backups/eventor
#   eventor-backup
#
# Environment overrides:
#   ENV_FILE        path to .env.production        (default: <repo>/.env.production)
#   BACKUP_DIR      output directory               (default: /var/backups/eventor)
#   RETENTION_DAYS  days to keep                   (default: 14)
#   DOCKER_MYSQL    compose service name; when set, mysqldump runs inside it
#                   e.g. DOCKER_MYSQL=mysql COMPOSE_FILE=deploy/docker-compose.yml

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

ENV_FILE="${ENV_FILE:-${REPO_ROOT}/.env.production}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/eventor}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
COMPOSE_FILE="${COMPOSE_FILE:-${REPO_ROOT}/deploy/docker-compose.yml}"
DOCKER_MYSQL="${DOCKER_MYSQL:-}"

log()  { printf '%s [backup] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"; }
die()  { printf '%s [backup] ERROR: %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >&2; exit 1; }

[ -r "${ENV_FILE}" ] || die "cannot read env file: ${ENV_FILE} (set ENV_FILE=...)"

# Load the env file without letting it leak into the surrounding shell history.
set -a
# shellcheck disable=SC1090
. "${ENV_FILE}"
set +a

: "${DB_DATABASE:?DB_DATABASE is not set in ${ENV_FILE}}"
: "${DB_USERNAME:?DB_USERNAME is not set in ${ENV_FILE}}"
: "${STORAGE_ROOT:?STORAGE_ROOT is not set in ${ENV_FILE}}"
DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="${DB_PORT:-3306}"
DB_PASSWORD="${DB_PASSWORD:-}"

STAMP="$(date -u '+%Y%m%d-%H%M%S')"
DUMP_FILE="${BACKUP_DIR}/eventor-db-${STAMP}.sql.gz"
STORAGE_FILE="${BACKUP_DIR}/eventor-storage-${STAMP}.tar.gz"

mkdir -p "${BACKUP_DIR}"
chmod 750 "${BACKUP_DIR}"

# Partial files must never be mistaken for a good backup.
cleanup_partial() {
  local code=$?
  if [ "${code}" -ne 0 ]; then
    rm -f -- "${DUMP_FILE}.part" "${STORAGE_FILE}.part"
    log "failed with exit code ${code}; partial files removed"
  fi
  return "${code}"
}
trap cleanup_partial EXIT

# ── 1. Database ──────────────────────────────────────────────────────────────
log "dumping database ${DB_DATABASE} from ${DB_HOST}:${DB_PORT}"

# MYSQL_PWD keeps the password off the process list (still visible to root).
export MYSQL_PWD="${DB_PASSWORD}"

DUMP_ARGS=(
  --single-transaction   # consistent snapshot of InnoDB without locking writers
  --quick
  --routines
  --triggers
  --events
  --set-gtid-purged=OFF
  --no-tablespaces
  --default-character-set=utf8mb4
)

if [ -n "${DOCKER_MYSQL}" ]; then
  log "using docker compose service '${DOCKER_MYSQL}'"
  docker compose -f "${COMPOSE_FILE}" exec -T \
    -e MYSQL_PWD="${DB_PASSWORD}" "${DOCKER_MYSQL}" \
    mysqldump -u"${DB_USERNAME}" "${DUMP_ARGS[@]}" "${DB_DATABASE}" \
    | gzip -9 > "${DUMP_FILE}.part"
else
  command -v mysqldump >/dev/null 2>&1 || die "mysqldump not found (apt install mysql-client)"
  mysqldump \
    -h "${DB_HOST}" -P "${DB_PORT}" -u "${DB_USERNAME}" \
    "${DUMP_ARGS[@]}" "${DB_DATABASE}" \
    | gzip -9 > "${DUMP_FILE}.part"
fi

unset MYSQL_PWD

# gzip of an empty/failed dump is ~20 bytes; catch that here.
if [ "$(stat -c %s "${DUMP_FILE}.part")" -lt 1024 ]; then
  die "database dump is suspiciously small — refusing to keep it"
fi
mv -- "${DUMP_FILE}.part" "${DUMP_FILE}"
chmod 640 "${DUMP_FILE}"
log "database dump written: ${DUMP_FILE} ($(du -h "${DUMP_FILE}" | cut -f1))"

# ── 2. Storage ───────────────────────────────────────────────────────────────
if [ ! -d "${STORAGE_ROOT}" ]; then
  die "STORAGE_ROOT does not exist or is not a directory: ${STORAGE_ROOT}"
fi

log "archiving storage from ${STORAGE_ROOT}"
tar -czf "${STORAGE_FILE}.part" -C "$(dirname -- "${STORAGE_ROOT}")" "$(basename -- "${STORAGE_ROOT}")"
mv -- "${STORAGE_FILE}.part" "${STORAGE_FILE}"
chmod 640 "${STORAGE_FILE}"
log "storage archive written: ${STORAGE_FILE} ($(du -h "${STORAGE_FILE}" | cut -f1))"

# ── 3. Rotation ──────────────────────────────────────────────────────────────
log "removing backups older than ${RETENTION_DAYS} days in ${BACKUP_DIR}"
DELETED=0
while IFS= read -r -d '' old; do
  rm -f -- "${old}"
  log "  deleted $(basename -- "${old}")"
  DELETED=$((DELETED + 1))
done < <(find "${BACKUP_DIR}" -maxdepth 1 -type f \
           \( -name 'eventor-db-*.sql.gz' -o -name 'eventor-storage-*.tar.gz' \) \
           -mtime "+${RETENTION_DAYS}" -print0)
log "rotation done (${DELETED} file(s) removed)"

trap - EXIT
log "backup complete"
exit 0

# ── Cron ─────────────────────────────────────────────────────────────────────
# Daily at 03:15 (server local time). Install with `crontab -e` as the deploy
# user, or drop the line (with a user column) into /etc/cron.d/eventor-backup:
#
# 15 3 * * * /usr/local/bin/eventor-backup >> /var/log/eventor/backup.log 2>&1
#
# For /etc/cron.d/eventor-backup:
# 15 3 * * * deploy /usr/local/bin/eventor-backup >> /var/log/eventor/backup.log 2>&1
