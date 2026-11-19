#!/usr/bin/env bash
# Dumps the whole library (books + versions live in Postgres) into one file.
set -euo pipefail

DATABASE_URL="${DATABASE_URL:-postgres://booksmith:booksmith@127.0.0.1:55432/booksmith}"
OUT_DIR="${OUT_DIR:-./backups}"
mkdir -p "$OUT_DIR"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$OUT_DIR/booksmith-$STAMP.dump"

pg_dump --no-owner --format=custom --file="$OUT" "$DATABASE_URL"

echo "wrote $OUT ($(du -h "$OUT" | cut -f1))"
echo "restore with: pg_restore --clean --if-exists --no-owner --dbname=\"$DATABASE_URL\" \"$OUT\""
