#!/usr/bin/env bash
set -uo pipefail
# C/C++ dependency detection — Makefile, CMake, Conan, vcpkg
source "$(dirname "$0")/../lib/limit.sh"

if [ -f CMakeLists.txt ]; then
  out=$(grep -E '^\s*find_package|^\s*FetchContent_Declare|^\s*target_link_libraries' CMakeLists.txt 2>/dev/null | head -"$MAX_DEPS")
  if [ -n "$out" ]; then
    echo "CMake dependencies:"
    echo "$out"
    exit 0
  fi
fi

if [ -f Makefile ] || [ -f makefile ]; then
  makefile="${makefile:-Makefile}"
  [ -f makefile ] && makefile="makefile"
  out=$(grep -E '^\s*(include|require|load|use)' "$makefile" 2>/dev/null | head -"$MAX_DEPS")
  if [ -n "$out" ]; then
    echo "Makefile dependencies:"
    echo "$out"
    exit 0
  fi
fi

if [ -f conanfile.txt ]; then
  out=$(grep -E '^\s*[a-zA-Z]' conanfile.txt 2>/dev/null | head -"$MAX_DEPS")
  if [ -n "$out" ]; then
    echo "Conan dependencies:"
    echo "$out"
    exit 0
  fi
fi

if [ -f vcpkg.json ]; then
  out=$(node -e "try{const p=require('./vcpkg.json');console.log((p.dependencies||[]).join('\n'))}catch{}" 2>/dev/null)
  if [ -n "$out" ]; then
    echo "vcpkg dependencies:"
    echo "$out"
    exit 0
  fi
fi

echo "No recognized C/C++ dependency file found"