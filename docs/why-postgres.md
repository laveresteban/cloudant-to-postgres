# Why move from Cloudant / CouchDB to Postgres

Written for: sales engineers and consultants discussing a move with a technical buyer.

CouchDB and Cloudant are good at what they were built for: document storage over HTTP, multi-master replication, and offline-first sync to clients. This page covers where the workload has usually drifted past that model, and what Postgres changes. It ends with what you give up.

Every claim here should be checked against the buyer's own data. The demo in this repo produces real numbers for the buyer's shape of data. This page does not contain benchmarks.

## The short version

| Question the business asks | Cloudant / CouchDB | Postgres |
|---|---|---|
| "Revenue by region this quarter, joined to customers" | A view per question, or join in application code | One SQL statement |
| "Move $50 from A to B, record it, and never half-complete" | Single-document atomicity only; multi-document writes are not atomic | `BEGIN … COMMIT` across any number of rows |
| "Enforce that every order has a real customer" | Application code; the database cannot check | Foreign keys and `CHECK` constraints |
| "Let the BI team connect Tableau or Power BI" | Needs an ETL pipeline or a connector | Standard ODBC/JDBC; most BI tools connect directly |
| "Hire people who can run this" | Smaller talent pool | Postgres skills are common and portable |
| "Avoid lock-in" | Tied to the Cloudant API and its query model | Open source, on every major cloud, self-hostable |

## Where Postgres wins

### 1. Questions that span documents

In a document store, each question you did not design a view for is either slow or implemented in application code. Views are precomputed MapReduce results: you define them in advance, and changing one means a re-index of the design document.

Postgres answers ad hoc questions with SQL, using the query planner to choose the access path. You get joins, aggregates, window functions and subqueries without schema changes. See `db/demo-queries.sql`, queries 1 to 4, for examples that would each need a view and client-side code today.

### 2. Transactions across records

Cloudant guarantees atomicity for one document. `_bulk_docs` writes many documents, but it is not all-or-nothing: some can succeed while others fail. Applications that need "debit this account and credit that one" either accept partial states or build compensation logic.

Postgres commits or rolls back an arbitrary set of rows and tables together. For money, inventory and anything with invariants across records, this removes a whole category of bugs.

### 3. Data quality enforced by the database

Documents accept any shape. Over time that means `total` sometimes being a string, `customer_id` pointing nowhere, and `status` taking values nobody expected.

Postgres enforces types, `NOT NULL`, `CHECK` constraints and foreign keys. The migration path in `docs/migration-path.md` keeps the flexible JSONB landing table at first and adds constraints as the model settles.

### 4. Flexible where you need it, strict where it matters

JSONB keeps the document flexibility. A GIN index makes containment queries (`body @> '{"status":"shipped"}'`) fast. Migrating does not force an immediate schema decision: keep the document, add typed columns and views as they earn their place.

### 5. Ecosystem and operations

- Every managed cloud offers Postgres. Backup, point-in-time recovery, read replicas and monitoring are standard.
- Extensions cover common needs: full-text search (built in), `pg_trgm` for fuzzy matching, PostGIS for geography, `pgvector` for embeddings, `pg_cron` for scheduling.
- Logical replication and CDC tools (for example Debezium) let downstream systems subscribe to changes. The migrator in this repo follows the source's change feed; the same pattern is available from Postgres when you need it.

### 6. Cost model

Cloudant's standard plans bill against provisioned throughput: reads, writes and queries per second. Confirm the buyer's plan and current pricing. When a burst exceeds that capacity, requests return HTTP 429. Teams often provision for peak to avoid throttling, which costs money the rest of the time.

Postgres bills for an instance (CPU, memory, storage), and throughput is limited by that instance. It is a different trade-off: you pay for capacity by the hour, and you tune queries and indexes to use it. Compare the buyer's current invoice with a Postgres instance sized for measured peak plus headroom. Do not assume one is always cheaper; the demo and a load test give the real answer.

## What you give up (say this out loud)

Credibility depends on naming these. Ask the buyer which of them they rely on.

- **Multi-master replication.** CouchDB and Cloudant accept writes in several regions and replicate between them. Postgres has one primary for writes. Logical replication gives you read replicas and subscribers, not multi-primary writes. Multi-region writes need a different architecture, such as a managed distributed Postgres service, and that is a separate design decision.
- **Offline-first sync.** PouchDB syncs with CouchDB's protocol and works offline in browsers and mobile apps. Postgres has no equivalent. Sync layers built on Postgres exist (for example PowerSync and ElectricSQL), but they are a different architecture and need their own evaluation.
- **The `_rev` conflict model.** CouchDB keeps conflicting revisions and lets the application choose a winner. Postgres has no built-in equivalent. Replace it with an application-level `version` column and optimistic concurrency (`UPDATE ... WHERE version = $1`), or a conflict-resolution step in the app.
- **Attachments.** Binary attachments are better in object storage (S3, IBM Cloud Object Storage) with a reference stored in Postgres. The migrator in this repo copies attachment metadata only; see `docs/migration-path.md`.
- **Schema work.** Documents needed no migrations. Postgres does. The payoff is the constraints above, but the team must own schema changes.

If the workload depends on multi-region writes or offline clients, say so early. Postgres may still be right for the central data, with a different sync design at the edge.

## How to decide

Postgres is usually the better fit when:

- Reporting or cross-entity questions are growing, and views or app-side joins are piling up.
- Data has invariants that span records (money, inventory, permissions).
- The team wants standard BI, analytics or ML tooling on the same data.
- Vendor portability or a cloud-agnostic posture matters.

Cloudant or CouchDB is still the better fit when:

- The product depends on offline-first clients with PouchDB sync.
- Writes must be accepted in several regions at once, and the team has no plan for that with Postgres.
- The workload is simple key-value or document access with no cross-document queries, and it runs well within its current cost.

## Next

- `docs/migration-path.md`: how to get there without downtime.
- `docs/demo-script.md`: a live walkthrough using this repo.
