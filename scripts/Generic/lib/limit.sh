#!/usr/bin/env bash
set -uo pipefail
# limit.sh — Smart output limiter with compact fallbacks
# TOKEN profile multiplier (override via PMD_TOKEN_PROFILE env var)
PMD_TOKEN_PROFILE="${PMD_TOKEN_PROFILE:-medium}"
case "$PMD_TOKEN_PROFILE" in
  low)    MULT_NUM=1; MULT_DEN=2 ;;
  medium) MULT_NUM=1; MULT_DEN=1 ;;
  high)   MULT_NUM=3; MULT_DEN=2 ;;
  xhigh)  MULT_NUM=2; MULT_DEN=1 ;;
  unlimited) PMD_UNLIMITED=1 ;;
  *)      MULT_NUM=1; MULT_DEN=1 ;;
esac

# Token budget constants (override via PMD_MAX_* env vars, scaled by profile)
if [ "${PMD_UNLIMITED:-0}" = "1" ]; then
  MAX_TREE=${PMD_MAX_TREE:-99999}
  MAX_DEPS=${PMD_MAX_DEPS:-99999}
  MAX_TODOS=${PMD_MAX_TODOS:-99999}
  MAX_LOG=${PMD_MAX_LOG:-99999}
  MAX_BRANCH=${PMD_MAX_BRANCH:-99999}
  MAX_STATUS=${PMD_MAX_STATUS:-99999}
  MAX_DIFF=${PMD_MAX_DIFF:-99999}
  MAX_TYPECHECK=${PMD_MAX_TYPECHECK:-99999}
  MAX_LINT=${PMD_MAX_LINT:-99999}
  MAX_TEST=${PMD_MAX_TEST:-99999}
  MAX_PRISMA=${PMD_MAX_PRISMA:-99999}
  MAX_EXPRESS=${PMD_MAX_EXPRESS:-99999}
  MAX_FASTAPI=${PMD_MAX_FASTAPI:-99999}
  MAX_DJANGO=${PMD_MAX_DJANGO:-99999}
  MAX_SQLALCHEMY=${PMD_MAX_SQLALCHEMY:-99999}
  MAX_NEST=${PMD_MAX_NEST:-99999}
  MAX_NEXTJS=${PMD_MAX_NEXTJS:-99999}
  MAX_REACT=${PMD_MAX_REACT:-99999}
  MAX_ANGULAR=${PMD_MAX_ANGULAR:-99999}
  MAX_CMAKE=${PMD_MAX_CMAKE:-99999}
  MAX_CLASS=${PMD_MAX_CLASS:-99999}
  MAX_INTERFACE=${PMD_MAX_INTERFACE:-99999}
  MAX_INCLUDE=${PMD_MAX_INCLUDE:-99999}
  MAX_CARGO=${PMD_MAX_CARGO:-99999}
  MAX_GO_PKGS=${PMD_MAX_GO_PKGS:-99999}
  MAX_CARGO_FEATURES=${PMD_MAX_CARGO_FEATURES:-99999}
  MAX_GO_INTERFACES=${PMD_MAX_GO_INTERFACES:-99999}
  MAX_DOCKER=${PMD_MAX_DOCKER:-99999}
  MAX_K8S=${PMD_MAX_K8S:-99999}
  MAX_TF=${PMD_MAX_TF:-99999}
  MAX_AWS=${PMD_MAX_AWS:-99999}
  MAX_ARCH=${PMD_MAX_ARCH:-99999}
  MAX_COMPOSE=${PMD_MAX_COMPOSE:-99999}
  MAX_CREW=${PMD_MAX_CREW:-99999}
