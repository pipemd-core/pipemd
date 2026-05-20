#!/usr/bin/env bash
set -uo pipefail
# AWS caller identity — prevents account hallucination
source "$(dirname "$0")/../lib/limit.sh"

if ! command -v aws &>/dev/null; then
  echo "> ℹ️  aws CLI is not installed or not in PATH"
  exit 0
fi

identity=$(timeout 3s aws sts get-caller-identity --output json 2>/dev/null || true)

if [ -z "$identity" ]; then
  echo "> ℹ️  Could not retrieve AWS caller identity (no credentials or timeout)"
  exit 0
fi

echo "## AWS Caller Identity"
echo ""

account=$(echo "$identity" | timeout 2s python3 -c "
import sys, json
d = json.load(sys.stdin)
account = d.get('Account', 'unknown')
userid = d.get('UserId', 'unknown')
arn    = d.get('Arn', 'unknown')
print('| Field | Value |')
print('|-------|-------|')
print('| Account | {} |'.format(account))
print('| UserID  | {} |'.format(userid))
print('| ARN     | {} |'.format(arn))
" 2>/dev/null || echo "> Could not parse STS response")

echo "$account"