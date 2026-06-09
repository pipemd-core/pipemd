#!/usr/bin/env bash
# lint-compact.sh — Shared compact lint summary functions.
# Sourced by ecosystem-specific lint.sh scripts.
# Requires: limit.sh already sourced (for MAX_LINT, limit_output).
#
# PMD_LINT_SEVERITY env var:
#   error   — only show errors + one-line warning count
#   compact — summary-first format (default)
#   full    — raw linter output, truncated by limit_output

PMD_LINT_SEVERITY="${PMD_LINT_SEVERITY:-compact}"

# _join_comma — joins stdin lines with ", " separator (no paste cycling bug).
_join_comma() {
  paste -sd ',' - | sed 's/,/, /g'
}

# _extract_rules — extracts bracketed rule names without grep -oP (macOS safe).
# Usage: echo "$out" | _extract_rules
# Input lines may contain [rule-name]; extracts the rule name.
_extract_rules() {
  sed -n 's/.*\[\([^]]*\)\].*/\1/p'
}

# _rule_summary — takes rule-per-line input, counts, formats top 5.
# Input: one rule name per line. Output: "rule1 ×N, rule2 ×M, ..."
_rule_summary() {
  sort | uniq -c | sort -rn | head -5 | awk '{printf "%s ×%d\n", $2, $1}' | _join_comma
}

# ── ESLint ──────────────────────────────────────────────────────────

compact_eslint() {
  local max_lines="${1:-$MAX_LINT}"
  shift || true

  if [ "$PMD_LINT_SEVERITY" = "full" ]; then
    local out
    out=$(npx eslint . --format=stylish "$@" 2>&1 | grep -v "^$")
    limit_output "$out" "$max_lines" "$(echo "$out" | head -3 && echo "... and $(( $(echo "$out" | wc -l) - 3 )) more lint issues")"
    return
  fi

  if command -v jq &>/dev/null; then
    local json
    json=$(npx eslint . --format json "$@" 2>/dev/null)
    if [ -z "$json" ]; then
      echo "No lint errors"
      return
    fi
    case "$json" in
      "["*) ;;
      *) echo "No lint errors" ; return ;;
    esac
    _compact_eslint_jq "$json" "$max_lines"
  else
    _compact_eslint_stylish "$max_lines" "$@"
  fi
}

