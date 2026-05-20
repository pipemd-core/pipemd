#!/usr/bin/env bash
set -uo pipefail
# Architecture map — DevOps service dependencies (Docker Compose, Dockerfiles, Terraform)
source "$(dirname "$0")/../lib/limit.sh"

: "${MAX_ARCH:=100}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NORMALIZE="$SCRIPT_DIR/normalize.sh"
[ -f "$NORMALIZE" ] || NORMALIZE="$SCRIPT_DIR/../../Shared/architecture/normalize.sh"

(
  if [ -f docker-compose.yml ] || [ -f docker-compose.yaml ]; then
    COMPOSE_FILE="docker-compose.yml"
    [ -f docker-compose.yaml ] && COMPOSE_FILE="docker-compose.yaml"

    if command -v python3 &>/dev/null && python3 -c "import yaml" 2>/dev/null; then
      python3 -c "
import sys, yaml, os

compose_file = os.environ.get('COMPOSE_FILE', 'docker-compose.yml')
try:
    with open(compose_file, 'r') as f:
        data = yaml.safe_load(f) or {}
except Exception:
    sys.exit(0)

services = data.get('services', {})
if not services:
    sys.exit(0)

for svc, cfg in services.items():
    if not isinstance(cfg, dict):
        continue
    image = cfg.get('image', '')
    if image:
        img_name = image.split(':')[0].split('/')[-1]
        print(f'{svc}\text:{img_name}')
    depends = cfg.get('depends_on', [])
    if isinstance(depends, list):
        for dep in depends:
            print(f'{svc}\t{dep}')
    elif isinstance(depends, dict):
        for dep in depends:
            print(f'{svc}\t{dep}')
    links = cfg.get('links', [])
    for link in links:
        dep = link.split(':')[0] if ':' in link else link
        print(f'{svc}\t{dep}')
" COMPOSE_FILE="$COMPOSE_FILE" 2>/dev/null
    else
      awk '
        /^[a-zA-Z0-9_-]+:/ && !/^[[:space:]]/ {
          if (in_service && current_svc != "") {
            services[current_svc] = 1
          }
          gsub(/:.*$/, "")
          current_svc = $0
          in_service = 1
          next
        }
        in_service && /^[[:space:]]+depends_on:/ {
          in_depends = 1
          next
        }
        in_service && in_depends && /^[[:space:]]+-[[:space:]]*/ {
          gsub(/^[[:space:]]+-[[:space:]]*/, "")
          gsub(/:.*$/, "")
          if (current_svc != "" && $0 != "") print current_svc "\t" $0
          next
        }
        in_service && /^[[:space:]]+image:/ {
          gsub(/^[[:space:]]+image:[[:space:]]*/, "")
          gsub(/:.*$/, "")
          img = $0
          n = split(img, parts, "/")
          short = parts[n]
          if (current_svc != "" && short != "") print current_svc "\text:" short
          next
        }
        /^[[:space:]]*$/ { in_depends = 0 }
        /^[^[:space:]]/ && !/[a-zA-Z0-9_-]+:/ { in_service = 0 }
        END { if (in_service && current_svc != "") services[current_svc] = 1 }
      ' "$COMPOSE_FILE" 2>/dev/null
    fi
  fi

  find . -name "Dockerfile" -not -path "*/.git/*" -not -path "*/.pipemd/*" 2>/dev/null | while IFS= read -r df; do
    rel="${df#./}"
    context_dir="$(dirname "$rel")"
    [ "$context_dir" = "." ] && stage="main" || stage="$(basename "$context_dir")"

    awk -v stage="$stage" '
      /^FROM[[:space:]]/ {
        img = $2
        asname = ""
        for (i = 3; i <= NF; i++) {
          if ($i == "AS" || $i == "as" || $i == "As") {
            asname = $(i+1)
            break
          }
        }
        gsub(/:.*$/, "", img)
        base = img
        n = split(base, parts, "/")
        short = parts[n]
        printf "%s\text:%s\n", stage, short
        if (asname != "") printf "%s\t%s\n", stage, asname
      }
      /COPY[[:space:]]+--from=/ {
        for (i = 1; i <= NF; i++) {
          if ($i == "--from") {
            src = $(i+1)
            if (src !~ /^[0-9]+$/) {
              printf "%s\t%s\n", stage, src
            }
          }
        }
      }
    ' "$df" 2>/dev/null
  done

  find . -name "*.tf" -not -path "*/.git/*" -not -path "*/.pipemd/*" -not -path "*/.terraform/*" 2>/dev/null | head -30 | while IFS= read -r tf; do
    rel="${tf#./}"
    tf_dir="$(dirname "$rel")"
    [ "$tf_dir" = "." ] && tf_ctx="main" || tf_ctx="$(basename "$tf_dir")"

    awk -v ctx="$tf_ctx" '
      /^module[[:space:]]+"?/ {
        gsub(/^module[[:space:]]+"?/, "")
        gsub(/".*/, "")
        name = $0
        gsub(/[[:space:]]+/, "", name)
        if (name != "") print ctx "\ttf:" name
      }
      /^data[[:space:]]+"?[a-zA-Z]/ {
        gsub(/^data[[:space:]]+"?/, "")
        gsub(/".*/, "")
        dtype = $1
        gsub(/[[:space:]]+/, "", dtype)
        if (dtype != "") print ctx "\ttf:data_" dtype
      }
      /^resource[[:space:]]+"?[a-zA-Z]/ {
        gsub(/^resource[[:space:]]+"?/, "")
        gsub(/".*/, "")
        rtype = $1
        gsub(/[[:space:]]+/, "", rtype)
        if (rtype != "") print ctx "\ttf:" rtype
      }
      /^provider[[:space:]]+"?[a-zA-Z]/ {
        gsub(/^provider[[:space:]]+"?/, "")
        gsub(/".*/, "")
        pname = $0
        gsub(/[[:space:]]+/, "", pname)
        if (pname != "") print ctx "\text:" pname
      }
    ' "$tf" 2>/dev/null
  done

  find . \( -name "*.yaml" -o -name "*.yml" \) -not -name "docker-compose.*" -not -path "*/.git/*" -not -path "*/.pipemd/*" 2>/dev/null | head -10 | while IFS= read -r kf; do
    rel="${kf#./}"
    kf_dir="$(dirname "$rel")"
    [ "$kf_dir" = "." ] && kf_ctx="main" || kf_ctx="$(basename "$kf_dir")"
    kf_base="$(basename "$rel" .yaml)"
    [ "$kf_base" = "$(basename "$rel" .yml)" ] || kf_base="$(basename "$rel" .yml)"

    if echo "$kf_base" | grep -qE '^(deploy|service|ingress|configmap|secret|daemonset|statefulset|deployment|cronjob|job|pod|hpa|pdb|namespace|pv|pvc)$'; then
      awk -v ctx="$kf_ctx" '
        /^[[:space:]]*name:/ {
          gsub(/^[[:space:]]*name:[[:space:]]*/, "")
          gsub(/"/, "")
          gsub(/'"'"'/, "")
          if ($0 != "") print ctx "\tk8s:" $0
        }
        /^[[:space:]]*image:/ {
          gsub(/^[[:space:]]*image:[[:space:]]*/, "")
          gsub(/:.*$/, "")
          n = split($0, parts, "/")
          short = parts[n]
          if (short != "") print ctx "\text:" short
        }
      ' "$kf" 2>/dev/null
    fi
  done

) | sort -u | MAX_ARCH="$MAX_ARCH" bash "$NORMALIZE"