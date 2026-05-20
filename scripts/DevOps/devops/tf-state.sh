#!/usr/bin/env bash
set -uo pipefail
# Terraform state summary — fast, no remote locking
source "$(dirname "$0")/../lib/limit.sh"

has_tf=false
if [ -d ".terraform" ]; then has_tf=true; fi
if compgen -G "*.tf" &>/dev/null; then has_tf=true; fi

if [ "$has_tf" = false ]; then
  echo "> ℹ️  No Terraform configuration found (no .terraform dir or *.tf files)"
  exit 0
fi

if ! command -v terraform &>/dev/null; then
  echo "> ℹ️  terraform CLI is not installed or not in PATH"
  echo "> .terraform directory or *.tf files detected but cannot inspect state"
  exit 0
fi

echo "## Terraform State Summary"
echo ""

workspace=$(timeout 3s terraform workspace show 2>/dev/null || echo "unknown")
echo "Workspace: **${workspace}**"
echo ""

if [ -d ".terraform" ]; then
  state_json=$(timeout 10s terraform show -json -no-color 2>/dev/null || true)

  if [ -n "$state_json" ]; then
    resources=$(echo "$state_json" | timeout 3s python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    vals = d.get('values', {})
    root = vals.get('root_module', {})
    resources = root.get('resources', [])
    if not resources:
        print('No managed resources in state')
        sys.exit(0)
    print('| Type | Name | Mode |')
    print('|------|------|------|')
    for r in resources[:40]:
        print('| {} | {} | {} |'.format(r.get('type','?'), r.get('name','?'), r.get('mode','?')))
    if len(resources) > 40:
        print('')
        print('> Showing 40 of {} resources (truncated)'.format(len(resources)))
except Exception as e:
    print('Error parsing state: {}'.format(e))
" 2>/dev/null || echo "> Could not parse terraform state JSON")

    echo "$resources"
  else
    echo "> No Terraform state file found or state is empty"
  fi
else
  echo "> Terraform files detected but not initialized (run \`terraform init\`)"
fi

if compgen -G "*.tf" &>/dev/null; then
  tf_count=$(ls -1 *.tf 2>/dev/null | wc -l)
  echo ""
  echo "*.tf files: ${tf_count}"
fi