else
  MAX_TREE=$(( (${PMD_MAX_TREE:-50} * MULT_NUM) / MULT_DEN ))
  MAX_DEPS=$(( (${PMD_MAX_DEPS:-40} * MULT_NUM) / MULT_DEN ))
  MAX_TODOS=$(( (${PMD_MAX_TODOS:-20} * MULT_NUM) / MULT_DEN ))
  MAX_LOG=$(( (${PMD_MAX_LOG:-20} * MULT_NUM) / MULT_DEN ))
  MAX_BRANCH=$(( (${PMD_MAX_BRANCH:-20} * MULT_NUM) / MULT_DEN ))
  MAX_STATUS=$(( (${PMD_MAX_STATUS:-30} * MULT_NUM) / MULT_DEN ))
  MAX_DIFF=$(( (${PMD_MAX_DIFF:-30} * MULT_NUM) / MULT_DEN ))
  MAX_TYPECHECK=$(( (${PMD_MAX_TYPECHECK:-30} * MULT_NUM) / MULT_DEN ))
  MAX_LINT=$(( (${PMD_MAX_LINT:-20} * MULT_NUM) / MULT_DEN ))
  MAX_TEST=$(( (${PMD_MAX_TEST:-10} * MULT_NUM) / MULT_DEN ))
  MAX_PRISMA=$(( (${PMD_MAX_PRISMA:-40} * MULT_NUM) / MULT_DEN ))
  MAX_EXPRESS=$(( (${PMD_MAX_EXPRESS:-30} * MULT_NUM) / MULT_DEN ))
  MAX_FASTAPI=$(( (${PMD_MAX_FASTAPI:-30} * MULT_NUM) / MULT_DEN ))
  MAX_DJANGO=$(( (${PMD_MAX_DJANGO:-40} * MULT_NUM) / MULT_DEN ))
  MAX_SQLALCHEMY=$(( (${PMD_MAX_SQLALCHEMY:-40} * MULT_NUM) / MULT_DEN ))
  MAX_NEST=$(( (${PMD_MAX_NEST:-30} * MULT_NUM) / MULT_DEN ))
  MAX_NEXTJS=$(( (${PMD_MAX_NEXTJS:-30} * MULT_NUM) / MULT_DEN ))
  MAX_REACT=$(( (${PMD_MAX_REACT:-30} * MULT_NUM) / MULT_DEN ))
  MAX_ANGULAR=$(( (${PMD_MAX_ANGULAR:-30} * MULT_NUM) / MULT_DEN ))
  MAX_CMAKE=$(( (${PMD_MAX_CMAKE:-40} * MULT_NUM) / MULT_DEN ))
  MAX_CLASS=$(( (${PMD_MAX_CLASS:-40} * MULT_NUM) / MULT_DEN ))
  MAX_INTERFACE=$(( (${PMD_MAX_INTERFACE:-30} * MULT_NUM) / MULT_DEN ))
  MAX_INCLUDE=$(( (${PMD_MAX_INCLUDE:-40} * MULT_NUM) / MULT_DEN ))
  MAX_CARGO=$(( (${PMD_MAX_CARGO:-40} * MULT_NUM) / MULT_DEN ))
  MAX_GO_PKGS=$(( (${PMD_MAX_GO_PKGS:-40} * MULT_NUM) / MULT_DEN ))
  MAX_CARGO_FEATURES=$(( (${PMD_MAX_CARGO_FEATURES:-20} * MULT_NUM) / MULT_DEN ))
  MAX_GO_INTERFACES=$(( (${PMD_MAX_GO_INTERFACES:-30} * MULT_NUM) / MULT_DEN ))
  MAX_DOCKER=$(( (${PMD_MAX_DOCKER:-30} * MULT_NUM) / MULT_DEN ))
  MAX_K8S=$(( (${PMD_MAX_K8S:-20} * MULT_NUM) / MULT_DEN ))
  MAX_TF=$(( (${PMD_MAX_TF:-40} * MULT_NUM) / MULT_DEN ))
  MAX_AWS=$(( (${PMD_MAX_AWS:-10} * MULT_NUM) / MULT_DEN ))
  MAX_ARCH=$(( (${PMD_MAX_ARCH:-100} * MULT_NUM) / MULT_DEN ))
  MAX_COMPOSE=$(( (${PMD_MAX_COMPOSE:-150} * MULT_NUM) / MULT_DEN ))
  MAX_CREW=$(( (${PMD_MAX_CREW:-40} * MULT_NUM) / MULT_DEN ))
fi

TREE_EXCLUDES="${PMD_TREE_EXCLUDES:-.git|.pipemd}"

limit_output() {
  local text="$1"
  local max="${2:-25}"
  local fallback="$3"
  local lines
  lines=$(echo "$text" | wc -l)
  if [ "$lines" -le "$max" ]; then
    echo "$text"
  else
    echo "$fallback"
  fi
}

limit_tree() {
  local max="${1:-$MAX_TREE}"
  local excl="${TREE_EXCLUDES}"

  if command -v tree &>/dev/null; then
    local out3
    out3=$(tree -L 3 -I "$excl" --dirsfirst 2>/dev/null)
    local lines3=$(echo "$out3" | wc -l)

    if [ "$lines3" -le "$max" ]; then
      echo "$out3"
      return
    fi

    local out2
    out2=$(tree -L 2 -I "$excl" --dirsfirst 2>/dev/null)
    local lines2=$(echo "$out2" | wc -l)

    if [ "$lines2" -le "$max" ]; then
      echo "$out2"
      echo "(${lines3} lines at depth 3, showing depth 2)"
      return
    fi

    local out1
    out1=$(tree -L 1 -I "$excl" --dirsfirst 2>/dev/null)
    echo "$out1"
    echo "(${lines3} lines at depth 3, showing depth 1)"
  else
    echo "Project structure:"
    find . -maxdepth 3 \
      -not -path '*/.git/*' \
      -not -path '*/.pipemd/*' \
      -not -name '.git' \
      -not -name '.pipemd' \
      2>/dev/null | head -"$max" | sort
  fi
}
