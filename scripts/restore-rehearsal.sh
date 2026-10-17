#!/bin/sh
# Rehearses a restore + migration on a DISPOSABLE container, never on the live database:
#   1. checks the backup (checksum, decryption, complete pg_dump)
#   2. starts a throwaway postgres from the same image as production (indonesian-stock-bot-postgres:16-pgvector)
#   3. restores the dump into it (an encrypted backup is decrypted in memory: no plaintext file is written)
#   4. runs `prisma migrate deploy` against it and prints row counts
#   5. removes the container
# Usage: sh scripts/restore-rehearsal.sh [backups/ai_stock-<label>-<stamp>.sql.gpg|.sql] [port]
#        (no file = the newest backup). An encrypted backup needs the passphrase
#        (BACKUP_PASSPHRASE_FILE, or a prompt in a terminal).
set -eu
cd "$(dirname "$0")/.."
. scripts/lib-backup.sh

DUMP="${1:-$(ls -1t backups/*.sql.gpg backups/*.sql 2>/dev/null | head -n1 || true)}"
PORT="${2:-5499}"
IMAGE="${POSTGRES_IMAGE:-indonesian-stock-bot-postgres:16-pgvector}"
NAME="indonesian-stock-bot-restore-rehearsal"
[ -n "$DUMP" ] && [ -f "$DUMP" ] || { echo "no dump found (run: npm run db:backup)" >&2; exit 1; }

# Integrity first: the recorded checksum must match.
if [ -f "${DUMP}.sha256" ]; then
  EXPECTED="$(cut -d' ' -f1 "${DUMP}.sha256")"
  [ "$(sha256_of "$DUMP")" = "$EXPECTED" ] || { echo "checksum mismatch for $DUMP" >&2; exit 1; }
  echo "checksum ok"
fi
if is_encrypted_file "$DUMP"; then
  have_gpg || { echo "gpg was not found; it is needed to read $DUMP." >&2; exit 1; }
  prepare_passphrase 0
fi
TABLES="$(verify_dump "$DUMP")" || exit 1
echo "backup readable: complete dump with $TABLES tables"

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" -e POSTGRES_PASSWORD=rehearsal -e POSTGRES_DB=rehearsal -p "127.0.0.1:${PORT}:5432" "$IMAGE" >/dev/null
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT
i=0
until docker exec "$NAME" pg_isready -U postgres -d rehearsal >/dev/null 2>&1; do
  i=$((i + 1)); [ "$i" -gt 60 ] && { echo "rehearsal container did not become ready" >&2; exit 1; }; sleep 1
done
# the dump may reference the vector extension: it exists in the image
dump_stream "$DUMP" | docker exec -i "$NAME" psql -U postgres -d rehearsal -v ON_ERROR_STOP=1 -q >/dev/null
echo "restored $DUMP"
DATABASE_URL="postgresql://postgres:rehearsal@127.0.0.1:${PORT}/rehearsal" npx prisma migrate deploy
docker exec "$NAME" psql -U postgres -d rehearsal -tAc "
  SELECT 'users='||(SELECT count(*) FROM \"User\")||' alerts='||(SELECT count(*) FROM \"Alert\")
       ||' candles='||(SELECT count(*) FROM \"StockDailyPrice\")||' migrations='||(SELECT count(*) FROM \"_prisma_migrations\")"
echo "rehearsal ok (container removed)"
