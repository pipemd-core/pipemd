#!/usr/bin/env bash
set -uo pipefail
# Class diagram — Mermaid classDiagram from C++ headers
source "$(dirname "$0")/../lib/limit.sh"

if ! command -v python3 &>/dev/null; then
  echo "python3 is required for C++ class diagram extraction"
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

echo "$HEADERS" | PMDMAX="${MAX_CLASS:-20}" python3 -c "
import sys, os, re

MAX = int(os.environ.get('PMDMAX', '20'))

headers = []
for line in sys.stdin:
    line = line.strip()
    if line and os.path.isfile(line):
        headers.append(line)

if not headers:
    print('No C++ headers found')
    sys.exit(0)

classes = {}

class_re = re.compile(r'^\s*(?:class|struct)\s+([A-Za-z_]\w*)\s*(?::\s*(.*?))?\s*\{', re.MULTILINE)
virt_re  = re.compile(r'^\s*virtual\s+([~]?[\w:&<>, ]+?)\s+\w+\s*\([^)]*\)\s*(?:const)?\s*=\s*0\s*;')
base_re  = re.compile(r'(?:public|protected|private)\s+([A-Za-z_]\w*)')

for hdr in headers:
    try:
        with open(hdr, 'r', errors='replace') as f:
            content = f.read()
    except Exception:
        continue

    content = re.sub(r'//.*', '', content)
    content = re.sub(r'/\*.*?\*/', '', content, flags=re.DOTALL)

    for m in class_re.finditer(content):
        name = m.group(1)
        if name in classes:
            continue
        bases_str = m.group(2) or ''
        bases = [b.strip() for b in base_re.findall(bases_str)]

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

        methods = []
        for vm in virt_re.finditer(body):
            methods.append(vm.group(1).strip() + '()')

        classes[name] = {'bases': bases, 'methods': methods[:5], 'file': os.path.basename(hdr)}

if not classes:
    print('No class/struct definitions found in headers')
    sys.exit(0)

lines = ['classDiagram']
count = 0
for name in sorted(classes.keys(), key=lambda n: (len(classes[n]['bases']), n)):
    info = classes[name]
    if count >= MAX:
        break
    count += 1
    lines.append(f'    class {name} {{')
    for m in info['methods']:
        lines.append(f'        {m}')
    lines.append('    }')
    for base in info['bases']:
        lines.append(f'    {base} <|-- {name}')

print('\n'.join(lines))
"