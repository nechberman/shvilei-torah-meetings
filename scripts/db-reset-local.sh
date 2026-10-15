#!/usr/bin/env bash
set -euo pipefail
DB=${DB:-shvilei_test}
sudo -u postgres dropdb --if-exists "$DB" >/dev/null
sudo -u postgres createdb "$DB"
sudo -u postgres psql -q -v ON_ERROR_STOP=1 -d "$DB" -f supabase/tests/00_local_shim.sql
for f in supabase/migrations/*.sql; do
  sudo -u postgres psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$f"
done
echo "db ready"
