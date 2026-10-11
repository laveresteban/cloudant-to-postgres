# Demo script (about 15 minutes)

Written for: the sales engineer or consultant running the demo live.

## Before the call

```sh
docker compose up -d                       # CouchDB, Postgres, migrator
docker compose run --rm migrator node dist/src/seed.js --count 500   # 50 customers, 500 orders
docker compose exec postgres psql -U app -d showcase -f /sql/normalize.sql
```

Open the dashboard at http://localhost:8090 and keep a terminal ready for `psql`:

```sh
docker compose exec postgres psql -U app -d showcase
```

Check the stack is healthy: the dashboard shows **In sync** (it can take about 10 seconds after the backfill).

## 1. The problem (2 minutes)

Ask: "Which questions does the business ask that your data model answers badly today?" Write the answers down. Typical replies: revenue by segment, customers who bought X, reports that need a nightly job.

Show the two-line version: "Every one of those is a view or app code in Cloudant. In Postgres it is one statement."

## 2. Live sync (3 minutes)

Point at the dashboard: docs applied, throughput, checkpoint, state.

Explain: "This is the migrator. It reads the source's change feed and writes each change to Postgres in the same transaction as its checkpoint. Nothing is lost on a restart."

Start the live writer in a second terminal:

```sh
docker compose run --rm migrator node dist/src/seed.js --live
```

Watch the throughput rise. Every few seconds an order is shipped (an update) and every ten seconds one is deleted (a tombstone). Then in `psql`:

```sql
SELECT count(*) FILTER (WHERE NOT deleted) AS live, count(*) FILTER (WHERE deleted) AS tombstones FROM docs;
```

Run it twice, a few seconds apart. The numbers move.

## 2b. The same changes feed an app and a microservice (3 minutes)

Open the order board at http://localhost:8080 while the live writer runs.

Explain: "The migrator writes every change to an outbox table in the same transaction as the data. The browser app reads that feed over Server-Sent Events. A separate alerts microservice reads it over HTTP, keeps its own cursor, and raises alerts."

Point at three things:

- **The board** builds itself from the feed. New orders appear, a shipped order changes status, and a deleted order disappears.
- **The alerts panel** shows `high_value_order` for orders at or above 1000, and `order_deleted` for each deletion. These come from the alerts service, not the app.
- **Resilience:** stop the alerts service (`docker compose stop alerts`), wait ten seconds, and start it again. It resumes from its stored cursor, and the alerts it missed appear with no duplicates. Then run `docker compose restart migrator`: the browser's stream reconnects by itself and resumes from the last event id.

## 3. Queries that used to be views (4 minutes)

Run `db/demo-queries.sql` (or paste the queries one at a time):

- **Query 1, revenue by region.** "This is a join across two document types. In Cloudant that is a view per question and a client-side join."
- **Query 2, top customers.** "Same idea, ranked. Change the question, not the schema."
- **Query 4, who bought a product in the last 30 days.** "Three entities, one statement. This is where ad hoc questions get expensive in a document store."

Then the honest point: "Postgres is not free. Those queries are only as fast as the indexes you add, and that is a design task. The demo shows what is possible, not a benchmark."

## 4. Restart without losing data (2 minutes)

```sh
docker compose restart migrator
```

Watch the log: the migrator resumes from the stored checkpoint, not from zero. Then:

```sh
docker compose run --rm migrator node dist/src/verify-cli.js
```

Expect exit 0 and `"ok": true` once the live writer is stopped (Ctrl+C in its terminal) and the dashboard shows **In sync**. Explain: "This is the gate before cutover. Mismatches while writes are running are expected, so the real check runs after the freeze."

## 5. The migration path (2 minutes)

Walk the six phases in `docs/migration-path.md`. Stress three points:

1. The application keeps running on Cloudant until cutover. Downtime is the write freeze, not the copy.
2. Validate reads, not just counts. Shadow reads catch the differences a count misses.
3. Cutover has a point of no return. Decide the rollback window before the window, not during it.

## 6. The honest trade-offs (2 minutes)

Name them before the buyer does. See the section "What you give up" in `docs/why-postgres.md`:

- No multi-master writes across regions.
- No PouchDB offline sync.
- The `_rev` conflict model becomes an application version column.
- Attachments belong in object storage.

Ask: "Which of these do your users depend on?" If the answer is offline sync or multi-region writes, scope the migration to the central data and say so.

## Close

Summarize in one sentence the buyer can repeat: "We can move the data without a big-bang cutover, check it before we trust it, and then make the schema as strict as the business needs."

Offer the next step: a two-week assessment using Phase 1 on their real database inventory.

## If something goes wrong on stage

| Symptom | Fix |
|---|---|
| Dashboard says **Retrying** | `docker compose logs migrator`. Usually CouchDB is still starting, or the seed has not created the database yet. |
| `normalize.sql` fails on a missing view | The migrator has not written any rows. Wait for **In sync**, then run it again. |
| Dashboard does not update | Check `http://localhost:8090/health`. If it fails, `docker compose restart migrator`. |
| Order board is empty | Run the seed first. The app shows **Feed interrupted** until the migrator's `/events/stream` answers. |
| Alerts panel says unreachable | `docker compose logs alerts`. It usually means the migrator has not started, or Postgres is still starting. |
| Old Postgres volume has no `change_events` table | `init.sql` only runs on a fresh volume. The migrator now applies the schema on start, so `docker compose restart migrator` fixes it. For a clean run, `docker compose down -v` and start again. |
| `verify-cli` exits 1 | Expected while writes are running. Stop the live writer, wait for **In sync**, and run it again. |
