#!/usr/bin/env bash
set -uo pipefail
# Auto-detect dependency file and list dependencies, prioritizing detected ecosystem
source "$(dirname "$0")/../lib/limit.sh"

eco="${PMD_ECOSYSTEM:-}"

show_scripts() {
  node -e "const p=require('./package.json');if(p.scripts){console.log('Scripts:');Object.entries(p.scripts).forEach(([k,v])=>console.log('  '+k+': '+v))}" 2>/dev/null | head -"$MAX_DEPS"
}

check_node() {
  if [ -f package.json ]; then
    out=$(node -e "const p=require('./package.json');const d={...p.dependencies,...p.devDependencies,...p.peerDependencies};if(!Object.keys(d).length){console.log('No dependencies');process.exit()};Object.entries(d).forEach(([k,v])=>console.log(k+' '+v))" 2>/dev/null)
    if [ -n "$out" ]; then
      limit_output "$out" "$MAX_DEPS" "$(echo "$out" | head -5 && echo "... and $(echo "$out" | wc -l) total dependencies")"
      node -e "const p=require('./package.json');if(p.scripts){console.log('Scripts:');Object.entries(p.scripts).slice(0,${MAX_DEPS}).forEach(([k,v])=>console.log('  '+k+': '+v))}" 2>/dev/null || true
      exit 0
    fi
  fi
}

check_python() {
  if [ -f requirements.txt ]; then
    out=$(head -20 requirements.txt)
    limit_output "$out" "$MAX_DEPS" "$(head -5 requirements.txt && echo "... and $(wc -l < requirements.txt) total lines")"
    exit 0
  elif [ -f pyproject.toml ]; then
    out=$(awk '/^\[project\.dependencies\]/{in_deps=1;next}/^\[/{in_deps=0}in_deps&&/^[a-zA-Z_-]/{gsub(/=.*/,"");gsub(/[^a-zA-Z0-9._-]/,"");if(length>0)print}' pyproject.toml 2>/dev/null | head -"$MAX_DEPS")
    if [ -n "$out" ]; then
      echo "Dependencies:"
      echo "$out"
      exit 0
    fi
  fi
}

check_rust() {
  if [ -f Cargo.toml ]; then
    out=$(awk '/^\[dependencies\]/{in_deps=1;next}/^\[/{in_deps=0}in_deps&&/^[a-zA-Z_-]/{gsub(/=.*/,"");gsub(/[^a-zA-Z0-9_-]/,"");if(length>0)print}' Cargo.toml 2>/dev/null | head -"$MAX_DEPS")
    if [ -n "$out" ]; then
      echo "Dependencies:"
      echo "$out"
      exit 0
    fi
  fi
}

check_go() {
  if [ -f go.mod ]; then
    out=$(awk '/^require \(/{in_req=1;next}/^\)/&&in_req/{in_req=0;next}in_req&&/^[[:space:]]+/{print $1,$2}/^require[[:space:]]+/&&!/\(/{print $2,$3}' go.mod 2>/dev/null | head -"$MAX_DEPS")
    if [ -n "$out" ]; then
      echo "Dependencies:"
      echo "$out"
      exit 0
    fi
  fi
}

case "$eco" in
  Node-TypeScript) check_node ;;
  Python) check_python ;;
  Rust) check_rust ;;
  Go) check_go ;;
  C-CPP) ;;
esac

# Generic: try all in order
check_node || true
check_python || true
check_rust || true
check_go || true

echo "No dependency file recognized"