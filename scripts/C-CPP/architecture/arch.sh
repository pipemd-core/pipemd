#!/usr/bin/env bash
set -uo pipefail
# Architecture map — C/C++ module dependencies
source "$(dirname "$0")/../lib/limit.sh"

: "${MAX_ARCH:=100}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NORMALIZE="$SCRIPT_DIR/normalize.sh"
[ -f "$NORMALIZE" ] || NORMALIZE="$SCRIPT_DIR/../../Shared/architecture/normalize.sh"

if ! command -v python3 &>/dev/null; then
  echo "python3 is required for C/C++ architecture extraction"
  exit 0
fi

python3 -c "
import os, re, sys
from collections import defaultdict

MAX_MODULES = 40
SKIP_DIRS = {'build', 'cmake-build-debug', 'cmake-build-release', '_deps',
             'third_party', 'external', '.git', '.pipemd', 'CMakeFiles'}

def module_name(rel_path):
    rel_path = rel_path.replace(os.sep, '/')
    parts = rel_path.split('/')
    filename = os.path.splitext(parts[-1])[0] if parts else ''
    dirpath = parts[:-1] if len(parts) > 1 else []

    if not dirpath:
        return filename

    last_dir = dirpath[-1]

    if filename == last_dir:
        return last_dir

    if len(dirpath) >= 2:
        parent = dirpath[-2]
        if parent in ('src', 'lib', 'include', 'app'):
            return last_dir + '/' + filename

    return last_dir + '/' + filename

def collect_cmake_deps():
    deps = {}
    target_sources = {}
    for root, dirs, fnames in os.walk('.'):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS and not d.startswith('.')]
        if 'CMakeLists.txt' in fnames:
            cmake_path = os.path.join(root, 'CMakeLists.txt')
            try:
                with open(cmake_path, 'r', errors='replace') as f:
                    content = f.read()
            except Exception:
                continue

            content = re.sub(r'#.*', '', content)
            content = content.replace('\\\n', ' ')
            content = re.sub(r'\s+', ' ', content)

            for m in re.finditer(r'add_(?:library|executable)\s*\(\s*(\w+)\s+(.*?)(?:\))', content, re.DOTALL):
                target = m.group(1)
                sources_str = m.group(2)
                srcs = []
                for src_m in re.finditer(r'(\S+\.(?:cpp|cc|cxx|c|h|hpp|hh))', sources_str):
                    srcs.append(src_m.group(1))
                if srcs:
                    target_sources[target.lower()] = srcs

            for m in re.finditer(r'target_link_libraries\s*\(\s*(\w+)\s+(.*?)\)', content, re.DOTALL):
                target = m.group(1)
                libs_str = m.group(2)
                libs = []
                for lib_m in re.finditer(r'(\w[\w:]*)', libs_str):
                    lib = lib_m.group(1)
                    if lib in ('PUBLIC', 'PRIVATE', 'INTERFACE', 'REQUIRED'):
                        continue
                    lib_name = lib.split('::')[-1].lower()
                    libs.append(lib_name)
                if libs:
                    deps[target.lower()] = libs

    return deps, target_sources

cmake_deps, cmake_targets = collect_cmake_deps()

include_dirs = ['include', 'inc', 'src', 'lib', '.']
include_path_cache = {}

def find_include_file(inc_path, source_dir):
    key = (inc_path, source_dir)
    if key in include_path_cache:
        return include_path_cache[key]

    for inc_dir in [source_dir] + include_dirs:
        full = os.path.join(inc_dir, inc_path)
        if os.path.isfile(full):
            include_path_cache[key] = full
            return full

    for root, dirs, fnames in os.walk('.'):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS and not d.startswith('.')]
        basename = os.path.basename(inc_path)
        for fn in fnames:
            if fn == basename:
                full = os.path.join(root, fn)
                include_path_cache[key] = full
                return full

    include_path_cache[key] = None
    return None

