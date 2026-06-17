#!/usr/bin/env bash
set -uo pipefail
# Python dependencies + toolchain + verify commands.
# Collects from requirements.txt, pyproject.toml ([project.dependencies] +
# [project.optional-dependencies]) and setup.cfg ([options] install_requires).
# Then surfaces the verify/lint tools actually installed on PATH — the thing
# agents otherwise discover by trial (ruff vs flake8, pytest, mypy).
source "$(dirname "$0")/../lib/limit.sh"

collect_deps() {
  if [ -f requirements.txt ]; then
    grep -vE '^[[:space:]]*(#|$)' requirements.txt 2>/dev/null \
      | sed -E 's/[<=>!~].*//; s/\[[^]]*\]//; s/^[[:space:]]+//' \
      | awk 'length>0' | sort -u | head -"$MAX_DEPS"
    return
  fi
  if [ -f pyproject.toml ]; then
    awk '
      /^\[project\.dependencies\]/        { mode="bare"; next }
      /^\[project\.optional-dependencies\]/{ mode="array"; next }
      /^\[/                                { mode=""; next }
      mode=="bare" && /^[a-zA-Z]/ {
        gsub(/#.*/,""); gsub(/;.*/,""); gsub(/"/,""); sub(/[<=>!~].*/,"")
        if (length($0)>0) print
      }
      mode=="array" {
        line=$0
        while (match(line, /"[^"]+"/)) {
          pkg=substr(line, RSTART+1, RLENGTH-2); sub(/[<=>!~].*/, "", pkg)
          if (length(pkg)>0) print pkg
          line=substr(line, RSTART+RLENGTH)
        }
      }
    ' pyproject.toml 2>/dev/null | sort -u | head -"$MAX_DEPS"
    return
  fi
  if [ -f setup.cfg ]; then
    awk '
      /^\[options\]/ { in_opts=1; next }
      /^\[/          { in_opts=0; in_ir=0 }
      in_opts && /^[[:space:]]*install_requires[[:space:]]*=/ { in_ir=1; next }
      in_ir && /^[[:space:]]+/ {
        gsub(/[<=>!~].*/,""); gsub(/['"'"'"]/,""); gsub(/^[[:space:]]+/,"")
        if (length($0)>0) print
      }
      in_ir && !/^[[:space:]]+/ { in_ir=0 }
    ' setup.cfg 2>/dev/null | sort -u | head -"$MAX_DEPS"
    return
  fi
}

if command -v python3 &>/dev/null; then
  py_ver=$(python3 --version 2>&1)
  [ -n "$py_ver" ] && echo "Toolchain: $py_ver"
fi

deps=$(collect_deps)
if [ -n "$deps" ]; then
  echo "Dependencies:"
  echo "$deps"
else
  echo "Dependencies: none declared"
fi

verify=""
command -v pytest  &>/dev/null && verify="${verify}  test: pytest
"
command -v ruff    &>/dev/null && verify="${verify}  lint: ruff check src/
"
command -v flake8  &>/dev/null && verify="${verify}  lint: flake8 src/
"
command -v mypy    &>/dev/null && verify="${verify}  typecheck: mypy src/
"
command -v black   &>/dev/null && verify="${verify}  format: black src/
"
[ -n "$verify" ] && printf "Verify:\n%s" "$verify"
