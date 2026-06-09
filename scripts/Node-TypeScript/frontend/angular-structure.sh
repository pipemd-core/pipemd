#!/usr/bin/env bash
set -uo pipefail
# Angular structure — routes, components, services, module type.
# Replaces angular-routes with a complete Angular app overview.
source "$(dirname "$0")/../lib/limit.sh"

: "${MAX_ANGULAR:=${MAX_ANGULAR:-40}}"

if [ ! -f "angular.json" ] && [ ! -d "src/app" ]; then
  echo "No Angular project detected"
  exit 0
fi

# Detect standalone vs NgModule
standalone_count=$(grep -rl 'standalone:[[:space:]]*true' src/ 2>/dev/null | grep -v node_modules | wc -l)
ngmodule_count=$(grep -rl '@NgModule' src/ 2>/dev/null | grep -v node_modules | wc -l)

if [ "$standalone_count" -gt "$ngmodule_count" ]; then
  echo "Mode: standalone ($standalone_count standalone vs $ngmodule_count NgModule)"
elif [ "$ngmodule_count" -gt 0 ]; then
  echo "Mode: NgModule-based ($ngmodule_count NgModule vs $standalone_count standalone)"
else
  echo "Mode: undetermined"
fi

# Routes
route_files=""
while IFS= read -r f; do
  [ -z "$f" ] && continue
  route_files="${route_files}${f}"$'\n'
done < <(find src -name '*-routing.module.ts' -o -name '*.routes.ts' 2>/dev/null | grep -v node_modules | sort -u)

if [ -n "$route_files" ]; then
  route_count=0
  echo ""
  echo "Routes:"
  all_paths=""
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    paths=$(sed -n "s/.*path:[[:space:]]*['\"]\\([^'\"]*\\)['\"].*/\\1/p" "$f" 2>/dev/null | grep -v '^\*\*' | grep -v '^$')
    if [ -n "$paths" ]; then
      while IFS= read -r p; do
        entry="  /$p"
        case "$all_paths" in
          *"$entry"*) continue ;;
        esac
        all_paths="${all_paths}${entry}"$'\n'
        echo "${entry}  ($(basename "$f"))"
        route_count=$((route_count + 1))
      done <<< "$paths"
    fi
  done <<< "$route_files"
  [ "$route_count" -eq 0 ] && echo "  (no path definitions found)"
fi

# Components
comp_count=$(find src -name '*.component.ts' 2>/dev/null | grep -v node_modules | wc -l)
svc_count=$(find src -name '*.service.ts' 2>/dev/null | grep -v node_modules | wc -l)
pipe_count=$(find src -name '*.pipe.ts' 2>/dev/null | grep -v node_modules | wc -l)
dir_count=$(find src -name '*.directive.ts' 2>/dev/null | grep -v node_modules | wc -l)
guard_count=$(find src -name '*.guard.ts' -o -name '*.guard' 2>/dev/null | grep -v node_modules | wc -l)

echo ""
echo "Inventory: ${comp_count} component(s), ${svc_count} service(s), ${pipe_count} pipe(s), ${dir_count} directive(s), ${guard_count} guard(s)"

# Key directories
echo ""
echo "Key dirs:"
find src/app -maxdepth 1 -type d 2>/dev/null | sort | while IFS= read -r d; do
  base=$(basename "$d")
  [ "$base" = "app" ] && continue
  file_count=$(find "$d" -name '*.ts' 2>/dev/null | grep -v node_modules | wc -l)
  [ "$file_count" -gt 0 ] && echo "  $base/ ($file_count files)"
done | head -10
