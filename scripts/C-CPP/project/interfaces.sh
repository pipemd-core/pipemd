#!/usr/bin/env bash
set -uo pipefail
# C++ interface extraction — pure virtual function signatures
source "$(dirname "$0")/../lib/limit.sh"

if ! command -v python3 &>/dev/null; then
  echo "python3 is required for C++ interface extraction"
  exit 0
fi

HEADERS=$(find . -type f \( -name "*.h" -o -name "*.hpp" -o -name "*.hxx" \) \
  -not -path "*/build/*" -not -path "*/.git/*" -not -path "*/cmake-build-*/*" \
  -not -path "*/_deps/*" -not -path "*/third_party/*" -not -path "*/external/*" \
  2>/dev/null | head -30)

if [ -z "$HEADERS" ]; then
  echo "No C++ headers found"
  exit 0
fi

echo "$HEADERS" | PMDMAX="${MAX_INTERFACE:-15}" python3 -c "
import sys, os, re

MAX = int(os.environ.get('PMDMAX', '15'))

headers = []
for line in sys.stdin:
    line = line.strip()
    if line and os.path.isfile(line):
        headers.append(line)

if not headers:
    print('No C++ headers found')
    sys.exit(0)

iface_blocks = []
class_re = re.compile(r'^\s*(?:class|struct)\s+([A-Za-z_]\w*)\s*(?::\s*(?:public|protected|private)\s+([A-Za-z_]\w*))?\s*\{', re.MULTILINE)
virt_re = re.compile(r'virtual\s+([\w:]+(?:\s*<[^>]+>)?(?:\s*[*&])?)\s+(\w+)\s*\(([^)]*)\)\s*(const)?\s*=\s*0\s*;')

for hdr in headers:
    try:
        with open(hdr, 'r', errors='replace') as f:
            content = f.read()
    except Exception:
        continue

    content = re.sub(r'//.*', '', content)
    content = re.sub(r'/\*.*?\*/', '', content, flags=re.DOTALL)

    pos = 0
    while pos < len(content):
        m = class_re.search(content, pos)
        if not m:
            break
        cls_name = m.group(1)
        start = m.end()
        depth = 1
        end = start
        while end < len(content) and depth > 0:
            if content[end] == '{':
                depth += 1
            elif content[end] == '}':
                depth -= 1
            end += 1

        body = content[start:end]
        found_methods = []
        for vm in virt_re.finditer(body):
            ret_type = vm.group(1).strip()
            method_name = vm.group(2).strip()
            params = vm.group(3).strip()
            is_const = vm.group(4) is not None
            if params:
                params = re.sub(r'\s+', ' ', params)
                param_types = []
                for p in params.split(','):
                    p = p.strip()
                    if p:
                        parts = p.rsplit(None, 1)
                        if len(parts) == 2:
                            param_types.append(parts[0])
                        else:
                            param_types.append(p)
                param_str = ', '.join(param_types)
                suffix = ' const' if is_const else ''
                sig = f'{method_name}({param_str}){suffix} -> {ret_type}'
            else:
                suffix = ' const' if is_const else ''
                sig = f'{method_name}(){suffix} -> {ret_type}'
            found_methods.append(sig)

        if found_methods:
            iface_blocks.append((os.path.basename(hdr), cls_name, found_methods))
        pos = end

if not iface_blocks:
    print('No pure virtual interfaces found')
    sys.exit(0)

count = 0
for hdr, cls, methods in iface_blocks:
    if count >= MAX:
        break
    print(f'[iface] {cls} ({hdr})')
    for m in methods:
        print(f'    {m}')
    count += 1
"