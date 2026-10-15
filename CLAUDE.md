# CLAUDE.md — cloudant-to-postgres

Sales-engineering kit (docs + demo stack), a streaming migrator from Cloudant/CouchDB to Postgres, a change feed, an app, an alerts microservice, and AWS Terraform. README.md covers layout, config and quick start; this file holds the rules for changing the code.

## Commands

- `cd migrator && npm test`: builds to `dist/` and runs `node --test` on the compiled tests.
- `cd services/alerts && npm test`: first builds the migrator (the contract test imports its compiled feed server), then runs its tests. Run the migrator's test first if the migrator changed.
- Scripted seeding must use `docker compose exec -T migrator ...`. `docker compose run` in a non-interactive shell left containers running after the process exited, so `seed.js --live` kept writing. Use `run` only interactively, with Ctrl+C to stop.
- Docker may not be running on the dev machine. Unit tests need no Docker. `deploy.sh` must be run by hand.
- `scripts/smoke.sh`: end-to-end check of a running compose stack (seed, wait for `verify-cli`, feed, both SQL files). It talks to services only via `docker compose exec`, so run it locally as a separate project, so it doesn't clash with the user's demo stack on the same ports or touch its volumes: `COMPOSE_PROJECT_NAME=c2p-smoke` plus an override with `ports: !reset []`, and `down -v` only that project. On Git Bash set `MSYS_NO_PATHCONV=1`, or `/sql/...` paths get mangled.
- Terraform: `cd deploy/aws && terraform fmt -check && terraform validate`. Terraform is not installed locally; use `hashicorp/terraform:<ver>` in Docker, on a copy of the repo (from `git archive`), because `main.tf` reads `../../app`. Do not commit `.terraform/` or the lock file.
- CI (`.github/workflows/ci.yml`): unit tests on Node 22 and 24, Terraform fmt/validate, the compose smoke test, then image builds. Images are pushed to GHCR (`ghcr.io/laveresteban/cloudant-to-postgres/{migrator,alerts}`) only on pushes to `main` and `v*` tags. The alerts job needs the migrator's `npm ci` to run first. CI never deploys to AWS.

## Code conventions

- TypeScript with `NodeNext`. Relative imports end in `.js` even though the source is `.ts`.
- Runtime dependency: `pg` only. Use native `fetch` and `node:http`. No framework, no CouchDB client library, no shared package between services. Copy small helpers (like `retry.ts`) instead; each service must build and deploy on its own.
- Keep the seams: `Source`, `Sink`, `FeedSource`, `CursorStore` and the injected `fetchImpl`, `sleep`, and `connect` options exist so tests run without a server. Keep that pattern for new I/O.
- Tests live in each package's `test/`, use `node:test` and `node:assert/strict`, and follow the TDD rule in the parent CLAUDE.md.
- Services and apps must not set `innerHTML` from data. Document values render with `textContent`.

## Migrator invariants (do not break)

- One transaction writes the `docs` rows, one `change_events` row per changed document, and the checkpoint (`sink.ts`). Do not move the checkpoint or the outbox write out of it.
- Two rules govern the upsert, and they are different. Keep both explicit:
  - Do not add a "only apply a higher rev generation" guard. CouchDB's winning revision is not always the highest generation, so such a guard drops valid updates. Last write wins in feed order.
  - Do skip a row whose rev is identical (`WHERE docs.rev IS DISTINCT FROM EXCLUDED.rev`). The same rev means the same content, so a redelivered change writes no row and no event.
