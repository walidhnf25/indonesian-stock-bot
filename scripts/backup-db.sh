#!/bin/sh
# Logical backup of the Indonesian Stock Bot database (pg_dump inside the postgres container) into backups/, ENCRYPTED by default.
# Usage: sh scripts/backup-db.sh [label]   -> backups/ai_stock-<label>-<timestamp>.sql.gpg (+ .sha256)
# The dump holds user data: it is encrypted (GnuPG, AES-256; passphrase never stored beside it) before it reaches its
# final name, read back (decrypted in memory and checked) and kept in the git-ignored backups/ folder.
# Copy one somewhere safe, away from this machine. See docs/operations.md.
#   BACKUP_PASSPHRASE_FILE=<file outside the repo>   non-interactive passphrase
#   BACKUP_ALLOW_PLAINTEXT=1                         explicit opt-out (NOT recommended)
#   BACKUP_KEEP=30                                   rotation: newest N per label, 0 = never delete
set -eu
cd "$(dirname "$0")/.."
. scripts/lib-backup.sh

require_container_running
LABEL="$(printf '%s' "${1:-manual}" | tr -c 'A-Za-z0-9-' '-' | cut -c1-40)"
STAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p backups

encrypt=1
if [ "${BACKUP_ALLOW_PLAINTEXT:-0}" = "1" ]; then
  encrypt=0
  echo "WARNING: writing an UNENCRYPTED backup (BACKUP_ALLOW_PLAINTEXT=1)." >&2
else
  have_gpg || { echo "gpg was not found; install GnuPG (Git for Windows includes it) or set GPG_BIN." >&2; exit 1; }
  prepare_passphrase 1
fi

if [ "$encrypt" = "1" ]; then OUT="backups/${DB}-${LABEL}-${STAMP}.sql.gpg"; else OUT="backups/${DB}-${LABEL}-${STAMP}.sql"; fi
TMP="${OUT}.part"
trap 'rm -f "$TMP"' EXIT

if [ "$encrypt" = "1" ]; then
  docker exec "$CONTAINER" pg_dump -U "$DB_USER" --no-owner --no-privileges "$DB" | gpg_encrypt >"$TMP"
else
  docker exec "$CONTAINER" pg_dump -U "$DB_USER" --no-owner --no-privileges "$DB" >"$TMP"
fi

# Plain sh has no pipefail, so a failing pg_dump is caught here: the dump must be complete and decryptable.
if [ "$encrypt" = "1" ]; then KIND_ARG=enc; else KIND_ARG=plain; fi
TABLES="$(verify_dump "$TMP" "$KIND_ARG")" || { echo "The new backup could not be verified; it was discarded." >&2; exit 1; }
SIZE="$(wc -c <"$TMP" | tr -d ' ')"
if [ "$SIZE" -lt 1000 ]; then
  echo "backup looks empty ($SIZE bytes): discarded" >&2
  exit 1
fi

mv "$TMP" "$OUT"
chmod 600 "$OUT" 2>/dev/null || true
printf '%s  %s\n' "$(sha256_of "$OUT")" "$(basename "$OUT")" >"${OUT}.sha256"
trap - EXIT
if [ "$encrypt" = "1" ]; then KIND="encrypted: GnuPG AES-256"; else KIND="NOT encrypted"; fi
echo "ok $OUT ($SIZE bytes, $TABLES tables, $KIND)"
echo "Verified: it decrypts and is a complete pg_dump. Prove it restores with: npm run db:restore-rehearsal"

# Rotation: keep the newest BACKUP_KEEP backups of the SAME label (default 30; 0 turns it off).
# Labels are separate pools on purpose, so a daily job never deletes a manual "pre-<migration>" backup.
# It only runs after the new backup was written and verified, and only matches this exact file-name shape.
KEEP="${BACKUP_KEEP:-30}"
case "$KEEP" in ''|*[!0-9]*) echo "BACKUP_KEEP must be a whole number; rotation skipped." >&2; KEEP=0 ;; esac
if [ "$KEEP" -gt 0 ]; then
  if [ "$encrypt" = "1" ]; then EXT="sql.gpg"; else EXT="sql"; fi
  D8='[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'
  D6='[0-9][0-9][0-9][0-9][0-9][0-9]'
  set -- backups/"${DB}-${LABEL}-"$D8-$D6."$EXT"
  if [ -e "$1" ]; then
    EXCESS=$(( $# - KEEP ))
    N=0
    for old in "$@"; do
      [ "$N" -lt "$EXCESS" ] || break
      rm -f -- "$old" "$old.sha256"
      echo "rotated out (keeping newest $KEEP $LABEL): $(basename "$old")"
      N=$((N + 1))
    done
  fi
fi
