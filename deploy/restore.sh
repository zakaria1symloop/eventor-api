#!/usr/bin/env bash
#
# Eventor — restore a backup produced by deploy/backup.sh.
#
# DESTRUCTIVE: it overwrites the database named by DB_DATABASE and replaces the
# contents of STORAGE_ROOT. Stop the API first.
#
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

ENV_FILE="${ENV_FILE:-${REPO_ROOT}/.env.production}"
COMPOSE_FILE="${COMPOSE_FILE:-${REPO_ROOT}/deploy/docker-compose.yml}"
DOCKER_MYSQL="${DOCKER_MYSQL:-}"

usage() {
  cat <<'USAGE'
Usage: restore.sh <db-dump.sql.gz> <storage.tar.gz> [--yes]

Arguments:
  <db-dump.sql.gz>   gzipped mysqldump produced by deploy/backup.sh
  <storage.tar.gz>   gzipped tar of STORAGE_ROOT produced by deploy/backup.sh

Options:
  --yes, -y          skip the interactive confirmation (for scripted drills)
  --help, -h         show this text

Environment:
  ENV_FILE       path to .env.production  (default: <repo>/.env.production)
  DOCKER_MYSQL   compose service name; when set, mysql runs inside that container
  COMPOSE_FILE   compose file to use with DOCKER_MYSQL

This is DESTRUCTIVE. Stop the API before running it:
  pm2 stop eventor-api        # path B
  docker compose -f deploy/docker-compose.yml stop api   # path A

Example:
  ./deploy/restore.sh /var/backups/eventor/eventor-db-20260101-031500.sql.gz \
                      /var/backups/eventor/eventor-storage-20260101-031500.tar.gz
USAGE
}

log() { printf '%s [restore] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"; }
die() { printf '%s [restore] ERROR: %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >&2; exit 1; }

# ── Arguments ────────────────────────────────────────────────────────────────
ASSUME_YES=0
POSITIONAL=()
for arg in "$@"; do
  case "${arg}" in
    --yes|-y)   ASSUME_YES=1 ;;
    --help|-h)  usage; exit 0 ;;
    -*)         usage >&2; die "unknown option: ${arg}" ;;
    *)          POSITIONAL+=("${arg}") ;;
  esac
done

if [ "${#POSITIONAL[@]}" -ne 2 ]; then
  usage >&2
  die "expected exactly 2 arguments, got ${#POSITIONAL[@]}"
fi

DUMP_PATH="${POSITIONAL[0]}"
STORAGE_PATH="${POSITIONAL[1]}"

[ -r "${DUMP_PATH}" ]    || die "cannot read dump: ${DUMP_PATH}"
[ -r "${STORAGE_PATH}" ] || die "cannot read storage archive: ${STORAGE_PATH}"
[ -r "${ENV_FILE}" ]     || die "cannot read env file: ${ENV_FILE} (set ENV_FILE=...)"

gzip -t "${DUMP_PATH}"    || die "dump is not a valid gzip file: ${DUMP_PATH}"
gzip -t "${STORAGE_PATH}" || die "storage archive is not a valid gzip file: ${STORAGE_PATH}"

# ── Environment ──────────────────────────────────────────────────────────────
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

# ── Confirmation ─────────────────────────────────────────────────────────────
cat <<EOF

  About to RESTORE — this destroys current data.

    database    ${DB_DATABASE} @ ${DB_HOST}:${DB_PORT}${DOCKER_MYSQL:+ (compose service '${DOCKER_MYSQL}')}
      from      ${DUMP_PATH}
    storage     ${STORAGE_ROOT}   (existing contents moved aside)
      from      ${STORAGE_PATH}

  Make sure the API is stopped.

EOF

if [ "${ASSUME_YES}" -ne 1 ]; then
  [ -t 0 ] || die "not a terminal and --yes was not given; refusing to continue"
  printf 'Type the database name (%s) to continue: ' "${DB_DATABASE}"
  read -r answer
  [ "${answer}" = "${DB_DATABASE}" ] || die "confirmation did not match; nothing was changed"
fi

# ── 1. Database ──────────────────────────────────────────────────────────────
log "restoring database ${DB_DATABASE}"
export MYSQL_PWD="${DB_PASSWORD}"

run_mysql() {
  if [ -n "${DOCKER_MYSQL}" ]; then
    docker compose -f "${COMPOSE_FILE}" exec -T \
      -e MYSQL_PWD="${DB_PASSWORD}" "${DOCKER_MYSQL}" \
      mysql -u"${DB_USERNAME}" --default-character-set=utf8mb4 "$@"
  else
    command -v mysql >/dev/null 2>&1 || die "mysql client not found (apt install mysql-client)"
    mysql -h "${DB_HOST}" -P "${DB_PORT}" -u "${DB_USERNAME}" \
      --default-character-set=utf8mb4 "$@"
  fi
}

# Recreate the schema so the restore is not merged into leftover tables.
log "dropping and recreating schema ${DB_DATABASE}"
printf 'DROP DATABASE IF EXISTS `%s`; CREATE DATABASE `%s` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;\n' \
  "${DB_DATABASE}" "${DB_DATABASE}" | run_mysql

log "loading dump (this can take a while)"
gunzip -c "${DUMP_PATH}" | run_mysql "${DB_DATABASE}"
unset MYSQL_PWD
log "database restored"

# ── 2. Storage ───────────────────────────────────────────────────────────────
PARENT="$(dirname -- "${STORAGE_ROOT}")"
LEAF="$(basename -- "${STORAGE_ROOT}")"
mkdir -p "${PARENT}"

if [ -d "${STORAGE_ROOT}" ]; then
  ASIDE="${STORAGE_ROOT}.replaced-$(date -u '+%Y%m%d-%H%M%S')"
  log "moving existing storage aside: ${ASIDE}"
  mv -- "${STORAGE_ROOT}" "${ASIDE}"
fi

log "extracting ${STORAGE_PATH} into ${PARENT}"
tar -xzf "${STORAGE_PATH}" -C "${PARENT}"

[ -d "${STORAGE_ROOT}" ] || die "archive did not contain a '${LEAF}' directory; check the archive layout"
log "storage restored to ${STORAGE_ROOT}"

cat <<EOF

  Done. Next steps:
    1. Make sure ${STORAGE_ROOT} is owned by the app user
       (host:   sudo chown -R deploy:deploy ${STORAGE_ROOT})
       (docker: uid/gid 1001)
    2. Apply any migrations newer than the dump:  pnpm migration:run:prod
    3. Start the API and check https://api.example.com/api/v1/health/ready
    4. Remove the .replaced-* directory once you are satisfied.

EOF
exit 0