_compact_eslint_jq() {
  local json="$1"
  local max_lines="$2"

  local errors warnings total_files
  errors=$(echo "$json" | jq '[.[].errorCount] | add // 0')
  warnings=$(echo "$json" | jq '[.[].warningCount] | add // 0')
  total_files=$(echo "$json" | jq '[.[] | select(.messages | length > 0)] | length')

  if [ "$errors" = "0" ] && [ "$warnings" = "0" ]; then
    echo "No lint errors"
    return
  fi

  if [ "$PMD_LINT_SEVERITY" = "error" ] && [ "$errors" = "0" ]; then
    echo "0 errors, ${warnings} warnings (set PMD_LINT_SEVERITY=compact to show)"
    return
  fi

  local used=1
  local strip_prefix="${PWD}/"

  if [ "$warnings" = "0" ]; then
    echo "${errors} error(s) across ${total_files} file(s)"
  elif [ "$errors" = "0" ]; then
    echo "${warnings} warning(s) across ${total_files} file(s)"
  else
    echo "${errors} error(s), ${warnings} warning(s) across ${total_files} file(s)"
  fi

  local rule_summary
  rule_summary=$(echo "$json" | jq -r '
    [.[].messages[] | select(.ruleId != null) | .ruleId] |
    group_by(.) | map({rule: .[0], count: length}) | sort_by(-.count) |
    limit(5; .[]) | "\(.rule) ×\(.count)"
  ' | _join_comma)
  if [ -n "$rule_summary" ]; then
    echo "Rules: $rule_summary"
    used=$((used + 1))
  fi

  if [ "$errors" != "0" ]; then
    local err_lines
    err_lines=$(echo "$json" | jq -r --arg prefix "$strip_prefix" '
      [.[] | (.filePath | sub($prefix; "")) as $rel |
       .messages[] | select(.severity == 2) |
       "\($rel):\(.line)  error  \(.ruleId // "parse-error") — \(.message)"]
      | .[]
    ' 2>/dev/null)
    if [ -n "$err_lines" ]; then
      local err_count
      err_count=$(echo "$err_lines" | wc -l)
      local err_budget=$((max_lines - used - 2))
      if [ "$err_budget" -lt 3 ]; then err_budget=5; fi
      echo "Errors:"
      if [ "$err_count" -le "$err_budget" ]; then
        echo "$err_lines"
        used=$((used + 1 + err_count))
      else
        echo "$err_lines" | head -"$err_budget"
        echo "... +$((err_count - err_budget)) more error(s)"
        used=$((used + 1 + err_budget))
      fi
    fi
  fi

  if [ "$PMD_LINT_SEVERITY" = "error" ]; then
    return
  fi

  if [ "$warnings" != "0" ]; then
    local warn_lines
    warn_lines=$(echo "$json" | jq -r --arg prefix "$strip_prefix" '
      [.[] | (.filePath | sub($prefix; "")) as $rel |
       .messages[] | select(.severity == 1) |
       "\($rel):\(.line)  \(.ruleId // "unknown") — \(.message)"]
      | .[]
    ' 2>/dev/null)
    if [ -n "$warn_lines" ]; then
      local warn_total
      warn_total=$(echo "$warn_lines" | wc -l)
      if [ "$warn_total" -le 3 ]; then
        echo "Warnings:"
        echo "$warn_lines"
      else
        echo "Sample warnings (first 3 of ${warn_total}):"
        echo "$warn_lines" | head -3
        local warn_files
        warn_files=$(echo "$json" | jq -r '[.[] | select(.warningCount > 0)] | length')
        echo "... +$((warn_total - 3)) more in ${warn_files} file(s)"
      fi
    fi
  fi
}

_compact_eslint_stylish() {
  local max_lines="$1"
  shift || true
  local out
  out=$(npx eslint . --format=stylish "$@" 2>&1 | grep -v "^$")
  if [ -z "$out" ]; then
    echo "No lint errors"
    return
  fi
  local total
  total=$(echo "$out" | wc -l)
  echo "$out" | head -3
  echo "... and $((total - 3)) more lint lines (install jq for compact summaries)"
}

# ── Ruff ────────────────────────────────────────────────────────────

compact_ruff() {
  local max_lines="${1:-$MAX_LINT}"
  shift || true

  if [ "$PMD_LINT_SEVERITY" = "full" ]; then
    local out
    out=$(ruff check . "$@" 2>&1)
    limit_output "$out" "$max_lines" "$(echo "$out" | head -3 && echo '... more lint issues')"
    return
  fi

  local out
  out=$(ruff check . --output-format concise "$@" 2>&1)
  if [ -z "$out" ] || echo "$out" | grep -q "All checks passed"; then
    echo "No lint errors"
    return
  fi

  local errors total warnings files
  errors=$(echo "$out" | grep -cE '\[E[0-9]' || true)
  total=$(echo "$out" | wc -l)
  warnings=$((total - errors))

  if [ "$PMD_LINT_SEVERITY" = "error" ] && [ "$errors" = "0" ]; then
    echo "0 errors, ${warnings} warning(s) (set PMD_LINT_SEVERITY=compact to show)"
    return
  fi

  files=$(echo "$out" | awk -F: '{print $1}' | sort -u | wc -l)
  echo "${errors} error(s), ${warnings} warning(s) across ${files} file(s)"

  local rules
  rules=$(echo "$out" | _extract_rules | _rule_summary)
  if [ -n "$rules" ]; then
    echo "Rules: $rules"
  fi

  if [ "$errors" != "0" ]; then
    echo "Errors:"
    echo "$out" | grep -E '\[E[0-9]' | head -"$max_lines"
  fi

  if [ "$PMD_LINT_SEVERITY" = "error" ]; then
    return
  fi

  if [ "$warnings" -gt 0 ]; then
    local warn_out
    warn_out=$(echo "$out" | grep -vE '\[E[0-9]')
    if [ -n "$warn_out" ]; then
      local warn_total
      warn_total=$(echo "$warn_out" | wc -l)
      echo "Sample warnings (first 3 of ${warn_total}):"
      echo "$warn_out" | head -3
      local remaining=$((warn_total - 3))
      if [ "$remaining" -gt 0 ]; then
        echo "... +${remaining} more"
      fi
    fi
  fi
}

# ── Flake8 ──────────────────────────────────────────────────────────

compact_flake8() {
  local max_lines="${1:-$MAX_LINT}"
  shift || true

  local out
  out=$(flake8 . --count --select=E9,F63,F7,F82 --show-source --statistics "$@" 2>&1)
  if [ -z "$out" ]; then
    echo "No lint errors"
    return
  fi

  if [ "$PMD_LINT_SEVERITY" = "full" ]; then
    limit_output "$out" "$max_lines" "$(echo "$out" | head -3 && echo '... more flake8 errors')"
    return
  fi

  local total files
  total=$(echo "$out" | grep -cE '^[^ ]' || true)
  files=$(echo "$out" | grep -E '^[^ ]' | awk -F: '{print $1}' | sort -u | wc -l)
  echo "${total} error(s) across ${files} file(s)"
  echo "$out" | grep -E '^[^ ]' | head -"$max_lines"
}

# ── Clippy ──────────────────────────────────────────────────────────

compact_clippy() {
  local max_lines="${1:-$MAX_LINT}"
  shift || true

  local out
  out=$(cargo clippy --message-format=short 2>&1 | grep -E '^(error|warning)\[' || true)
  if [ -z "$out" ]; then
    echo "No clippy warnings"
    return
  fi

  if [ "$PMD_LINT_SEVERITY" = "full" ]; then
    limit_output "$out" "$max_lines" "$(echo "$out" | head -3 && echo '... more clippy warnings')"
    return
  fi

  local errors warnings files
  errors=$(echo "$out" | grep -c '^error' || true)
  warnings=$(echo "$out" | grep -c '^warning' || true)

  if [ "$PMD_LINT_SEVERITY" = "error" ] && [ "$errors" = "0" ]; then
    echo "0 errors, ${warnings} warning(s) (set PMD_LINT_SEVERITY=compact to show)"
    return
  fi

  files=$(echo "$out" | awk -F: '{print $1}' | sort -u | wc -l)
  echo "${errors} error(s), ${warnings} warning(s) across ${files} file(s)"

  local rules
  rules=$(echo "$out" | _extract_rules | _rule_summary)
  if [ -n "$rules" ]; then
    echo "Rules: $rules"
  fi

  if [ "$errors" != "0" ]; then
    echo "Errors:"
    echo "$out" | grep '^error' | head -"$max_lines"
  fi

  if [ "$PMD_LINT_SEVERITY" = "error" ]; then
    return
  fi

  if [ "$warnings" != "0" ]; then
    local warn_out
    warn_out=$(echo "$out" | grep '^warning')
    local warn_total
    warn_total=$(echo "$warn_out" | wc -l)
    echo "Sample warnings (first 3 of ${warn_total}):"
    echo "$warn_out" | head -3
    local remaining=$((warn_total - 3))
    if [ "$remaining" -gt 0 ]; then
      echo "... +${remaining} more"
    fi
  fi
}

# ── Go Vet ──────────────────────────────────────────────────────────

compact_go_vet() {
  local max_lines="${1:-$MAX_LINT}"
  shift || true

  local out
  out=$(go vet ./... 2>&1 || true)
  if [ -z "$out" ]; then
    echo "No go vet issues"
    return
  fi

  if [ "$PMD_LINT_SEVERITY" = "full" ]; then
    limit_output "$out" "$max_lines" "$(echo "$out" | head -3 && echo '... more go vet warnings')"
    return
  fi

  local total files
  total=$(echo "$out" | wc -l)
  files=$(echo "$out" | awk -F: '{print $1}' | sort -u | wc -l)
  echo "${total} issue(s) across ${files} package(s)"
  echo "$out" | head -"$max_lines"
}

# ── Clang-Tidy ──────────────────────────────────────────────────────

compact_clang_tidy() {
  local max_lines="${1:-$MAX_LINT}"
  shift || true

  local out
  out=$(clang-tidy --checks='-*,bugprone-*,modernize-*,readability-*' -p build . 2>&1 || true)
  if [ -z "$out" ] || echo "$out" | grep -q "no warnings"; then
    echo "No clang-tidy warnings"
    return
  fi

  if [ "$PMD_LINT_SEVERITY" = "full" ]; then
    limit_output "$out" "$max_lines" "$(echo "$out" | head -3 && echo '... more clang-tidy warnings')"
    return
  fi

  local total files
  total=$(echo "$out" | grep -cE 'warning:|error:' || true)
  files=$(echo "$out" | grep -E 'warning:|error:' | awk -F: '{print $1}' | sort -u | wc -l)
  echo "${total} issue(s) across ${files} file(s)"

  local rules
  rules=$(echo "$out" | _extract_rules | _rule_summary)
  if [ -n "$rules" ]; then
    echo "Rules: $rules"
  fi

  echo "$out" | grep -E 'warning:|error:' | head -"$max_lines"
}

# ── Cppcheck ────────────────────────────────────────────────────────

compact_cppcheck() {
  local max_lines="${1:-$MAX_LINT}"
  shift || true

  local out
  out=$(cppcheck --enable=all --suppress=missingInclude . 2>&1 || true)

  local diagnostics
  diagnostics=$(echo "$out" | grep -E '^\[' || true)
  if [ -z "$diagnostics" ]; then
    echo "No cppcheck warnings"
    return
  fi

  if [ "$PMD_LINT_SEVERITY" = "full" ]; then
    limit_output "$out" "$max_lines" "$(echo "$out" | head -3 && echo '... more cppcheck warnings')"
    return
  fi

  local total files
  total=$(echo "$diagnostics" | wc -l)
  files=$(echo "$diagnostics" | sed -n 's/^\[\([^:]*\).*/\1/p' | sort -u | wc -l)
  echo "${total} issue(s) across ${files} file(s)"
  echo "$diagnostics" | head -"$max_lines"
}
