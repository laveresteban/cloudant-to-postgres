# Layout: ECR images -> ECS Fargate (migrator, alerts) behind an ALB, RDS Postgres,
# Secrets Manager for credentials, and an S3 static site for the app.
#
# The stack uses the account's default VPC to keep the demo simple. Production
# should use private subnets, a NAT gateway and TLS on the load balancer.

data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

resource "random_id" "suffix" {
  byte_length = 3
}

resource "random_password" "db" {
  length  = 24
  special = false
}

# ---------------------------------------------------------------- images

resource "aws_ecr_repository" "migrator" {
  name         = "${var.name}/migrator"
  force_delete = true
}

resource "aws_ecr_repository" "alerts" {
  name         = "${var.name}/alerts"
  force_delete = true
}

# ---------------------------------------------------------------- network

resource "aws_security_group" "alb" {
  name        = "${var.name}-alb"
  description = "Load balancer: reachable from the operator's IP only"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description = "migrator feed"
    from_port   = 8090
    to_port     = 8090
    protocol    = "tcp"
    cidr_blocks = [var.allowed_cidr]
  }

  ingress {
    description = "alerts API"
    from_port   = 8095
    to_port     = 8095
    protocol    = "tcp"
    cidr_blocks = [var.allowed_cidr]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "service" {
  name        = "${var.name}-service"
  description = "ECS tasks: reachable from the load balancer and from each other (alerts -> migrator)"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description     = "from the load balancer"
    from_port       = 8090
    to_port         = 8095
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  ingress {
    description = "service to service"
    from_port   = 8090
    to_port     = 8095
    protocol    = "tcp"
    self        = true
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "db" {
  name        = "${var.name}-db"
  description = "Postgres: the ECS tasks and the operator's IP"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description     = "from ECS tasks"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.service.id]
  }

  ingress {
    description = "operator psql access"
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = [var.allowed_cidr]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# ---------------------------------------------------------------- database

resource "aws_db_subnet_group" "db" {
  name       = "${var.name}-db"
  subnet_ids = data.aws_subnets.default.ids
}

resource "aws_db_instance" "postgres" {
  identifier              = "${var.name}-pg"
  engine                  = "postgres"
  engine_version          = "16"
  instance_class          = var.db_instance_class
  allocated_storage       = 20
  storage_type            = "gp3"
  db_name                 = "showcase"
  username                = "app"
  password                = random_password.db.result
  db_subnet_group_name    = aws_db_subnet_group.db.name
  vpc_security_group_ids  = [aws_security_group.db.id]
  publicly_accessible     = true # restricted to var.allowed_cidr by the security group above
  backup_retention_period = 1
  skip_final_snapshot     = true
  apply_immediately       = true
}

# ---------------------------------------------------------------- secrets

resource "aws_secretsmanager_secret" "database_url" {
  name                    = "${var.name}/database-url"
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "database_url" {
  secret_id     = aws_secretsmanager_secret.database_url.id
  secret_string = "postgres://app:${random_password.db.result}@${aws_db_instance.postgres.address}:5432/showcase"
}

resource "aws_secretsmanager_secret" "couch_password" {
  name                    = "${var.name}/couch-password"
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "couch_password" {
  secret_id     = aws_secretsmanager_secret.couch_password.id
  secret_string = var.couch_password
}

# ---------------------------------------------------------------- IAM and logs

data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${var.name}-task-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "read_secrets" {
  name = "read-secrets"
  role = aws_iam_role.execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = [aws_secretsmanager_secret.database_url.arn, aws_secretsmanager_secret.couch_password.arn]
    }]
  })
}

resource "aws_cloudwatch_log_group" "migrator" {
  name              = "/ecs/${var.name}/migrator"
  retention_in_days = 14
}

resource "aws_cloudwatch_log_group" "alerts" {
  name              = "/ecs/${var.name}/alerts"
  retention_in_days = 14
}

# ---------------------------------------------------------------- service discovery

# The alerts service reaches the migrator privately by DNS, not through the public load balancer.
resource "aws_service_discovery_private_dns_namespace" "internal" {
  name = "${var.name}.internal"
  vpc  = data.aws_vpc.default.id
}

resource "aws_service_discovery_service" "migrator" {
  name = "migrator"

  dns_config {
    namespace_id   = aws_service_discovery_private_dns_namespace.internal.id
    routing_policy = "MULTIVALUE"

    dns_records {
      type = "A"
      ttl  = 10
    }
  }

  health_check_custom_config {
    failure_threshold = 1
  }
}

# ---------------------------------------------------------------- load balancer

resource "aws_lb" "main" {
  name               = "${var.name}-alb"
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = data.aws_subnets.default.ids
  # SSE streams are long-lived; the migrator sends a heartbeat every 15 s, so 120 s keeps them open.
  idle_timeout = 120
}

resource "aws_lb_target_group" "migrator" {
  name        = "${var.name}-mig"
  port        = 8090
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = data.aws_vpc.default.id

  health_check {
    path    = "/health"
    matcher = "200"
  }
}

resource "aws_lb_target_group" "alerts" {
  name        = "${var.name}-alr"
  port        = 8095
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = data.aws_vpc.default.id

  health_check {
    path    = "/health"
    matcher = "200"
  }
}

resource "aws_lb_listener" "migrator" {
  load_balancer_arn = aws_lb.main.arn
  port              = 8090
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.migrator.arn
  }
}

