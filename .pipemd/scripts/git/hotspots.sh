#!/usr/bin/env bash
set -uo pipefail
# Git churn hotspots — files with highest change frequency
source "$(dirname "$0")/../lib/limit.sh"

if ! git rev-parse --is-inside-work-tree &>/dev/null; then
  exit 0
fi

total_commits=$(git rev-list --count HEAD 2>/dev/null) || exit 0
[ "$total_commits" -eq 0 ] && exit 0

raw()
{
  if [ "$total_commits" -gt 500 ]; then
    git log --numstat --format="" --since="3 months ago" "$@"
  elif [ "$total_commits" -gt 100 ]; then
    git log --numstat --format="" --since="6 months ago" "$@"
  else
    git log --numstat --format="" "$@"
  fi
}

out=$(raw -- "*.ts" "*.tsx" "*.js" "*.jsx" "*.py" "*.go" "*.rs" "*.java" "*.rb" "*.php" "*.c" "*.cpp" "*.h" "*.hpp" "*.cs" "*.swift" "*.kt" "*.scala" "*.sh" "*.sql" "*.html" "*.css" "*.scss" "*.vue" "*.svelte" 2>/dev/null \
  | awk '
    NF == 3 && $1 != "-" && $2 != "-" {
      f = $3
      added[f] += $1 + 0
      removed[f] += $2 + 0
      churn[f]++
    }
    END {
      n = 0
      for (f in churn) {
        n++
        commits[n] = churn[f]
        file[n] = f
        lines[n] = added[f] + removed[f]
        idx[n] = n
      }
      for (i = 1; i <= n; i++) {
        for (j = i + 1; j <= n; j++) {
          if (commits[idx[j]] > commits[idx[i]] ||
              (commits[idx[j]] == commits[idx[i]] && lines[idx[j]] > lines[idx[i]])) {
            tmp = idx[i]; idx[i] = idx[j]; idx[j] = tmp
          }
        }
      }
      for (i = 1; i <= n && i <= '"${MAX_HOTSPOTS:-15}"'; i++) {
        k = idx[i]
        printf "%3d commits  %+5d lines  %s\n", commits[k], lines[k], file[k]
      }
    }')

[ -z "$out" ] && exit 0
echo "$out"
