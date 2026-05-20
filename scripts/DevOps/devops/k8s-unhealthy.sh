#!/usr/bin/env bash
set -uo pipefail
# Kubernetes unhealthy pod summary
source "$(dirname "$0")/../lib/limit.sh"

if ! command -v kubectl &>/dev/null; then
  echo "> ℹ️  kubectl is not installed or not in PATH"
  exit 0
fi

ctx=$(timeout 3s kubectl config current-context 2>/dev/null || true)
if [ -z "$ctx" ]; then
  echo "> ℹ️  No active Kubernetes context configured"
  exit 0
fi

echo "## Kubernetes Unhealthy Pods (context: ${ctx})"
echo ""

pods=$(timeout 10s kubectl get pods \
  --all-namespaces \
  --field-selector="status.phase!=Running" \
  -o wide 2>/dev/null)

if [ -z "$pods" ]; then
  echo "> ✅ All Kubernetes pods are running normally."
  exit 0
fi

lines=$(echo "$pods" | wc -l)
if [ "$lines" -le 2 ]; then
  echo "> ✅ All Kubernetes pods are running normally."
  exit 0
fi

echo "$pods" | head -21

if [ "$lines" -gt 21 ]; then
  echo ""
  echo "> Showing 20 unhealthy pods of $(echo "$pods" | tail -n +2 | wc -l) total (truncated)"
fi