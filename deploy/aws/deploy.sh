#!/usr/bin/env bash
# One-command deploy: create the image repositories, build and push both images
# under a fresh tag, then apply the rest of the stack.
#
# Needs: terraform >= 1.6, aws CLI (logged in), docker (running), and terraform.tfvars.
set -euo pipefail
cd "$(dirname "$0")"

REGION="${AWS_REGION:-us-east-1}"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
REGISTRY="${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com"
TAG="${IMAGE_TAG:-$(date -u +%Y%m%d%H%M%S)}"

terraform init -input=false
terraform apply -input=false -auto-approve -var "image_tag=${TAG}" \
  -target=aws_ecr_repository.migrator -target=aws_ecr_repository.alerts

aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REGISTRY"

for pair in "migrator:../../migrator" "alerts:../../services/alerts"; do
  svc="${pair%%:*}"
  context="${pair#*:}"
  image="${REGISTRY}/cloudant-to-postgres/${svc}:${TAG}"
  docker build -t "$image" "$context"
  docker push "$image"
done

terraform apply -input=false -auto-approve -var "image_tag=${TAG}"
terraform output
