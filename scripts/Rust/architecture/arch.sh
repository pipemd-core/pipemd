#!/usr/bin/env bash
set -uo pipefail
# Architecture map — Rust module dependencies
source "$(dirname "$0")/../lib/limit.sh"

: "${MAX_ARCH:=100}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NORMALIZE="$SCRIPT_DIR/normalize.sh"
[ -f "$NORMALIZE" ] || NORMALIZE="$SCRIPT_DIR/../../Shared/architecture/normalize.sh"

if [ ! -f Cargo.toml ]; then
  echo "No Cargo.toml found"
  exit 0
fi

if ! command -v python3 &>/dev/null; then
  echo "python3 is required for Rust architecture extraction"
  exit 0
fi

SRC_DIR=""
[ -d "src" ] && SRC_DIR="src"

if [ -z "$SRC_DIR" ]; then
  echo "No source directory found"
  exit 0
fi

SRC_DIR="$SRC_DIR" python3 -c "
import os, re, sys
from collections import defaultdict

SRC_DIR = os.environ.get('SRC_DIR', 'src')
MAX_MODULES = 40

def module_name(rel_path):
    rel_path = rel_path.replace(os.sep, '/')
    parts = rel_path.split('/')
    filename = os.path.splitext(parts[-1])[0] if parts else ''
    dirpath = parts[:-1] if len(parts) > 1 else []

    if not dirpath:
        return filename

    if len(dirpath) == 1 and dirpath[0] == SRC_DIR:
        return filename if filename in ('main', 'lib') else filename

    last_dir = dirpath[-1]

    if filename == 'mod' or filename == 'lib':
        return last_dir

    if filename == last_dir:
        return last_dir

    return last_dir + '/' + filename

def collect_cargo_deps():
    deps = set()
    try:
        with open('Cargo.toml', 'r', errors='replace') as f:
            content = f.read()
    except Exception:
        return deps

    in_deps = False
    for line in content.split('\n'):
        stripped = line.strip()
        if stripped.startswith('['):
            in_deps = stripped == '[dependencies]'
            continue
        if in_deps and stripped and not stripped.startswith('#'):
            name = stripped.split('=')[0].strip()
            name = re.split(r'[^a-zA-Z0-9_-]', name)[0]
            if name:
                deps.add(name.lower())
    return deps

cargo_deps = collect_cargo_deps()

files = []
for root, dirs, fnames in os.walk(SRC_DIR):
    dirs[:] = [d for d in dirs if not d.startswith('.') and d != 'target']
    for fn in fnames:
        if fn.endswith('.rs'):
            files.append(os.path.join(root, fn))
    if len(files) >= 200:
        files = files[:200]
        break

if not files:
    sys.exit(0)

module_set = set()
for fpath in files:
    rel = os.path.relpath(fpath, '.').replace(os.sep, '/')
    mod = module_name(rel)
    if mod:
        module_set.add(mod)

if len(module_set) > MAX_MODULES:
    module_set = set()
    for fpath in files:
        rel = os.path.relpath(fpath, '.').replace(os.sep, '/')
        parts = rel.split('/')
        if len(parts) > 2:
            module_set.add(parts[1])
        elif len(parts) == 2:
            module_set.add(parts[1].replace('.rs', ''))
        else:
            module_set.add(os.path.splitext(parts[0])[0])

edges = set()

use_re = re.compile(r'^\s*use\s+(.+?);', re.MULTILINE)
mod_re = re.compile(r'^\s*mod\s+([a-zA-Z_]\w*)\s*;', re.MULTILINE)

for fpath in files:
    rel = os.path.relpath(fpath, '.').replace(os.sep, '/')
    src_mod = module_name(rel)
    if not src_mod or src_mod not in module_set:
        continue

    try:
        with open(fpath, 'r', errors='replace') as f:
            content = f.read()
    except Exception:
        continue

    for m in mod_re.finditer(content):
        mod_name = m.group(1)
        if mod_name in module_set and mod_name != src_mod:
            edges.add((src_mod, mod_name))

    for m in use_re.finditer(content):
        path = m.group(1).strip()
        if path.startswith('crate::'):
            crate_path = path[7:]
            first = crate_path.split('::')[0].split('{')[0].strip()
            first = first.replace(',', '').strip()
            if first in module_set and first != src_mod:
                edges.add((src_mod, first))
            elif first and first != src_mod:
                for part in crate_path.split('{'):
                    if '}' in part:
                        for sub in part.replace('}', '').split(','):
                            sub = sub.strip().split('::')[0]
                            if sub in module_set and sub != src_mod:
                                edges.add((src_mod, sub))
        elif path.startswith('super::'):
            rest = path[7:]
            first = rest.split('::')[0].split('{')[0].strip()
            first = first.replace(',', '').strip()
            fdir = os.path.dirname(rel)
            if SRC_DIR and fdir.startswith(SRC_DIR + '/'):
                fdir = fdir[len(SRC_DIR) + 1:]
            elif fdir == SRC_DIR:
                fdir = ''
            parent_parts = fdir.split('/') if fdir else []
            if parent_parts:
                parent_mod = parent_parts[-1]
                if parent_mod in module_set and parent_mod != src_mod:
                    edges.add((src_mod, parent_mod))
        elif path.startswith('self::'):
            pass
        else:
            crate_name = path.split('::')[0].split('{')[0].strip()
            crate_name = crate_name.replace(',', '').strip()
            if crate_name and crate_name not in ('crate', 'super', 'self'):
                if crate_name in cargo_deps:
                    edges.add((src_mod, 'ext:' + crate_name))

for s, d in sorted(edges):
    sys.stdout.write(s + '\t' + d + '\n')
" | MAX_ARCH="$MAX_ARCH" bash "$NORMALIZE"