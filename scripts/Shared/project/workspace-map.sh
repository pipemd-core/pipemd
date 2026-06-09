#!/usr/bin/env bash
set -uo pipefail
# Workspace map — monorepo workspace members and inter-package dependencies.
# Detects: pnpm workspaces, npm/yarn workspaces, turbo/nx/lerna, cargo, go.work.
source "$(dirname "$0")/../lib/limit.sh"

: "${MAX_WORKSPACE_MAP:=${MAX_WORKSPACE_MAP:-60}}"

# ── Node: pnpm workspaces ──
if [ -f "pnpm-workspace.yaml" ] || [ -f "pnpm-workspace.yml" ]; then
  ws_file="pnpm-workspace.yaml"
  [ -f "pnpm-workspace.yml" ] && ws_file="pnpm-workspace.yml"
  dirs=""
  while IFS= read -r glob; do
    [ -z "$glob" ] && continue
    while IFS= read -r d; do
      [ -z "$d" ] && continue
      [ -f "${d}/package.json" ] && dirs="${dirs}${d}"$'\n'
    done < <(eval "ls -d $glob 2>/dev/null")
  done < <(sed -n 's/^[[:space:]]*-[[:space:]]*["'\'']*\(.*\)["'\'']*$/\1/p' "$ws_file" 2>/dev/null)

  pkg_count=0
  pkg_names=""
  output=""
  while IFS= read -r dir; do
    [ -z "$dir" ] && continue
    name=$(jq -r '.name // "unnamed"' "${dir}/package.json" 2>/dev/null)
    output="${output}${name} (${dir})"$'\n'
    pkg_names="${pkg_names}${name}|"
    pkg_count=$((pkg_count + 1))
  done <<< "$dirs"

  echo "pnpm workspace: ${pkg_count} package(s)"
  echo ""
  echo "$output" | head -"$MAX_WORKSPACE_MAP"

  if command -v jq &>/dev/null && [ -n "$pkg_names" ]; then
    edges=""
    while IFS= read -r dir; do
      [ -z "$dir" ] && continue
      src_name=$(jq -r '.name // "unnamed"' "${dir}/package.json" 2>/dev/null)
      while IFS= read -r dep; do
        [ -z "$dep" ] && continue
        case "$pkg_names" in
          *"${dep}|"*) edges="${edges}${src_name} → ${dep}"$'\n' ;;
        esac
      done < <(jq -r '(.dependencies // {}) + (.devDependencies // {}) | keys[]' "${dir}/package.json" 2>/dev/null)
    done <<< "$dirs"
    if [ -n "$edges" ]; then
      echo "Internal deps:"
      echo "$edges" | sort -u | head -"$MAX_WORKSPACE_MAP"
    fi
  fi
  exit 0
fi

# ── Node: npm/yarn workspaces (in package.json) ──
if [ -f "package.json" ] && command -v jq &>/dev/null; then
  workspaces=$(jq -r '.workspaces // [] | if type == "array" then .[] elif type == "object" then (.packages // [])[] else empty end' package.json 2>/dev/null)
  if [ -n "$workspaces" ]; then
    dirs=""
    while IFS= read -r glob; do
      [ -z "$glob" ] && continue
      while IFS= read -r d; do
        [ -z "$d" ] && continue
        [ -f "${d}/package.json" ] && dirs="${dirs}${d}"$'\n'
      done < <(eval "ls -d $glob 2>/dev/null")
    done <<< "$workspaces"

    pkg_count=0
    output=""
    while IFS= read -r dir; do
      [ -z "$dir" ] && continue
      name=$(jq -r '.name // "unnamed"' "${dir}/package.json" 2>/dev/null)
      desc=$(jq -r '.description // ""' "${dir}/package.json" 2>/dev/null)
      [ -n "$desc" ] && output="${output}${name} (${dir}) — ${desc}"$'\n' || output="${output}${name} (${dir})"$'\n'
      pkg_count=$((pkg_count + 1))
    done <<< "$dirs"

    echo "npm/yarn workspace: ${pkg_count} package(s)"
    echo ""
    echo "$output" | head -"$MAX_WORKSPACE_MAP"
    exit 0
  fi
fi

# ── Cargo workspace ──
if [ -f "Cargo.toml" ] && grep -q '\[workspace\]' Cargo.toml 2>/dev/null; then
  echo "Cargo workspace:"
  sed -n '/\[workspace\]/,/^\[/p' Cargo.toml | sed -n 's/.*members[[:space:]]*=[[:space:]]*\[\([^]]*\)\].*/\1/p' | head -1 | tr -d '"' | tr ',' '\n' | sed 's/^[[:space:]]*//' | grep -v '^$' | while IFS= read -r m; do
    [ -z "$m" ] && continue
    toml="${m}/Cargo.toml"
    if [ -f "$toml" ]; then
      name=$(grep '^name' "$toml" | head -1 | sed 's/name\s*=\s*"//;s/"//')
      echo "  ${name:-$m} ($m)"
    else
      echo "  $m"
    fi
  done | head -"$MAX_WORKSPACE_MAP"
  exit 0
fi

# ── Go workspace ──
if [ -f "go.work" ]; then
  echo "Go workspace:"
  sed -n 's/.*use[[:space:]]*(\([^)]*\)).*/\1/p' go.work 2>/dev/null | tr '\n' ' ' | sed 's/"/ /g' | tr ' ' '\n' | grep -v '^$' | while IFS= read -r dir; do
    [ -z "$dir" ] && continue
    mod="${dir}/go.mod"
    if [ -f "$mod" ]; then
      name=$(head -1 "$mod" | sed 's/module //')
      echo "  ${name} ($dir)"
    else
      echo "  $dir"
    fi
  done | head -"$MAX_WORKSPACE_MAP"
  exit 0
fi

# ── Fallback: monorepo directory heuristic ──
found=0
for dir in apps packages services libs modules; do
  if [ -d "$dir" ]; then
    if [ "$found" -eq 0 ]; then
      echo "Monorepo structure (heuristic):"
      found=1
    fi
    entries=$(ls -d "$dir"/*/ 2>/dev/null | sed 's:/$::' | head -20)
    if [ -n "$entries" ]; then
      echo ""
      echo "$dir/"
      echo "$entries" | while IFS= read -r sub; do
        base=$(basename "$sub")
        desc=""
        [ -f "$sub/package.json" ] && desc=$(jq -r '.description // ""' "$sub/package.json" 2>/dev/null)
        [ -n "$desc" ] && echo "  $base — $desc" || echo "  $base"
      done
    fi
  fi
done
if [ "$found" -eq 1 ]; then
  exit 0
fi

echo "No monorepo/workspace structure detected"
