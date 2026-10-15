# Migration path: Cloudant / CouchDB to Postgres

Written for: the engineers and architects who will run the migration, and the sales engineer who must explain it.

The path has six phases. The migrator streams data from the source's change feed, so the application keeps running on the source until cutover. The only downtime is the write freeze at cutover, and it can be seconds long.

```
Assess ──> Stream ──> Validate ──> Cut over ──> Normalize ──> Decommission
(days)     (hours to   (hours)      (minutes)     (weeks,        (after the
            days, live)                            ongoing)       rollback window)
```

## Phase 1: Assess

Goal: know what you are moving before you move it.

- **Inventory** databases, document counts, average and maximum document size, and the write rate (`GET /{db}` gives `doc_count`, `doc_del_count`, `update_seq`, `disk_size`).
- **List design documents.** Every `_design/*` view and Mango index is a query the application depends on. Each one needs a SQL equivalent (see the concept map below). Design docs are not migrated as data.
- **Find conflicts.** `GET /{db}/_all_docs?conflicts=true` lists documents with conflicting revisions. The migrator takes the winning revision only, so resolve conflicts in the source, or accept the winner on purpose.
- **Find attachments.** `GET /{db}/_all_docs?include_docs=true` and look for `_attachments`. The migrator copies the attachment stub, not the bytes.
- **Check ID and field shapes.** Mixed types for the same field (a number in one document, a string in another) become the hardest part of the schema design. Surface them now.
- **Map the access patterns.** List the top 20 queries by frequency and by business value. These drive the normalization order in Phase 5.

Exit criterion: an inventory, a list of design docs with their SQL replacement, and a decision on conflicts and attachments.

## Phase 2: Stream

Goal: a Postgres copy that stays current while the application keeps writing to the source.

The migrator does one thing, the same way for backfill and for live changes:

1. Read the checkpoint from `checkpoints` (starts at `0`).
2. `GET /{db}/_changes?feed=longpoll&since=<checkpoint>&limit=<batch>&include_docs=true`.
3. Map each change to a row: strip `_id` and `_rev`, turn `_deleted` into a tombstone, drop design docs.
4. In one Postgres transaction, upsert the rows, write one `change_events` row per changed document (the outbox that consumers read), and save the new `last_seq`. A redelivered change with an unchanged rev is skipped, so it writes no event.
5. Repeat. When the long-poll returns nothing, the copy is in sync; the next poll waits for new changes.

Why this design:

- **One code path.** Backfill is just the feed read from `0`. There is no separate bulk-export step to get wrong.
- **Restart-safe.** The rows and the checkpoint commit together. A crash replays at most one batch, and upserts make the replay harmless.
- **No application changes.** The application keeps writing to the source during Phase 2.
- **Deletes replicate.** Tombstones keep `deleted = true`, so views can filter them out and nothing is silently lost.

Limits to state up front:

- **Sequence IDs are opaque.** CouchDB and Cloudant seq values are strings, so "how many changes behind am I" is not a simple subtraction. The migrator reports `caughtUp` instead: true when the latest poll returned nothing.
- **One writer per source database.** The checkpoint is per database and there is one active migrator for it. Scaling out is not in this version.
- **Rate limits.** Cloudant returns 429 when throughput is exceeded. The migrator backs off exponentially and resumes. Raise the provisioned throughput during backfill, or lower `BATCH_SIZE`, to keep the backfill moving.
- **Throughput.** Measure with the buyer's data. The demo shows `docs/s` on the dashboard.

Operate it:

```sh
docker compose up -d migrator          # or deploy the image to your platform
#   browse to http://localhost:8090    # dashboard: docs applied, throughput, caught-up state
curl http://localhost:8090/status      # the same numbers as JSON
```

Exit criterion: `caughtUp` stays true under normal write load, and `lastError` is null.

## Phase 3: Validate

Goal: prove the Postgres copy matches the source before anything depends on it.

```sh
npm run verify     # or: docker compose exec migrator node dist/src/verify-cli.js
```

The verify command:

- counts live documents on both sides (design docs excluded, tombstones excluded);
- samples random documents (`SAMPLE_SIZE`, default 200) and compares the revision and a canonical hash of the body;
- prints a JSON report and exits non-zero on any mismatch.

Run it while the source is still being written to and mismatches are expected for recently edited documents. The authoritative run is in Phase 4, after the freeze.

Also validate the application's reads: run the read paths against Postgres in shadow mode and compare the results with the source. This catches the query-semantics differences (sort order, null handling, number formatting) that a count does not.

Exit criterion: shadow reads match for the agreed set of queries, and a verify run on a quiet source passes.

## Phase 4: Cut over

Goal: move writes to Postgres with a short, known pause.

