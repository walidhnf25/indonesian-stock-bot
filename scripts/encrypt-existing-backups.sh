#!/bin/sh
# Makes ENCRYPTED copies of the older plaintext backups (backups/*.sql).
#   sh scripts/encrypt-existing-backups.sh [folder]      (default folder: backups)
# Each copy is verified (decrypted in memory, byte-identical to the original, complete pg_dump) before it is kept.
# The plaintext originals are NEVER deleted by this script: after you have checked the encrypted copies
# (sh scripts/restore-rehearsal.sh backups/<file>.sql.gpg) you remove the originals yourself; the exact
# commands are printed at the end.
set -eu
cd "$(dirname "$0")/.."
. scripts/lib-backup.sh

DIR="${1:-backups}"
have_gpg || { echo "gpg was not found; install GnuPG (Git for Windows includes it) or set GPG_BIN." >&2; exit 1; }
prepare_passphrase 1

converted=0
skipped=0
originals=""
for plain in "$DIR"/*.sql; do
  [ -f "$plain" ] || continue
  enc="${plain}.gpg"
  originals="${originals}${plain}
"
  if [ -f "$enc" ]; then
    echo "already has an encrypted copy: $(basename "$plain")"
    skipped=$((skipped + 1))
    continue
  fi
  tmp="${enc}.part"
  trap 'rm -f "$tmp"' EXIT
  gpg_encrypt <"$plain" >"$tmp"
  verify_dump "$tmp" enc >/dev/null || { echo "Could not read back the encrypted copy of $plain; it was discarded." >&2; exit 1; }
  # The decrypted stream must be byte-identical to the original.
  [ "$(gpg_decrypt <"$tmp" | { if command -v sha256sum >/dev/null 2>&1; then sha256sum; else shasum -a 256; fi; } | cut -d' ' -f1)" = "$(sha256_of "$plain")" ] \
    || { echo "Decrypted copy differs from the original for $plain; it was discarded." >&2; exit 1; }
  mv "$tmp" "$enc"
  chmod 600 "$enc" 2>/dev/null || true
  printf '%s  %s\n' "$(sha256_of "$enc")" "$(basename "$enc")" >"${enc}.sha256"
  trap - EXIT
  echo "encrypted: $(basename "$plain") -> $(basename "$enc")"
  converted=$((converted + 1))
done

echo
echo "Encrypted $converted new copy/copies; $skipped already existed."
if [ -n "$originals" ]; then
  echo
  echo "Plaintext originals that still exist (NOT deleted):"
  printf '%s' "$originals" | while read -r f; do echo "  $f"; done
  echo
  echo "When you have verified the encrypted copies (restore rehearsal) you can remove the originals with:"
  printf '%s' "$originals" | while read -r f; do echo "  rm \"$f\""; done
fi
exit 0
