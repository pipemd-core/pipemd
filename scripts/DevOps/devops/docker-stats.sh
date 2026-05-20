#!/usr/bin/env bash
set -uo pipefail
# Docker container health summary
source "$(dirname "$0")/../lib/limit.sh"

if ! command -v docker &>/dev/null; then
  echo "> ℹ️  docker is not installed or not in PATH"
  exit 0
fi

if ! timeout 3s docker info &>/dev/null; then
  echo "> ℹ️  Docker daemon is not running"
  exit 0
fi

echo "## Docker Containers"
echo ""

containers=$(timeout 5s docker ps -a \
  --filter "status=running" \
  --filter "status=exited" \
  --format "{{.Names}}|{{.Status}}|{{.Ports}}" 2>/dev/null)

if [ -z "$containers" ]; then
  echo "> No running or recently exited containers found."
  exit 0
fi

echo "| Name | Status | Ports |"
echo "|------|--------|-------|"

echo "$containers" | head -15 | while IFS='|' read -r name status ports; do
  clean_ports="${ports//-/}"
  if [ -z "$clean_ports" ]; then clean_ports="—"; fi
  echo "| ${name} | ${status} | ${clean_ports} |"
done

total=$(echo "$containers" | wc -l)
if [ "$total" -gt 15 ]; then
  echo ""
  echo "> Showing 15 of ${total} containers (truncated for token budget)"
fi