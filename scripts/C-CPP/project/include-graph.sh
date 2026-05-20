#!/usr/bin/env bash
set -uo pipefail
# Include graph — external and standard library header dependencies
source "$(dirname "$0")/../lib/limit.sh"

if ! command -v python3 &>/dev/null; then
  echo "python3 is required for C++ include graph extraction"
  exit 0
fi

SOURCES=$(find . -type f \( -name "*.cpp" -o -name "*.cc" -o -name "*.cxx" -o -name "*.h" -o -name "*.hpp" -o -name "*.hxx" \) \
  -not -path "*/build/*" -not -path "*/.git/*" -not -path "*/cmake-build-*/*" \
  -not -path "*/_deps/*" -not -path "*/third_party/*" -not -path "*/external/*" \
  2>/dev/null | head -50)

if [ -z "$SOURCES" ]; then
  echo "No C/C++ source files found"
  exit 0
fi

echo "$SOURCES" | PMDMAX="${MAX_INCLUDE:-20}" python3 -c "
import sys, os, re
from collections import defaultdict

MAX = int(os.environ.get('PMDMAX', '20'))

STANDARD_HEADERS = {
    'algorithm', 'array', 'atomic', 'bitset', 'cassert', 'ccomplex',
    'cctype', 'cerrno', 'cfenv', 'cfloat', 'chrono', 'cinttypes',
    'ciso646', 'climits', 'clocale', 'cmath', 'codecvt', 'compare',
    'complex', 'concepts', 'condition_variable', 'coroutine', 'csetjmp',
    'csignal', 'cstdalign', 'cstdarg', 'cstdbool', 'cstddef', 'cstdint',
    'cstdio', 'cstdlib', 'cstring', 'ctgmath', 'ctime', 'cuchar',
    'cwchar', 'cwctype', 'deque', 'exception', 'execution', 'filesystem',
    'format', 'forward_list', 'fstream', 'functional', 'future',
    'initializer_list', 'iomanip', 'ios', 'iosfwd', 'iostream',
    'istream', 'iterator', 'limits', 'list', 'locale', 'map', 'memory',
    'memory_resource', 'mutex', 'new', 'numbers', 'numeric', 'optional',
    'ostream', 'queue', 'random', 'ranges', 'ratio', 'regex', 'scoped_allocator',
    'set', 'shared_mutex', 'span', 'sstream', 'stack', 'stdexcept',
    'streambuf', 'string', 'string_view', 'syncstream', 'system_error',
    'thread', 'tuple', 'type_traits', 'typeindex', 'typeinfo', 'unordered_map',
    'unordered_set', 'utility', 'valarray', 'variant', 'vector', 'version',
}

KNOWN_LIBS = {'boost', 'gtest', 'gmock', 'fmt', 'spdlog', 'nlohmann', 'openssl', 'curl', 'zlib', 'pthread', 'dlfcn'}

ext_re = re.compile(r'^\s*#\s*include\s*<([^>]+)>', re.MULTILINE)
local_re = re.compile(r'^\s*#\s*include\s*\x22([^\x22]+)\x22', re.MULTILINE)

ext_count = defaultdict(int)
ext_includes = defaultdict(set)
std_count = defaultdict(int)
local_includes = defaultdict(set)

for line in sys.stdin:
    hdr = line.strip()
    if not hdr or not os.path.isfile(hdr):
        continue
    try:
        with open(hdr, 'r', errors='replace') as f:
            content = f.read()
    except Exception:
        continue

    basename = os.path.basename(hdr)

    for m in ext_re.finditer(content):
        header = m.group(1)
        first_part = header.split('/')[0] if '/' in header else header
        if header in STANDARD_HEADERS:
            std_count[header] += 1
        elif first_part in KNOWN_LIBS:
            ext_count[first_part] += 1
            ext_includes[first_part].add(header)
        else:
            ext_count[header] += 1
            ext_includes[header].add(header)

    for m in local_re.finditer(content):
        inc = m.group(1)
        local_includes[basename].add(inc)

lines = []
if std_count:
    lines.append('Standard Library:')
    for h in sorted(std_count, key=lambda x: -std_count[x])[:MAX]:
        lines.append(f'  <{h}> ({std_count[h]} files)')

if ext_count:
    lines.append('')
    lines.append('External Dependencies:')
    for h in sorted(ext_count, key=lambda x: -ext_count[x])[:MAX]:
        headers = ', '.join(sorted(ext_includes[h])[:3])
        if len(ext_includes[h]) > 3:
            headers += f' (+{len(ext_includes[h])-3} more)'
        lines.append(f'  {h} ({ext_count[h]} refs): {headers}')

if local_includes:
    lines.append('')
    lines.append('Internal Includes:')
    sorted_local = sorted(local_includes.items(), key=lambda x: -len(x[1]))[:MAX]
    for f, incs in sorted_local:
        lines.append(f'  {f} -> {len(incs)} headers')

if not std_count and not ext_count and not local_includes:
    print('No includes found')
else:
    print('\n'.join(lines))
"