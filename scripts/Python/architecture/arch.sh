#!/usr/bin/env bash
set -uo pipefail
# Architecture map — Python module dependencies
source "$(dirname "$0")/../lib/limit.sh"

: "${MAX_ARCH:=100}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NORMALIZE="$SCRIPT_DIR/normalize.sh"
[ -f "$NORMALIZE" ] || NORMALIZE="$SCRIPT_DIR/../../Shared/architecture/normalize.sh"

if ! command -v python3 &>/dev/null; then
  echo "python3 is required for Python architecture extraction"
  exit 0
fi

SRC_DIR=""
for dir in src app lib .; do
  if [ -d "$dir" ]; then
    has_py=$(find "$dir" -maxdepth 3 -name "*.py" -not -path "*/__pycache__/*" -print -quit 2>/dev/null)
    if [ -n "$has_py" ]; then
      SRC_DIR="$dir"
      break
    fi
  fi
done
[ -z "$SRC_DIR" ] && { echo "No source directory found"; exit 0; }
SRC_DIR="$(cd "$SRC_DIR" && pwd)"

SRC_DIR_ABS="$SRC_DIR" python3 -c "
import os, re, ast, sys
from collections import defaultdict

SRC_DIR = os.environ.get('SRC_DIR_ABS', 'src')
MAX_MODULES = 80

SKIP_DIRS = {'__pycache__', 'venv', '.venv', '.mypy_cache', '.tox', 'dist', 'build',
             '.eggs', '.pytest_cache', 'node_modules', '.git', '.pipemd', 'migrations',
             '.cache', '.tox', 'site-packages'}

def module_name(rel_path):
    rel_path = rel_path.replace(os.sep, '/')
    parts = rel_path.split('/')
    filename = os.path.splitext(parts[-1])[0] if parts else ''
    dirpath = parts[:-1] if len(parts) > 1 else []

    if filename == '__init__':
        return '/'.join(dirpath) if dirpath else None
    if not dirpath:
        return filename
    return '/'.join(dirpath) + '/' + filename

def collect_pyproject_deps():
    deps = set()
    for pkgfile in ('requirements.txt', 'pyproject.toml', 'Pipfile', 'setup.py', 'setup.cfg'):
        try:
            with open(pkgfile, 'r', errors='replace') as f:
                content = f.read()
        except Exception:
            continue

        if pkgfile == 'requirements.txt':
            for line in content.split('\n'):
                line = line.strip()
                if not line or line.startswith('#') or line.startswith('-'):
                    continue
                name = re.split(r'[<>=!;\[]', line)[0].strip().lower()
                if name:
                    deps.add(name)

        elif pkgfile == 'pyproject.toml':
            m = re.search(r'dependencies\s*=\s*\[(.*?)\]', content, re.DOTALL)
            if m:
                for item in re.findall(r'[\"\'](.*?)[\"\']', m.group(1)):
                    name = re.split(r'[<>=!;\[]', item)[0].strip().lower()
                    if name:
                        deps.add(name)
            m2 = re.search(r'\[project\.dependencies\](.*?)(?=\[|\Z)', content, re.DOTALL)
            if m2:
                for line in m2.group(1).strip().split('\n'):
                    line = line.strip()
                    if line and line[0].isalpha():
                        name = re.split(r'[<>=!;\[]', line)[0].strip().lower()
                        if name:
                            deps.add(name)

        elif pkgfile == 'Pipfile':
            in_packages = False
            for line in content.split('\n'):
                stripped = line.strip()
                if stripped == '[packages]':
                    in_packages = True
                    continue
                if stripped.startswith('['):
                    in_packages = False
                    continue
                if in_packages and stripped and stripped[0].isalpha():
                    name = re.split(r'[=<>#\s]', stripped)[0].strip().lower()
                    if name:
                        deps.add(name)

        elif pkgfile in ('setup.py', 'setup.cfg'):
            for m_pat in re.finditer(r'(?:install_requires|dependencies)\s*=\s*\[(.*?)\]', content, re.DOTALL):
                for item in re.findall(r'[\"\'](.*?)[\"\']', m_pat.group(1)):
                    name = re.split(r'[<>=!;\[]', item)[0].strip().lower()
                    if name:
                        deps.add(name)

    return deps

