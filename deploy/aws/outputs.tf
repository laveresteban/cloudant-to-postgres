output "app_url" {
  description = "Open this in a browser: the live order board."
  value       = "http://${aws_s3_bucket_website_configuration.app.website_endpoint}"
}

output "feed_url" {
  description = "Migrator change feed (GET /events, GET /events/stream)."
  value       = "http://${aws_lb.main.dns_name}:8090"
}

output "alerts_url" {
  description = "Alerts microservice (GET /alerts)."
  value       = "http://${aws_lb.main.dns_name}:8095"
}

output "db_endpoint" {
  description = "Postgres host. Only allowed_cidr and the ECS tasks can connect."
  value       = aws_db_instance.postgres.address
}

output "database_secret_arn" {
  description = "Secrets Manager secret holding the full DATABASE_URL. Use it to run psql."
  value       = aws_secretsmanager_secret.database_url.arn
}

output "psql_hint" {
  description = "Run the demo SQL against RDS: fetch the URL, then psql it."
  value       = "aws secretsmanager get-secret-value --secret-id ${aws_secretsmanager_secret.database_url.name} --query SecretString --output text"
}
