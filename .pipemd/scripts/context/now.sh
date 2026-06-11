#!/usr/bin/env bash
set -uo pipefail
interval="${PMD_NOW_INTERVAL_MIN:-5}"
min=$(date +%M)
rounded=$(( (10#$min / interval) * interval ))
day=$(LC_ALL=C date +%a)
printf "%s %s %02d:%02d %s\n" "$(date +%Y-%m-%d)" "$day" "$(date +%H)" "$rounded" "$(date +%Z)"