1. **Announce** the window. Writes will pause for a few minutes.
2. **Freeze writes** to the source: stop the writers, or put the application in read-only mode.
3. **Drain.** Wait until the migrator reports `caughtUp: true` and `lastBatchAt` is newer than the freeze.
4. **Verify.** Run `verify-cli`. It must exit 0. Do not proceed on a failure; the cause is usually a write that landed after the freeze.
5. **Switch the application** to write to Postgres. Keep reads on the same path.
6. **Stop the migrator.** After cutover the source is no longer the truth. Leaving the migrator running would overwrite new Postgres writes with stale source documents.
7. **Keep the source read-only** for the rollback window.

**The change feed goes dark at cutover.** The migrator is the only producer of `change_events`, so the alerts service and the live app stop receiving changes when the migrator stops. This is expected, and the fix is part of the cutover, not a surprise after it. After step 5 the changes must come from Postgres itself: have the application write an outbox row in the same transaction as each business write (the same pattern the migrator uses), or use logical decoding (for example Debezium). Build that before the window, and check that the alerts service and the app keep receiving events after the switch.

Rollback:

- Before step 5, rollback is free: the application is still on the source.
- After step 5, there is no automatic path back. Writes made to Postgres are not in Cloudant. The migrator is one-way. If the rollback window needs to be real, build a reverse sync (Postgres to source) or accept replaying the post-cutover writes by hand.

Decide this before the window, not during it.

## Phase 5: Normalize

Goal: turn the JSON landing table into a relational model, one step at a time, while the application already runs on Postgres.

The safe order is the one in `db/normalize.sql`:

1. **Views over the JSON** (`customers_v`, `orders_v`, `order_lines_v`). No data is copied and nothing in the application changes. Use them for reporting first.
2. **Materialized views** for expensive reports, refreshed on a schedule with `REFRESH MATERIALIZED VIEW CONCURRENTLY`.
3. **Typed tables** for entities that need constraints. Create the table, backfill it with `INSERT ... SELECT` from the view, switch the application's writes to the table, and then retire the JSON copy. One entity at a time.
4. **Constraints and indexes** added as each typed table settles: `NOT NULL`, `CHECK`, foreign keys, and B-tree indexes on the columns the top queries filter on.

Do not start with step 3 for everything. Each typed table is a schema decision and a data-quality gate. Done well, it is where most of the value appears.

## Phase 6: Decommission

After the rollback window closes and the reports match:

- Take a final backup of the source, then delete or archive the database.
- Remove the migrator from the deployment.
- Record what changed (the schema, the views, the cutover time) in the team's runbook.
- Retire the alerts service and the app's feed connection, or repoint them at the post-cutover outbox.

## Concept map: CouchDB / Cloudant to Postgres

| CouchDB / Cloudant | Postgres (this repo) | Notes |
|---|---|---|
| Database | Database, plus one `docs` landing table | One migrator instance per source database |
| Document `_id` | `docs.id` (`TEXT PRIMARY KEY`) | Kept as-is so verify can compare ids |
| Document `_rev` | `docs.rev` | Kept for verification; replace with a `version` column for optimistic concurrency |
| Document body | `docs.body` (`JSONB`) | Landing zone; normalize into typed tables later |
| Deleted document | `docs.deleted = true` (tombstone) | Filter with `NOT deleted` in views |
| Nested object | JSONB path, or a child table | `body->'address'->>'city'` or an `addresses` table |
| Array of objects | JSONB array, or a child table | `order_lines_v` turns `items` into rows |
| Map/reduce view | SQL view, materialized view, or aggregate query | `revenue_by_month_region` |
| Mango selector + index | `WHERE` clause + B-tree or GIN index | Containment queries use GIN |
| Cloudant Search (Lucene) | Full-text search (`tsvector`) or `pg_trgm` | Or keep a separate search service for complex relevance |
| `_changes` feed + checkpoint | `checkpoints` table + the migrator | The source of the migration, not part of the target design |
| `_attachments` | Object storage with a reference in Postgres | Not migrated by this version; only the stub metadata lands |
| Conflicting revisions | Resolved before migration, or an app-level version column | The migrator takes the winning revision only |
| Design documents | Not migrated | Rewrite as SQL; see the first row of Phase 1 |
| Timestamps as strings | `timestamptz` after normalization | Cast in the view, then enforce the type |
| Multi-document writes (non-atomic) | `BEGIN ... COMMIT` | A real behaviour change: the application can rely on atomicity |

## Known gaps in this version

- Attachment bytes are not copied.
- Design documents are not translated; each view needs a hand-written SQL equivalent.
- Conflicting revisions other than the winner are not migrated.
- Only basic auth is supported. Cloudant IAM API-key auth is a documented extension, not implemented.
- One migrator per source database. No leader election or horizontal scale-out. The event cursor is only safe with one writer, and the AWS deployment enforces it.
- `change_events` (the outbox) grows without limit. Pruning consumed events is not built; add a retention job before running this for long.
- The change feed stops at cutover because the migrator stops (see Phase 4). Post-cutover change capture is not built.
- Consumers are at-least-once. The alerts service makes its writes idempotent with a primary key, but a new consumer must do the same.
- The Terraform apply has not yet been run against AWS. The Docker stack has been run locally end-to-end against live CouchDB and Postgres. Run the demo once before a customer call.
