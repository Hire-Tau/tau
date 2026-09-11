#!/usr/bin/env bash
# Log in to AWS ECR. Run once per ~12 hours (token expiry).
#
# Usage: ./scripts/ecr-login.sh [region]
#
# Environment:
#   AWS_REGION - AWS region (default: us-east-2)

set -euo pipefail

REGION="${1:-${AWS_REGION:-us-east-2}}"
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
REGISTRY="$ACCOUNT.dkr.ecr.$REGION.amazonaws.com"

echo "Logging in to ECR: $REGISTRY"

# Unlock macOS Keychain to avoid "User interaction is not allowed" errors
# when docker-credential-osxkeychain tries to store the token.
if [[ "$(uname)" == "Darwin" ]]; then
  security unlock-keychain ~/Library/Keychains/login.keychain-db
fi

aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REGISTRY"

echo "ECR_REGISTRY=$REGISTRY"