resource "aws_lb_listener" "alerts" {
  load_balancer_arn = aws_lb.main.arn
  port              = 8095
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.alerts.arn
  }
}

# ---------------------------------------------------------------- ECS

resource "aws_ecs_cluster" "main" {
  name = var.name
}

resource "aws_ecs_task_definition" "migrator" {
  family                   = "${var.name}-migrator"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.execution.arn

  container_definitions = jsonencode([{
    name         = "migrator"
    image        = "${aws_ecr_repository.migrator.repository_url}:${var.image_tag}"
    essential    = true
    portMappings = [{ containerPort = 8090, protocol = "tcp" }]
    environment = [
      { name = "COUCH_URL", value = var.couch_url },
      { name = "COUCH_DB", value = var.couch_db },
      { name = "COUCH_USER", value = var.couch_user },
    ]
    secrets = [
      { name = "DATABASE_URL", valueFrom = aws_secretsmanager_secret.database_url.arn },
      { name = "COUCH_PASSWORD", valueFrom = aws_secretsmanager_secret.couch_password.arn },
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.migrator.name
        "awslogs-region"        = var.region
        "awslogs-stream-prefix" = "migrator"
      }
    }
  }])
}

resource "aws_ecs_task_definition" "alerts" {
  family                   = "${var.name}-alerts"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.execution.arn

  container_definitions = jsonencode([{
    name         = "alerts"
    image        = "${aws_ecr_repository.alerts.repository_url}:${var.image_tag}"
    essential    = true
    portMappings = [{ containerPort = 8095, protocol = "tcp" }]
    environment = [
      { name = "FEED_URL", value = "http://migrator.${aws_service_discovery_private_dns_namespace.internal.name}:8090" },
      { name = "HIGH_VALUE_THRESHOLD", value = tostring(var.high_value_threshold) },
    ]
    secrets = [
      { name = "DATABASE_URL", valueFrom = aws_secretsmanager_secret.database_url.arn },
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.alerts.name
        "awslogs-region"        = var.region
        "awslogs-stream-prefix" = "alerts"
      }
    }
  }])
}

# Exactly one migrator task may write at a time. The migration path depends on it:
# two writers would interleave batches and break the event_id cursor. So the rolling
# deployment stops the old task before it starts the new one (minimum healthy 0%).
resource "aws_ecs_service" "migrator" {
  name            = "migrator"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.migrator.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 100

  network_configuration {
    subnets          = data.aws_subnets.default.ids
    security_groups  = [aws_security_group.service.id]
    assign_public_ip = true
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.migrator.arn
    container_name   = "migrator"
    container_port   = 8090
  }

  service_registries {
    registry_arn = aws_service_discovery_service.migrator.arn
  }

  depends_on = [aws_lb_listener.migrator]
}

resource "aws_ecs_service" "alerts" {
  name            = "alerts"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.alerts.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 100

  network_configuration {
    subnets          = data.aws_subnets.default.ids
    security_groups  = [aws_security_group.service.id]
    assign_public_ip = true
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.alerts.arn
    container_name   = "alerts"
    container_port   = 8095
  }

  depends_on = [aws_lb_listener.alerts]
}

# ---------------------------------------------------------------- browser app

resource "aws_s3_bucket" "app" {
  bucket        = "${var.name}-app-${random_id.suffix.hex}"
  force_destroy = true
}

resource "aws_s3_bucket_website_configuration" "app" {
  bucket = aws_s3_bucket.app.id

  index_document {
    suffix = "index.html"
  }
}

resource "aws_s3_bucket_public_access_block" "app" {
  bucket                  = aws_s3_bucket.app.id
  block_public_acls       = false
  block_public_policy     = false
  ignore_public_acls      = false
  restrict_public_buckets = false
}

resource "aws_s3_bucket_policy" "app" {
  bucket = aws_s3_bucket.app.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "PublicReadForDemo"
      Effect    = "Allow"
      Principal = "*"
      Action    = "s3:GetObject"
      Resource  = "${aws_s3_bucket.app.arn}/*"
    }]
  })

  depends_on = [aws_s3_bucket_public_access_block.app]
}

resource "aws_s3_object" "index" {
  bucket       = aws_s3_bucket.app.id
  key          = "index.html"
  source       = "${path.module}/../../app/index.html"
  etag         = filemd5("${path.module}/../../app/index.html")
  content_type = "text/html"
}

resource "aws_s3_object" "config" {
  bucket       = aws_s3_bucket.app.id
  key          = "config.js"
  content_type = "application/javascript"
  content = templatefile("${path.module}/templates/config.js.tftpl", {
    feed_url   = "http://${aws_lb.main.dns_name}:8090"
    alerts_url = "http://${aws_lb.main.dns_name}:8095"
  })
}