- `event_id` has gaps. A batch aborted mid-transaction (a container killed during a batch) consumes identity values without committing rows, and the replay gets new ids. Consumers must treat the cursor as an ordering key, never assume contiguous ids. Verified locally: ids 551–561 were lost and replayed as 562+.
- `event_id` is a safe cursor only with one writer. One migrator commits batches in order, so ids become visible in order. Two writers can commit out of order and let a consumer skip events. The AWS service has `desired_count = 1` and `minimum healthy 0%` for this reason. Never raise either.
- Sequence IDs are opaque strings. Never compare or subtract them to get a lag number. "In sync" is `caughtUp`: the last long-poll returned nothing.
- Deletes become tombstones (`deleted = true`, empty body). Do not hard-delete rows. Tombstones have no body, so rules that need a type must key on the `doc_id` prefix.
- Design docs (`_design/*`) are skipped by `toDocRow`, and `verify` excludes them from counts.
- Retries apply to reads only. Write requests fail fast, because a retried `_bulk_docs` can double-apply.
- The schema is `migrator/schema.sql`. The migrator applies it on every start, so every statement must stay `IF NOT EXISTS`. `docker-compose` also mounts it for first boot.

## Feed and consumer invariants

- `GET /events` returns `next`, which is the cursor to send next. Consumers store `next`, not their own arithmetic. `after` is exclusive.
- Cursors are numbers. `event_id` is BIGINT, and node-postgres returns it as a string, so convert with `Number()` at the boundary.
- SSE (`/events/stream`) honours `Last-Event-ID`, stops its loop and timer when the response closes, and sends a heartbeat (keep the heartbeat shorter than the ALB idle timeout).
- Consumers are at-least-once. The alerts service makes its writes idempotent with `PRIMARY KEY (event_id, rule)`. A new consumer must do the same. Save the alerts and the cursor in one transaction.
- The feed has no auth. It is a demo surface and must be fronted by auth before anything beyond a demo network.

## Docs

- The docs are written for sales engineers and consultants. Keep the trade-offs section in `docs/why-postgres.md`. Do not remove it to make the pitch cleaner.
- Do not add benchmark numbers, customer statistics, or IBM branding. Say "measure on your data".
- Cloudant pricing and limit claims must be hedged ("confirm the buyer's plan"). Re-check them before a customer call.
- Keep the status section of README.md, the "Known gaps" section of `docs/migration-path.md`, and `deploy/aws/README.md` ("Validation status" and "Demo posture") accurate. Update them when a gap closes.
- The cutover section of `docs/migration-path.md` says the feed goes dark at cutover. Keep that line in any new cutover guidance.

## Terraform (deploy/aws)

- `terraform.tfvars` holds the Cloudant password and is git-ignored. Do not put secrets in `variables.tf` defaults or in the task definitions. Secrets go in Secrets Manager.
- Image tags change on every deploy (`deploy.sh` sets a new tag). A fixed `latest` tag makes ECS keep the old image.
- The app's `config.js` is generated from `templates/config.js.tftpl`. Keep `app/config.js` (local defaults) in step with it.
- Demo posture is intentional: public S3 site, plain HTTP, public RDS restricted by CIDR. Do not present it as production.

## Unverified until run

- Verified locally with Docker (compose up, seed, live writes, verify, restarts): the compose stack, `couchdb:3.5.2` (checked after the bump from 3.3; the existing volume still read correctly), `postgres:16-alpine`, `nginx:1.27-alpine`, `db/normalize.sql`, `db/demo-queries.sql`, `migrator/schema.sql`, the upsert CTE (create/update/delete ops), and the `IS DISTINCT FROM` skip.
- Not verified: AWS. The Terraform has passed `validate` only, and `deploy.sh` has not run against an AWS account.
- The browser app has been checked only over HTTP (page, `config.js`, SSE). Its rendering has not been checked in a browser.
- Say so in any summary that touches these.

## Git

- Public repo: github.com/laveresteban/cloudant-to-postgres (MIT). Work on a branch and open a PR so CI runs. Do not commit or push unless asked.
- `.gitattributes` forces LF. Shell scripts must keep the executable bit in git (`git add --chmod=+x`).
- Commit messages end with the Co-Authored-By line from the session's attribution reminder.
