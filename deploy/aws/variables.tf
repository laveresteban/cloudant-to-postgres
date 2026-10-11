variable "region" {
  description = "AWS region to deploy into."
  type        = string
  default     = "us-east-1"
}

variable "name" {
  description = "Name prefix for every resource."
  type        = string
  default     = "cloudant-to-postgres"
}

variable "image_tag" {
  description = "Image tag for the migrator and alerts images. deploy.sh sets a new tag on every deploy so ECS rolls the services."
  type        = string
  default     = "latest"
}

variable "allowed_cidr" {
  description = "Your public IP in CIDR form (for example 203.0.113.7/32). It is the only address that can reach the load balancer, the app's API calls, and the database."
  type        = string
}

variable "couch_url" {
  description = "CouchDB or Cloudant base URL, for example https://<account>.cloudantnosqldb.appdomain.cloud."
  type        = string
}

variable "couch_db" {
  description = "Source database name."
  type        = string
  default     = "shop"
}

variable "couch_user" {
  description = "Basic-auth user for the source database."
  type        = string
}

variable "couch_password" {
  description = "Basic-auth password for the source database. Stored in Secrets Manager."
  type        = string
  sensitive   = true
}

variable "high_value_threshold" {
  description = "Order total at or above which the alerts service raises high_value_order."
  type        = number
  default     = 1000
}

variable "db_instance_class" {
  description = "RDS instance class."
  type        = string
  default     = "db.t4g.micro"
}