ext_deps = collect_pyproject_deps()

files = []
for root, dirs, fnames in os.walk(SRC_DIR):
    dirs[:] = [d for d in sorted(dirs) if d not in SKIP_DIRS and not d.startswith('.')]
    for fn in sorted(fnames):
        if fn.endswith('.py') and not fn.startswith('.'):
            files.append(os.path.join(root, fn))
    if len(files) >= 500:
        files = files[:500]
        break

if not files:
    sys.exit(0)

module_set = set()
for fpath in files:
    rel = os.path.relpath(fpath, SRC_DIR).replace(os.sep, '/')
    mod = module_name(rel)
    if mod:
        module_set.add(mod)

if len(module_set) > MAX_MODULES:
    module_set = set()
    for fpath in files:
        rel = os.path.relpath(fpath, SRC_DIR).replace(os.sep, '/')
        mod = module_name(rel)
        if mod:
            parts = mod.split('/')
            module_set.add(parts[0] if len(parts) > 1 else parts[0])

def top_pkg(name):
    return name.split('.')[0].split('/')[0].lower()

def resolve_internal(import_path):
    check = import_path.replace('.', '/')
    for mod in module_set:
        if mod == check or mod.startswith(check + '/'):
            return check.split('/')[0]
    check_dir = os.path.join(SRC_DIR, check)
    if os.path.isdir(check_dir):
        return import_path.split('.')[0].split('/')[0].lower()
    check_file = os.path.join(SRC_DIR, check + '.py')
    if os.path.isfile(check_file):
        return import_path.split('.')[0].split('/')[0].lower()
    return None

edges = set()

for fpath in files:
    rel = os.path.relpath(fpath, SRC_DIR).replace(os.sep, '/')
    src_mod = module_name(rel)
    if not src_mod or src_mod not in module_set:
        continue
    src_short = src_mod.split('/')[0] if '/' in src_mod else src_mod

    try:
        with open(fpath, 'r', errors='replace') as f:
            content = f.read()
    except Exception:
        continue

    try:
        tree = ast.parse(content)
    except SyntaxError:
        for line in content.split('\n'):
            line = line.strip()
            if line.startswith('import ') or line.startswith('from '):
                pass
        continue

    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                pkg = alias.name.split('.')[0].lower()
                if pkg in {m.split('/')[0].split('.')[0] for m in module_set if '/' not in m and '.' not in m} or \
                   pkg in {m.split('/')[0] for m in module_set if '/' in m}:
                    internal = resolve_internal(alias.name)
                    if internal and internal != src_short:
                        edges.add((src_short, internal))
                elif pkg in ext_deps:
                    edges.add((src_short, 'ext:' + pkg))

        if isinstance(node, ast.ImportFrom):
            if node.level and node.level > 0:
                file_dir = os.path.dirname(rel) if '/' in rel else ''
                parts = file_dir.split('/') if file_dir else []
                go_up = node.level - 1
                if go_up > len(parts):
                    go_up = len(parts)
                base_parts = parts[:len(parts) - go_up] if go_up > 0 else list(parts)
                if node.module:
                    base_parts = base_parts + node.module.split('.')
                target = '/'.join(base_parts) if base_parts else file_dir
                if target:
                    target_short = target.split('/')[0] if '/' in target else target
                    if target_short and target_short != src_short:
                        edges.add((src_short, target_short))
            elif node.module:
                top = node.module.split('.')[0].lower()
                if top in {m.split('/')[0].split('.')[0] for m in module_set if '/' not in m and '.' not in m} or \
                   top in {m.split('/')[0] for m in module_set if '/' in m}:
                    internal = resolve_internal(node.module)
                    if internal and internal != src_short:
                        edges.add((src_short, internal))
                elif top in ext_deps:
                    edges.add((src_short, 'ext:' + top))

for s, d in sorted(edges):
    sys.stdout.write(s + '\t' + d + '\n')
" | MAX_ARCH="$MAX_ARCH" bash "$NORMALIZE"