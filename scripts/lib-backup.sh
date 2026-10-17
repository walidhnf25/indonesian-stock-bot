# Shared helpers for the backup / restore scripts (POSIX sh). Sourced, not executed.
# Backups hold user data, so they are ENCRYPTED (GnuPG symmetric, AES-256, integrity-protected).
# The passphrase is NEVER on a command line and never written beside a backup. It comes from
#   * BACKUP_PASSPHRASE_FILE : a file YOU keep outside the repository (first line = passphrase), or
#   * an interactive prompt when run from a terminal.
# Losing the passphrase makes the encrypted backups unrecoverable.
# Only the container, database and user names are read from the environment; nothing secret is printed.

CONTAINER="${POSTGRES_CONTAINER:-ai-stock-postgres}"
DB="${POSTGRES_DB:-ai_stock}"
DB_USER="${POSTGRES_USER:-postgres}"
GPG_BIN="${GPG_BIN:-gpg}"
GPG_TIMEOUT="${GPG_TIMEOUT:-300}"
PASSPHRASE=""
PASSPHRASE_MODE=""
TIMEOUT_CMD=""
if command -v timeout >/dev/null 2>&1; then TIMEOUT_CMD="timeout $GPG_TIMEOUT"; fi

have_gpg() { command -v "$GPG_BIN" >/dev/null 2>&1; }

is_encrypted_file() { case "$1" in *.gpg) return 0 ;; *) return 1 ;; esac; }

require_container_running() {
  if [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || echo false)" != "true" ]; then
    echo "Container '$CONTAINER' is not running. Start it with: npm run db:up" >&2
    exit 1
  fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

# prepare_passphrase <confirm 0|1>: sets PASSPHRASE_MODE to "file" or "prompt", or exits with help.
prepare_passphrase() {
  _confirm="${1:-0}"
  if [ -n "${BACKUP_PASSPHRASE_FILE:-}" ]; then
    [ -r "$BACKUP_PASSPHRASE_FILE" ] || { echo "BACKUP_PASSPHRASE_FILE is set but not readable." >&2; exit 1; }
    [ -s "$BACKUP_PASSPHRASE_FILE" ] || { echo "The passphrase file is empty." >&2; exit 1; }
    case "$(cd "$(dirname "$BACKUP_PASSPHRASE_FILE")" && pwd)/" in
      "$(pwd)"/*) echo "WARNING: the passphrase file is inside the repository folder. Keep it elsewhere (and never next to the backups)." >&2 ;;
    esac
    PASSPHRASE_MODE=file
    return 0
  fi
  if [ -t 0 ]; then
    trap 'stty echo 2>/dev/null || true; exit 130' INT TERM
    printf 'Backup passphrase: ' >&2
    stty -echo 2>/dev/null || true
    IFS= read -r PASSPHRASE || true
    stty echo 2>/dev/null || true
    printf '\n' >&2
    [ -n "$PASSPHRASE" ] || { echo "Empty passphrase refused." >&2; exit 1; }
    if [ "$_confirm" = "1" ]; then
      printf 'Repeat passphrase: ' >&2
      stty -echo 2>/dev/null || true
      IFS= read -r _second || true
      stty echo 2>/dev/null || true
      printf '\n' >&2
      [ "$PASSPHRASE" = "$_second" ] || { echo "The passphrases differ." >&2; exit 1; }
    fi
    trap - INT TERM
    PASSPHRASE_MODE=prompt
    return 0
  fi
  cat >&2 <<'MSG'
No passphrase source. Either run this from a terminal (you will be prompted), or point
BACKUP_PASSPHRASE_FILE at a file that holds the passphrase on its first line, kept OUTSIDE this
repository, for example:  export BACKUP_PASSPHRASE_FILE="$HOME/.indonesian-stock-bot-backup-passphrase"
To make an UNENCRYPTED backup anyway (not recommended): BACKUP_ALLOW_PLAINTEXT=1
MSG
  exit 1
}

# gpg_run <gpg args...>: stdin -> stdout, passphrase on a private file descriptor (never an argument).
gpg_run() {
  if [ "$PASSPHRASE_MODE" = "file" ]; then
    # shellcheck disable=SC2086
    $TIMEOUT_CMD "$GPG_BIN" --batch --yes --quiet --pinentry-mode loopback --passphrase-fd 3 "$@" 3<"$BACKUP_PASSPHRASE_FILE"
  else
    # shellcheck disable=SC2086
    $TIMEOUT_CMD "$GPG_BIN" --batch --yes --quiet --pinentry-mode loopback --passphrase-fd 3 "$@" 3<<EOF_PASSPHRASE
$PASSPHRASE
EOF_PASSPHRASE
  fi
}
gpg_encrypt() { gpg_run --symmetric --cipher-algo AES256 --s2k-mode 3 --s2k-count 65011712 --compress-algo none; }
gpg_decrypt() { gpg_run --decrypt; }

# dump_stream <file>: the plain pg_dump text of a backup, decrypting on the fly (never to disk).
dump_stream() {
  if is_encrypted_file "$1"; then gpg_decrypt <"$1"; else cat "$1"; fi
}

# verify_dump <file> [enc|plain]: a backup that cannot be read back is not a backup. Decrypts (a failing
# gpg is detected on its own, because plain sh has no pipefail), then requires at least one table and the
# trailer pg_dump writes only when it finished. Prints "<tables>" on success. The kind is taken from the
# file name unless given (a half-written "x.sql.gpg.part" is encrypted although it does not end in .gpg).
verify_dump() {
  _kind="${2:-}"
  if [ -z "$_kind" ]; then if is_encrypted_file "$1"; then _kind=enc; else _kind=plain; fi; fi
  if [ "$_kind" = "enc" ]; then
    gpg_decrypt <"$1" >/dev/null || { echo "could not decrypt $1 (wrong passphrase or damaged file)" >&2; return 1; }
    _stream() { gpg_decrypt <"$1"; }
  else
    _stream() { cat "$1"; }
  fi
  _stats="$(_stream "$1" | awk '/^CREATE TABLE/{t++} /^-- PostgreSQL database dump complete/{c=1} END{print t+0, c+0}')"
  _tables="${_stats% *}"
  _complete="${_stats#* }"
  if [ "$_tables" -lt 1 ] || [ "$_complete" != "1" ]; then
    echo "$1 does not look like a complete dump ($_tables tables, complete marker: $_complete)" >&2
    return 1
  fi
  printf '%s\n' "$_tables"
}
