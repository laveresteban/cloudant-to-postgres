#!/usr/bin/env bash
# End-to-end check of the compose stack: seed CouchDB, wait for the migrator to
# copy everything, verify the copy, read the change feed, and run the demo SQL.
#
# Run from the repo root after `docker compose up -d --build --wait`.
# It talks to the services only through `docker compose exec`, so it honours
# COMPOSE_PROJECT_NAME / COMPOSE_FILE and needs no published ports.
set -euo pipefail
cd "$(dirname "$0")/.."

dc() { docker compose "$@"; }
# GET a URL from inside a service container and print the body (node's fetch; the images have no curl).
get() { dc exec -T "$1" node -e "fetch('$2').then(async r => { if (!r.ok) process.exit(1); console.log(await r.text()); })"; }

echo "== seed"
dc exec -T migrator node dist/src/seed.js --count 50

echo "== wait for the copy to verify (verify-cli exits 0 when counts and samples match)"
for i in $(seq 1 30); do
  if report="$(dc exec -T migrator node dist/src/verify-cli.js)"; then echo "$report"; break; fi
  if [ "$i" = 30 ]; then echo "verify did not pass in time" >&2; exit 1; fi
  sleep 2
done

echo "== change feed"
events="$(get migrator 'http://localhost:8090/events?after=0&limit=5')"
echo "$events"
echo "$events" | grep -q '"event_id"' ||{ echo "feed returned no events" >&2; exit 1; }

echo "== alerts service"
get alerts 'http://localhost:8095/health'
get alerts 'http://localhost:8095/alerts?limit=5' >/dev/null

echo "== demo SQL"
for f in normalize.sql demo-queries.sql; do
  dc exec -T postgres psql -U app -d showcase -v ON_ERROR_STOP=1 -q -f "/sql/$f" >/dev/null
  echo "$f ok"
done

echo "== app"
dc exec -T app wget -qO- http://localhost/config.js | grep -q feedUrl
echo "smoke test passed"
