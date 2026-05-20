#!/usr/bin/env bash
set -uo pipefail
# compose-md — Deep prompt builder: assembles README.md and docs from sub-projects
# Discovers tracked .md files via git, classifies by importance, truncates smartly,
# and outputs a structured concatenation suitable for AI context.
#
# Environment variables (set by limit.sh or override):
#   PMD_COMPOSE_DEPTH       Max directory depth to search (default: 4)
#   PMD_COMPOSE_MAX_FILES    Max files to include (default: 15)
#   PMD_COMPOSE_ROOT_LINES   Line limit for root README.md (default: 200)
#   PMD_COMPOSE_OTHER_ROOT_LINES  Line limit for other root .md files (default: 80)
#   PMD_COMPOSE_SUB_LINES    Line limit for sub-directory READMEs (default: 50)
#   PMD_COMPOSE_DEEP_LINES   Line limit for deeper .md files (default: 30)
#   MAX_COMPOSE              Total line budget (set by limit.sh per token profile)
#   PMD_TOKEN_PROFILE        Token profile: low|medium|high|xhigh|unlimited
source "$(dirname "$0")/../lib/limit.sh"

: "${PMD_COMPOSE_DEPTH:=4}"
: "${PMD_COMPOSE_MAX_FILES:=15}"
: "${PMD_COMPOSE_ROOT_LINES:=200}"
: "${PMD_COMPOSE_OTHER_ROOT_LINES:=80}"
: "${PMD_COMPOSE_SUB_LINES:=50}"
: "${PMD_COMPOSE_DEEP_LINES:=30}"
: "${MAX_COMPOSE:=${MAX_COMPOSE:-150}}"

EXCLUDE_NAMES="AGENTS.md AI_CONTEXT.md pmd.md CLAUDE.md WORKSPACE_CONTEXT.md"
EXCLUDE_DIRS=".pipemd node_modules .git vendor __pycache__ .next .nuxt dist build out coverage .cache .venv .tox"

excluded_name() {
  local name="$1"
  for exc in $EXCLUDE_NAMES; do
    [ "$name" = "$exc" ] && return 0
  done
  return 1
}

excluded_path() {
  local rel="$1"
  for exc in $EXCLUDE_DIRS; do
    case "$rel" in
      "$exc"/*|"$exc") return 0 ;;
    esac
  done
  return 1
}

if ! git rev-parse --is-inside-work-tree &>/dev/null; then
  echo "Not a git repository — cannot discover markdown files"
  exit 0
fi

files=()
while IFS= read -r f; do
  [ -z "$f" ] && continue
  name="$(basename "$f")"
  excluded_name "$name" && continue
  excluded_path "$f" && continue
  files+=("$f")
done < <(git ls-files '*.md' '*.MD' '*.Markdown' '*.markdown' 2>/dev/null | sort)

if [ ${#files[@]} -eq 0 ]; then
  echo "No tracked markdown files found"
  exit 0
fi

classify() {
  local rel="$1"
  local depth
  depth="$(echo "$rel" | tr -cd '/' | wc -c)"
  local name
  name="$(basename "$rel")"

  if [ "$depth" -eq 0 ]; then
    if [ "$name" = "README.md" ] || [ "$name" = "README.MD" ]; then
      echo "root-README"
    else
      echo "root-other"
    fi
  elif [ "$depth" -le 1 ]; then
    if [ "$name" = "README.md" ] || [ "$name" = "README.MD" ]; then
      echo "sub-README"
    else
      echo "deep-md"
    fi
  else
    if [ "$name" = "README.md" ] || [ "$name" = "README.MD" ]; then
      echo "sub-README"
    else
      echo "deep-md"
    fi
  fi
}

sort_key() {
  local rel="$1"
  local cls
  cls="$(classify "$rel")"
  case "$cls" in
    root-README)  echo "0$rel" ;;
    root-other)   echo "1$rel" ;;
    sub-README)   echo "2$rel" ;;
    deep-md)      echo "3$rel" ;;
  esac
}

declare -A file_order
for f in "${files[@]}"; do
  key="$(sort_key "$f")"
  file_order["$key"]="$f"
done

sorted_files=()
for key in $(printf '%s\n' "${!file_order[@]}" | sort); do
  sorted_files+=("${file_order[$key]}")
done

max_line_limit() {
  local cls="$1"
  case "$cls" in
    root-README)       echo "$PMD_COMPOSE_ROOT_LINES" ;;
    root-other)        echo "$PMD_COMPOSE_OTHER_ROOT_LINES" ;;
    sub-README)        echo "$PMD_COMPOSE_SUB_LINES" ;;
    deep-md)           echo "$PMD_COMPOSE_DEEP_LINES" ;;
    *)                 echo "$PMD_COMPOSE_DEEP_LINES" ;;
  esac
}

total_lines=0
included=0
truncated=0

for f in "${sorted_files[@]}"; do
  [ "$included" -ge "$PMD_COMPOSE_MAX_FILES" ] && break

  cls="$(classify "$f")"
  limit="$(max_line_limit "$cls")"

  if [ "$total_lines" -ge "$MAX_COMPOSE" ]; then
    break
  fi

  content=""
  if [ -f "$f" ]; then
    content="$(head -n "$limit" "$f" 2>/dev/null)" || continue
  else
    continue
  fi

  actual_lines="$(echo "$content" | wc -l)"
  was_truncated=0

  real_lines="$(wc -l < "$f" 2>/dev/null)" || real_lines="$actual_lines"
  if [ "$real_lines" -gt "$limit" ]; then
    was_truncated=1
    truncated=$((truncated + 1))
  fi

  budget_left=$((MAX_COMPOSE - total_lines))
  if [ "$actual_lines" -gt "$budget_left" ]; then
    content="$(echo "$content" | head -n "$budget_left")"
    actual_lines="$(echo "$content" | wc -l)"
    was_truncated=1
  fi

  echo ""
  echo "### $f"
  echo ""
printf '%s\n' "$content"

  if [ "$was_truncated" -eq 1 ]; then
    echo ""
    echo "... *(truncated, ${real_lines} lines total)*"
  fi

  total_lines=$((total_lines + actual_lines + 3))
  included=$((included + 1))
done

echo ""
echo "---"
echo ""
echo "*${included} files composed, ${total_lines} lines${truncated:+ (${truncated} truncated)}*"