#!/usr/bin/env bash
set -uo pipefail
# Architecture map — Node/TypeScript module dependencies
source "$(dirname "$0")/../lib/limit.sh"

: "${MAX_ARCH:=100}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NORMALIZE="$SCRIPT_DIR/normalize.sh"
[ -f "$NORMALIZE" ] || NORMALIZE="$SCRIPT_DIR/../../Shared/architecture/normalize.sh"

if ! command -v python3 &>/dev/null; then
  echo "python3 is required for architecture extraction"
  exit 0
fi

SRC_DIR=""
for dir in src lib app; do
  [ -d "$dir" ] && SRC_DIR="$dir" && break
done
[ -z "$SRC_DIR" ] && { echo "No source directory found"; exit 0; }

python3 -c "
import os, re, json, sys
from collections import defaultdict

SRC_DIR = os.environ.get('SRC_DIR', 'src')
MAX_FILES = 500
MAX_MODULES = 80

SKIP_DIRS = {'node_modules', 'dist', '.next', 'coverage', 'build', 'out', '.pipemd', '.git', '__tests__', '__test__', '__mocks__', 'test', 'tests', 'spec', 'specs', 'scripts', 'migrations', 'seed', 'public', 'static', 'assets', 'styles', 'views', 'templates', '.angular', '.cache', '.storybook'}

ENTRY_FILES = {'index', 'main', 'app', 'server', 'mod'}

def should_skip_dir(d):
    return d in SKIP_DIRS or d.startswith('.')

def should_skip_file(f):
    if f.endswith('.d.ts'):
        return True
    if '.test.' in f or '.spec.' in f or '.stories.' in f or '.story.' in f:
        return True
    return False

def module_name(rel_path):
    parts = rel_path.replace(os.sep, '/').split('/')
    filename = os.path.splitext(parts[-1])[0] if parts else ''
    dirpath = parts[:-1] if len(parts) > 1 else []

    if len(dirpath) == 0:
        return filename if filename in ENTRY_FILES else None

    last_dir = dirpath[-1]

    # If there's only one significant file in this dir-level, use the dir name
    # If the file is an entry point (index/main), use the dir name
    if filename in ENTRY_FILES or filename == last_dir:
        return last_dir

    # Otherwise use dir/file to preserve detail
    return last_dir + '/' + filename

def resolve_relative(import_path, file_rel, src_dir):
    file_dir = os.path.dirname(file_rel)
    resolved = os.path.normpath(os.path.join(file_dir, import_path))
    resolved = resolved.replace(os.sep, '/')
    if resolved.startswith(src_dir + '/'):
        resolved = resolved[len(src_dir) + 1:]
    elif resolved == src_dir:
        return None
    return module_name(resolved)

def load_external_deps():
    ext = set()
    for pkgfile in ('package.json',):
        try:
            with open(pkgfile, 'r', errors='replace') as f:
                pkg = json.load(f)
            for section in ('dependencies', 'devDependencies', 'peerDependencies'):
                ext.update(pkg.get(section, {}).keys())
        except Exception:
            pass
    return ext

def external_name(spec):
    if spec.startswith('@'):
        parts = spec.split('/')
        if len(parts) >= 2:
            return parts[0] + '/' + parts[1]
        return parts[0]
    return spec.split('/')[0]

# Match: import X from 'y', import {X} from 'y', require('y'), import('y')
import_re = re.compile(
    r\"\"\"(?:import\s+(?:.*?)\s+from\s+['\"]([^'\"]+)['\"]|require\s*\(\s*['\"]([^'\"]+)['\"]\s*\)|import\s*\(\s*['\"]([^'\"]+)['\"]\s*\))\"\"\",
    re.MULTILINE
)

ext_deps = load_external_deps()

files = []
for root, dirs, filenames in os.walk(SRC_DIR):
    dirs[:] = sorted([d for d in dirs if not should_skip_dir(d)])
    for fn in sorted(filenames):
        if should_skip_file(fn):
            continue
        if fn.endswith(('.ts', '.tsx', '.js', '.jsx')):
            files.append(os.path.join(root, fn))
    if len(files) >= MAX_FILES:
        files = files[:MAX_FILES]
        break

if not files:
    sys.exit(0)

# Count files per directory to decide grouping
dir_counts = defaultdict(list)
for fpath in files:
    rel = os.path.relpath(fpath, SRC_DIR).replace(os.sep, '/')
    d = os.path.dirname(rel) if '/' in rel else '.'
    dir_counts[d].append(fpath)

# Build a set of modules — prefer dir-level for dirs with 1-2 files,
# file-level for dirs with many files or entry points
module_set = set()
for fpath in files:
    rel = os.path.relpath(fpath, SRC_DIR).replace(os.sep, '/')
    mod = module_name(rel)
    if mod:
        module_set.add(mod)

# If too many modules, collapse file-level back to dir-level
if len(module_set) > MAX_MODULES:
    module_set = set()
    for fpath in files:
        rel = os.path.relpath(fpath, SRC_DIR).replace(os.sep, '/')
        parts = rel.split('/')
        if len(parts) > 1:
            module_set.add(parts[0])
        else:
            module_set.add(os.path.splitext(parts[0])[0])

edges = set()

for fpath in files:
    rel = os.path.relpath(fpath, SRC_DIR).replace(os.sep, '/')
    src_mod = module_name(rel)
    if not src_mod or src_mod not in module_set:
        continue

    try:
        with open(fpath, 'r', errors='replace') as f:
            content = f.read()
    except Exception:
        continue

    for m in import_re.finditer(content):
        spec = m.group(1) or m.group(2) or m.group(3)
        if not spec:
            continue

        if spec.startswith('.'):
            target = resolve_relative(spec, rel, SRC_DIR)
            if target and target in module_set and target != src_mod:
                edges.add((src_mod, target))
        else:
            pkg = external_name(spec)
            if pkg in ext_deps or spec.startswith('@'):
                edges.add((src_mod, 'ext:' + pkg))

if edges:
    for s, d in sorted(edges):
        sys.stdout.write(s + '\t' + d + '\n')
" SRC_DIR="$SRC_DIR" | MAX_ARCH="$MAX_ARCH" bash "$NORMALIZE"