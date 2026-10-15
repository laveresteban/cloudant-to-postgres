# Deploy to AWS

Written for: the consultant or engineer who has to put the demo stack on AWS for a customer.

One command builds and pushes both images and creates the stack:

```sh
cp terraform.tfvars.example terraform.tfvars   # then fill in the values
./deploy.sh
```

When it finishes, `terraform output` prints the URLs:

| Output | What it is |
|---|---|
| `app_url` | The live order board (S3 static site). Open this in a browser. |
| `feed_url` | The migrator's change feed on port 8090. |
| `alerts_url` | The alerts microservice on port 8095. |
| `db_endpoint` | RDS Postgres. Only `allowed_cidr` and the ECS tasks can connect. |
| `psql_hint` | A command that prints the `DATABASE_URL`, for running `db/normalize.sql` and `db/demo-queries.sql` with psql. |

## What gets created

```
Browser ──> S3 (app: index.html + config.js)
   │
   ├──> ALB :8090 ──> ECS Fargate: migrator  ──> RDS Postgres (docs, checkpoints, change_events)
   │                    ▲ one task only             ▲
   └──> ALB :8095 ──> ECS Fargate: alerts ──────────┘  (alerts schema)
                        └── reads the feed privately: migrator.cloudant-to-postgres.internal:8090
```

- **ECR**: one repository per image.
- **ECS Fargate**: the migrator and alerts services, one task each.
- **RDS Postgres 16**: `db.t4g.micro` by default, 20 GB.
- **Secrets Manager**: `DATABASE_URL` and the source password. Nothing secret is in the task definitions.
- **Cloud Map**: the private DNS name the alerts service uses to reach the migrator.
- **S3**: the app, with `config.js` generated from the load balancer address.
- **CloudWatch Logs**: 14 days of task logs.

The migrator applies its schema on every start, so there is no manual schema step.

## Requirements

- Terraform 1.6 or later, the AWS CLI logged in with rights to create these resources, and Docker running.
- The source: a Cloudant or CouchDB URL and credentials. The stack does not create the source.

## Single writer

The migrator must run as exactly one task. Two writers would interleave batches and break the `event_id` cursor that consumers rely on. Two safeguards are in the Terraform:

- `desired_count = 1`, and the deployment settings (`minimum healthy 0%`, `maximum 100%`) stop the old task before the new one starts.
- Do not raise `desired_count` on the migrator service.

## Demo posture (not production)

This stack is for demos and workshops. Before using it for real data:

- The S3 bucket and the app are publicly readable.
- The load balancer and database are open only to `allowed_cidr`, but there is no TLS. The app calls plain HTTP.
- The tasks run in the default VPC's public subnets, with public IPs.
- There is no backup beyond one day, and no deletion protection on RDS.

For production: private subnets with a NAT gateway, TLS on the load balancer, auth in front of the feed and the alerts API, and multi-AZ RDS.

## Run the demo against AWS

Seed the source (for example with `node dist/src/seed.js` pointed at your Cloudant URL), wait for the app to show **Live**, then run the SQL against RDS. The `psql_hint` output is an AWS CLI command that prints the `DATABASE_URL`:

```sh
DB_URL="$(eval "$(terraform output -raw psql_hint)")"
psql "$DB_URL" -f ../../db/normalize.sql
psql "$DB_URL" -f ../../db/demo-queries.sql
```

## Tear down

```sh
terraform destroy
```

This deletes the database, and no final snapshot is taken (`skip_final_snapshot = true`), so export anything you need first. The S3 bucket, ECR images, and secrets are removed too.

## Validation status

`terraform fmt -check` and `terraform validate` run in CI on every push, with no credentials and no apply. The stack has not been applied to a real AWS account from this repo yet.
