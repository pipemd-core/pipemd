#!/usr/bin/env bash
set -uo pipefail
# CMake target metadata — executables, libraries, and link dependencies
source "$(dirname "$0")/../lib/limit.sh"

if ! command -v python3 &>/dev/null; then
  echo "python3 is required for CMake parsing"
  exit 0
fi

out=""
tmpfile=$(mktemp)

find . -name "CMakeLists.txt" \
  -not -path "*/build/*" -not -path "*/.git/*" \
  -not -path "*/cmake-build-*/*" -not -path "*/_deps/*" \
  2>/dev/null | head -20 | while IFS= read -r cmake_file; do
  rel="${cmake_file#./}"
  dir="$(dirname "$rel")"
  [ "$dir" = "." ] && dir="(root)"

  PMDFILE="$cmake_file" PMDDIR="$dir" python3 -c '
import sys, re, os

cmake_file = os.environ.get("PMDFILE", "")
dir_label = os.environ.get("PMDDIR", "")

try:
    with open(cmake_file, "r", errors="replace") as f:
        content = f.read()
except Exception:
    sys.exit(0)

content = re.sub(r"#.*", "", content)
content = content.replace("\\\n", " ")
content = re.sub(r"\s+", " ", content)

targets = []
links = []

for m in re.finditer(r"add_executable\s*\(\s*([A-Za-z_]\w*)", content):
    targets.append(f"exe:{m.group(1)}")

for m in re.finditer(r"add_library\s*\(\s*([A-Za-z_]\w*)\s+(STATIC|SHARED|MODULE|OBJECT|INTERFACE)", content):
    targets.append(f"lib:{m.group(1)}({m.group(2)})")

for m in re.finditer(r"target_link_libraries\s*\(\s*([A-Za-z_]\w*)\s+(PUBLIC|PRIVATE|INTERFACE)\s+(.*?)\)", content):
    links.append(f"{m.group(1)} <- {m.group(2)}: {m.group(3).strip()}")

if not targets and not links:
    sys.exit(0)

print(f"[dir] {dir_label}")
for t in targets:
    print(f"  + {t}")
for l in links:
    print(f"  - {l}")
' >> "$tmpfile" 2>/dev/null
done

out=$(cat "$tmpfile")
rm -f "$tmpfile"

if [ -z "$out" ]; then
  echo "No CMake targets found"
  exit 0
fi
limit_output "$out" "$MAX_CMAKE" "$(echo "$out" | head -10 && echo "... and more CMake targets")"