files = []
for root, dirs, fnames in os.walk('.'):
    dirs[:] = [d for d in sorted(dirs) if d not in SKIP_DIRS and not d.startswith('.')]
    for fn in sorted(fnames):
        if fn.endswith(('.cpp', '.cc', '.cxx', '.c', '.h', '.hpp', '.hxx', '.hh')):
            if '.test.' not in fn and '.spec.' not in fn:
                files.append(os.path.join(root, fn))
    if len(files) >= 300:
        files = files[:300]
        break

if not files:
    sys.exit(0)

module_set = set()
for fpath in files:
    rel = os.path.relpath(fpath, '.').replace(os.sep, '/')
    skip = False
    for sd in SKIP_DIRS:
        if '/' + sd + '/' in '/' + rel or rel.startswith(sd + '/'):
            skip = True
            break
    if skip:
        continue
    mod = module_name(rel)
    if mod:
        module_set.add(mod)

if len(module_set) > MAX_MODULES:
    module_set = set()
    for fpath in files:
        rel = os.path.relpath(fpath, '.').replace(os.sep, '/')
        parts = rel.split('/')
        if len(parts) > 2:
            module_set.add(parts[0] + '/' + parts[1])
        elif len(parts) == 2:
            module_set.add(parts[0] if parts[0] in ('src', 'lib', 'include', 'app') else parts[1].rsplit('.', 1)[0])
        else:
            module_set.add(os.path.splitext(parts[0])[0])

include_re = re.compile(r'^\\s*#\\s*include\\s*\"([^\"]+)\"', re.MULTILINE)

edges = set()

for fpath in files:
    rel = os.path.relpath(fpath, '.').replace(os.sep, '/')
    skip = False
    for sd in SKIP_DIRS:
        if '/' + sd + '/' in '/' + rel or rel.startswith(sd + '/'):
            skip = True
            break
    if skip:
        continue

    src_mod = module_name(rel)
    if not src_mod or src_mod not in module_set:
        continue

    try:
        with open(fpath, 'r', errors='replace') as f:
            content = f.read()
    except Exception:
        continue

    source_dir = os.path.dirname(fpath)

    for m in include_re.finditer(content):
        inc_path = m.group(1)
        found = find_include_file(inc_path, source_dir)
        if found:
            target_rel = os.path.relpath(found, '.').replace(os.sep, '/')
            target_mod = module_name(target_rel)
            if target_mod and target_mod in module_set and target_mod != src_mod:
                edges.add((src_mod, target_mod))
        else:
            inc_dir = os.path.dirname(inc_path)
            if inc_dir and inc_dir != '.':
                target_mod = inc_dir.split('/')[-1]
                if target_mod in module_set and target_mod != src_mod:
                    edges.add((src_mod, target_mod))
            else:
                base = os.path.splitext(os.path.basename(inc_path))[0]
                if base in module_set and base != src_mod:
                    edges.add((src_mod, base))

for target, libs in cmake_deps.items():
    target_mods = []
    if target in cmake_targets:
        for src in cmake_targets[target]:
            src_rel = src.replace(os.sep, '/')
            mod = module_name(src_rel)
            if mod and mod in module_set:
                target_mods.append(mod)
    if not target_mods:
        if target in module_set:
            target_mods = [target]
        else:
            for m in module_set:
                if m.endswith('/' + target) or m == target:
                    target_mods.append(m)
                    break
    for tmod in target_mods:
        for lib in libs:
            if lib in module_set:
                edges.add((tmod, lib))
            elif any(m.endswith('/' + lib) or m == lib for m in module_set):
                for m in module_set:
                    if m.endswith('/' + lib) or m == lib:
                        edges.add((tmod, m))
            else:
                edges.add((tmod, 'ext:' + lib))

for s, d in sorted(edges):
    sys.stdout.write(s + '\\t' + d + '\\n')
" | MAX_ARCH="$MAX_ARCH" bash "$NORMALIZE"