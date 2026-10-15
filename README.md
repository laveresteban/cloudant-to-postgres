# Cloudant / CouchDB to Postgres: showcase, live migrator, and change feed

[![CI](https://github.com/laveresteban/cloudant-to-postgres/actions/workflows/ci.yml/badge.svg)](https://github.com/laveresteban/cloudant-to-postgres/actions/workflows/ci.yml)

A kit for sales engineers and consultants discussing a move from IBM Cloudant (or CouchDB) to Postgres. It has these parts:

1. **The case.** [docs/why-postgres.md](docs/why-postgres.md) covers the benefits and the honest trade-offs.
2. **The path.** [docs/migration-path.md](docs/migration-path.md) covers six phases from assessment to decommission, with a concept map.
3. **The migrator** (`migrator/`). It streams every change from the source's `_changes` feed into Postgres, backfilling from the start and then tailing the feed. Rows, the checkpoint, and an outbox of change events commit in one transaction.
4. **The change feed** (`GET /events`, `GET /events/stream`). Any service or app can consume the outbox: pull it as JSON, or subscribe over Server-Sent Events.
5. **An app** (`app/`). A live order board built from the feed.
6. **A microservice** (`services/alerts/`). Reads the feed over HTTP, raises alerts, and keeps its own cursor in Postgres.

Run the live demo with [docs/demo-script.md](docs/demo-script.md). Deploy to AWS with [deploy/aws/README.md](deploy/aws/README.md).

```
              ┌──────────── migrator ────────────┐
Cloudant ───▶ │ _changes → docs + checkpoint      │
(or CouchDB)  │          → change_events (outbox) │
              └──────────────┬────────────────────┘
                 GET /events, GET /events/stream
                 ┌───────────┴────────────┐
                 ▼                        ▼
         app (order board)       alerts microservice
         browser, SSE            GET /events, own cursor
                                 → alerts table, GET /alerts
```

## Quick start (local, Docker)

Requires Docker and Docker Compose. Stop any older stack first, because `init.sql` changes only apply to a fresh Postgres volume (`docker compose down -v` resets it).

```sh
docker compose up -d --build
docker compose exec migrator node dist/src/seed.js --count 500
docker compose exec postgres psql -U app -d showcase -f /sql/normalize.sql
```

| What | Where |
|---|---|
| Live order board (the app) | http://localhost:8080 |
| Migrator dashboard | http://localhost:8090 |
| Change feed (JSON) | http://localhost:8090/events?after=0&limit=10 |
| Change feed (SSE) | http://localhost:8090/events/stream |
| Alerts API | http://localhost:8095/alerts |
| CouchDB (the stand-in for Cloudant) | http://localhost:5984/_utils (`admin` / `admin`) |
| Postgres | `docker compose exec postgres psql -U app -d showcase` |

Stream live changes while you watch the app:

```sh
docker compose exec migrator node dist/src/seed.js --live
```

Check the copy (exit 0 means it matches):

```sh
docker compose exec migrator node dist/src/verify-cli.js
```

## Deploy to AWS

```sh
cd deploy/aws
cp terraform.tfvars.example terraform.tfvars   # fill in the source URL and your IP
./deploy.sh
```

This creates ECS Fargate services for the migrator and alerts, an RDS Postgres instance, an ALB, Secrets Manager entries, and an S3 site for the app. `terraform output` prints the URLs. See [deploy/aws/README.md](deploy/aws/README.md) for the architecture, the single-writer rule, the demo posture, and teardown.

## Layout

```
docs/                       the value story, migration path and demo script
db/normalize.sql            views and a materialized view that give the JSON a relational shape
db/demo-queries.sql         the queries used in the demo
migrator/                   streaming service (TypeScript, Node 22+, runtime dependency: pg)
  schema.sql                landing, checkpoint and change_events tables; applied on every start
  src/sync.ts               read a page after the checkpoint, apply it, repeat
  src/sink.ts               one transaction: rows + outbox events + checkpoint
  src/feed.ts               GET /events and GET /events/stream
  src/verify.ts             cutover gate: counts and sampled body hashes
  public/index.html         migrator dashboard
app/                        live order board (static; config.js sets the service URLs)
services/alerts/            alerts microservice (TypeScript, own Dockerfile, own schema)
  src/rules.ts              pure alert rules
  src/consumer.ts           pull loop with a durable cursor
  test/contract.test.ts     runs the real migrator feed server against the consumer
deploy/aws/                 Terraform for ECS, RDS, ALB, Secrets Manager, S3
docker-compose.yml          local stack: CouchDB, Postgres, migrator, alerts, app
scripts/smoke.sh            end-to-end check of the running compose stack (used by CI)
.github/workflows/ci.yml    tests, Terraform checks, compose smoke test, container images
```

## Configuration

Migrator:

| Variable | Default | Meaning |
|---|---|---|
| `COUCH_URL` | `http://localhost:5984` | CouchDB or Cloudant base URL |
| `COUCH_DB` | `shop` | Source database name |
| `COUCH_USER` / `COUCH_PASSWORD` | unset | Basic auth credentials |
| `DATABASE_URL` | required | Postgres connection string |
| `BATCH_SIZE` | `500` | Changes per batch |
| `POLL_TIMEOUT_MS` | `10000` | Long-poll wait; also how long the dashboard takes to show "In sync" |
| `PORT` | `8090` | Dashboard, `/health`, `/status`, `/events`, `/events/stream` |
| `SAMPLE_SIZE` | `200` | Documents sampled by `verify-cli` |

Alerts service:

| Variable | Default | Meaning |
|---|---|---|
| `FEED_URL` | `http://localhost:8090` | The migrator's base URL |
| `DATABASE_URL` | required | Postgres connection string (the service owns the `alerts` schema) |
| `PORT` | `8095` | `/alerts`, `/health` |
| `HIGH_VALUE_THRESHOLD` | `1000` | Order total at or above which `high_value_order` fires |
| `BATCH_SIZE` / `POLL_MS` | `200` / `1000` | Feed page size and idle poll interval |

## Development

```sh
cd migrator && npm install && npm test
cd services/alerts && npm install && npm test   # builds the migrator first; the contract test needs it
```

The migrator tests cover the mapping, the sync loop and its backoff, the checkpoint and outbox transaction (with a fake client), the HTTP client's retries, the feed endpoints (JSON and SSE), the status server, verify, the seed generator, and the schema loader. The alerts tests cover the rules, the consumer loop, the store transaction, the HTTP API, and a contract test that runs the migrator's real feed server. None of these need Docker.

End-to-end check of the local stack. It seeds, waits for `verify-cli` to pass, reads the feed, and runs both SQL files:

```sh
docker compose up -d --build --wait
scripts/smoke.sh
```

## CI/CD

[GitHub Actions](.github/workflows/ci.yml) runs on every push and pull request:

| Job | What it checks |
|---|---|
| Unit tests | Both services on Node 22 and 24 |
| Terraform | `fmt -check` and `validate` (no AWS credentials, no apply) |
| Compose smoke test | `docker compose up`, then `scripts/smoke.sh` |
| Images | Builds both Docker images. On `main` and `v*` tags, pushes them to `ghcr.io/laveresteban/cloudant-to-postgres/{migrator,alerts}` |

CI does not deploy to AWS. Deploying is a manual step with `deploy/aws/deploy.sh`.

## Status and limits

- CI runs the unit and contract tests, `terraform validate`, and a compose smoke test (seed, `verify-cli`, the feed, both SQL files) on every push.
- Verified locally with Docker by hand: the live seed, and service restarts with no duplicate events or alerts.
- Not run yet: an AWS apply. `terraform validate` passes. The browser app has been checked over HTTP only.
- Not migrated: attachment bytes, design documents (write SQL instead), and conflicting revisions other than the winner.
- One migrator per source database. Authentication is basic auth; Cloudant IAM is not implemented. Services talk over plain HTTP, and the feed has no auth, so it is a demo surface.
- `change_events` has no retention yet, so it grows without limit.
- The change feed stops at cutover, when the migrator stops. Post-cutover change capture is part of the migration plan, not built here.

## License

[MIT](LICENSE)
