#!/usr/bin/env bash
set -uo pipefail
# Architecture map — Generic module dependencies (ecosystem-agnostic fallback)
source "$(dirname "$0")/../lib/limit.sh"

: "${MAX_ARCH:=100}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NORMALIZE="$SCRIPT_DIR/normalize.sh"
[ -f "$NORMALIZE" ] || NORMALIZE="$SCRIPT_DIR/../../Shared/architecture/normalize.sh"

EXCLUDE_DIRS='node_modules|\.git|\.pipemd|dist|build|coverage|venv|\.venv|__pycache__|target|\.next|\.nuxt|out|bin|obj|\.cache|vendor|bower_components'

SOURCE_EXTS='\.js$|\.ts$|\.jsx$|\.tsx$|\.py$|\.go$|\.rs$|\.c$|\.cpp$|\.cc$|\.cxx$|\.h$|\.hpp$|\.java$|\.rb$|\.php$|\.cs$|\.swift$|\.kt$|\.scala$|\.sh$|\.mjs$|\.cjs$'

PROJECT_ROOT="$(pwd)"

top_modules() {
  local modules=""
  for entry in "$PROJECT_ROOT"/*; do
    [ -e "$entry" ] || continue
    local name
    name=$(basename "$entry")
    echo "$name" | grep -qE "^($EXCLUDE_DIRS)$" && continue
    echo "$name" | grep -qE '^\.' && continue
    if [ -d "$entry" ]; then
      modules="$modules $name"
    fi
  done
  echo "$modules"
}

MODULE_LIST=$(top_modules)

is_internal_dir() {
  local name="$1"
  echo "$MODULE_LIST" | grep -qw "$name"
}

find_source_files() {
  find . -maxdepth 3 -type f -print 2>/dev/null | while IFS= read -r f; do
    echo "$f" | grep -qE "/($EXCLUDE_DIRS)(/|$)" && continue
    echo "$f" | grep -qE "$SOURCE_EXTS" && echo "$f"
  done
}

file_to_module() {
  local filepath="$1"
  local relpath="${filepath#./}"
  local dirpart
  dirpart=$(dirname "$relpath")

  if [ "$dirpart" = "." ]; then
    basename "$relpath" | sed 's/\.[^.]*$//'
    return
  fi

  local topdir
  topdir=$(echo "$dirpart" | cut -d/ -f1)
  if is_internal_dir "$topdir"; then
    echo "$topdir"
  else
    echo "$dirpart" | awk -F/ '{print $NF}'
  fi
}

EXTERNAL_DEPS=""
collect_external_deps() {
  local deps=""

  if [ -f package.json ]; then
    local js_deps
    js_deps=$(python3 -c "
import json, sys
try:
    with open('package.json') as f: pkg = json.load(f)
except: sys.exit(0)
for section in ('dependencies', 'devDependencies', 'peerDependencies'):
    for k in pkg.get(section, {}):
        print(k)
" 2>/dev/null)
    if [ -z "$js_deps" ]; then
      js_deps=$(awk '
        /"dependencies"/{in_deps=1;next}
        /"devDependencies"/{in_deps=1;next}
        /^\s*"[a-zA-Z@]/{
          if(in_deps){
            gsub(/"/,"")
            sub(/:.*/,"")
            if(length>0 && $0 !~ /^dependencies$/ && $0 !~ /^devDependencies$/) print
          }
        }
        /^\s*}/{if(in_deps && depth==0){in_deps=0} else if(in_deps){depth--}}
        /^\s*{/{if(in_deps)depth++}
      ' package.json 2>/dev/null)
    fi
    deps="$deps
$js_deps"
  fi

  if [ -f requirements.txt ]; then
    local py_deps
    py_deps=$(grep -vE '^\s*(#|-r|--index-url|--extra-index-url|--find-links)' requirements.txt 2>/dev/null | sed 's/[<>=!].*//' | sed 's/\[.*//')
    deps="$deps
$py_deps"
  fi

  if [ -f pyproject.toml ]; then
    local pyproj_deps
    pyproj_deps=$(awk '
      /^\[project\.dependencies\]/{in_deps=1;next}
      /^\[/{in_deps=0}
      in_deps && /^[a-zA-Z]/{
        gsub(/#.*/,"")
        gsub(/;.*$/,"")
        gsub(/"/,"")
        sub(/[<=>!].*/,"")
        sub(/\[.*$/,"")
        if(length>0) print tolower($0)
      }
    ' pyproject.toml 2>/dev/null)
    deps="$deps
$pyproj_deps"
  fi

  if [ -f Cargo.toml ]; then
    local cargo_deps
    cargo_deps=$(awk '
      /^\[dependencies\]/{in_deps=1;next}
      /^\[/{in_deps=0}
      in_deps && /^[a-zA-Z0-9_-]/{
        gsub(/#.*/,"")
        sub(/=.*$/,"")
        sub(/\{.*$/,"")
        sub(/".*$/,"")
        if(length>0) print
      }
    ' Cargo.toml 2>/dev/null)
    deps="$deps
$cargo_deps"
  fi

  if [ -f go.mod ]; then
    local go_deps
    go_deps=$(awk '
      /^require \(/{in_deps=1;next}
      /^\)/{in_deps=0}
      in_deps && /^\s+\S+/{
        gsub(/#.*/,"")
        sub(/\/\/.*/,"")
        n=split($0,a,"/")
        print tolower(a[n])
      }
      /^require [^(]/{
        gsub(/#.*/,"")
        sub(/^require /,"")
        sub(/\/\/.*/,"")
        n=split($0,a,"/")
        print tolower(a[n])
      }
    ' go.mod 2>/dev/null)
    deps="$deps
$go_deps"
  fi

  EXTERNAL_DEPS=$(echo "$deps" | sed '/^\s*$/d' | tr '\n' '|' | sed 's/|$//')
}

is_external() {
  local pkg="$1"
  [ -z "$EXTERNAL_DEPS" ] && return 1
  echo "$EXTERNAL_DEPS" | grep -qiE "(^|\|)${pkg}(\||$)"
}

GO_STDLIB='archive,tar,zip,bufio,builtin,bytes,compress,bzip2,flate,gzip,lzo,zlib,container,heap,list,ring,context,crypto,aes,cipher,des,dsa,ecdsa,ed25519,elliptic,hmac,md5,rand,rc4,rsa,sha256,sha512,subtle,tls,x509,pkix,database,sql,driver,debug,dwarf,elf,macho,pe,plan9obj,buildinfo,dwarf,runtime,encoding,ascii85,asn1,binary,csv,hex,json,jose,gob,base32,base64,pem,xml,errors,expvar,flag,fmt,go,ast,build,constant,doc,format,importer,parser,printer,scanner,token,typecheck,hash,adler32,crc32,crc64,fnv,maphash,html,template,image,color,draw,gif,jpeg,png,font,ccitt,dxt5,gaussian,riff,index,suffixarray,io,ioutil,log,syslog,maps,math,big,cmplx,rand,mime,multipart,quotedprintable,net,http,cgi,cookiejar,fcgi,httputil,pprof,trace,mail,rpc,jsonrpc,smtp,url,text,scanner,tabwriter,template,time,unicode,utf16,utf8,unsafe,os,exec,signal,user,filepath,syscall,unattended,path,reflect,regexp,syntax,runtime,cgo,debug,msan,pprof,race,trace,search,slices,sort,strconv,strings,sync,atomic,map,testing,fstest,iotest,mock,quick,internal'

go_is_stdlib() {
  local pkg="$1"
  echo "$GO_STDLIB" | grep -qE "(^|,)"$pkg"(,|$)"
}

extract_and_resolve() {
  local src_module="$1"
  local filepath="$2"
  local ext="${filepath##*.}"

  case "$ext" in
    js|ts|jsx|tsx|mjs|cjs)
      grep -nE '^\s*(import\s+.*\s+from|import\s+"|import\s+'"'"'|require\s*\()' "$filepath" 2>/dev/null | while IFS= read -r line; do
        imp=$(echo "$line" | sed 's/^[0-9]*://' | sed 's/^\s*//')
        local raw_target=""
        if echo "$imp" | grep -qE 'from\s+["'"'"']'; then
          raw_target=$(echo "$imp" | sed -n "s/.*from\s*[\"']//p" | sed "s/[\"'].*//")
        elif echo "$imp" | grep -qE 'import\s+["'"'"']'; then
          raw_target=$(echo "$imp" | sed -n "s/.*import\s*[\"']//p" | sed "s/[\"'].*//")
        elif echo "$imp" | grep -qE 'require\s*\('; then
          raw_target=$(echo "$imp" | sed -n "s/.*require\s*(\s*[\"']//p" | sed "s/[\"'].*//")
        fi
        [ -z "$raw_target" ] && continue
        if echo "$raw_target" | grep -qE '^\.{1,2}/'; then
          local resolved
          resolved=$(echo "$raw_target" | sed 's|^\./||;s|^\.\./||;s|/index$||;s|\.[^.]*$||')
          local topdir
          topdir=$(echo "$resolved" | cut -d/ -f1)
          if is_internal_dir "$topdir"; then
            printf '%s\t%s\n' "$src_module" "$topdir"
          elif [ -n "$resolved" ]; then
            printf '%s\t%s\n' "$src_module" "$(echo "$resolved" | cut -d/ -f1)"
          fi
        else
          local top_pkg
          top_pkg=$(echo "$raw_target" | sed 's|/.*||;s|@.*/||' | sed 's/@$//')
          if [ -n "$top_pkg" ]; then
            if is_internal_dir "$top_pkg"; then
              printf '%s\t%s\n' "$src_module" "$top_pkg"
            elif is_external "$top_pkg"; then
              printf '%s\t%s\n' "$src_module" "ext:$top_pkg"
            fi
          fi
        fi
      done
      ;;

    py)
      grep -nE '^\s*(import\s+[a-zA-Z_]|from\s+[\.a-zA-Z_])' "$filepath" 2>/dev/null | while IFS= read -r line; do
        imp=$(echo "$line" | sed 's/^[0-9]*://' | sed 's/^\s*//')
        if echo "$imp" | grep -qE '^\s*import\s+'; then
          targets=$(echo "$imp" | sed 's/^\s*import\s*//' | sed 's/\s*as\s.*//' | sed 's/,/,/g')
          IFS=',' read -ra parts <<< "$targets"
          for part in "${parts[@]}"; do
            pkg=$(echo "$part" | sed 's/^\s*//;s/\s*$//' | cut -d'.' -f1)
            [ -z "$pkg" ] && continue
            if is_internal_dir "$pkg"; then
              printf '%s\t%s\n' "$src_module" "$pkg"
            elif is_external "$pkg"; then
              printf '%s\t%s\n' "$src_module" "ext:$(echo "$pkg" | tr '[:upper:]' '[:lower:]')"
            fi
          done
          unset IFS
        elif echo "$imp" | grep -qE '^\s*from\s+\.'; then
          dots=$(echo "$imp" | sed 's/^\s*from\s*//' | sed 's/[^.].*//' | tr -d '\n' | wc -c)
          afterdots=$(echo "$imp" | sed 's/^\s*from\s*//' | sed 's/^\.*/ /' | sed 's/^\s*//' | awk '{print $1}')
          if [ -z "$afterdots" ] || [ "$afterdots" = "import" ]; then
            :
          else
            local top_pkg
            top_pkg=$(echo "$afterdots" | cut -d'.' -f1)
            if is_internal_dir "$top_pkg"; then
              printf '%s\t%s\n' "$src_module" "$top_pkg"
            fi
          fi
        elif echo "$imp" | grep -qE '^\s*from\s+[a-zA-Z_]'; then
          from_pkg=$(echo "$imp" | sed 's/^\s*from\s*//' | awk '{print $1}')
          top_pkg=$(echo "$from_pkg" | cut -d'.' -f1)
          [ -z "$top_pkg" ] && continue
          if is_internal_dir "$top_pkg"; then
            printf '%s\t%s\n' "$src_module" "$top_pkg"
          elif is_external "$top_pkg"; then
            printf '%s\t%s\n' "$src_module" "ext:$(echo "$top_pkg" | tr '[:upper:]' '[:lower:]')"
          fi
        fi
      done
      ;;

    go)
      local in_block=0
      grep -nE '^\s*(import\s+"|import\s+\(|use\s+|mod\s+)' "$filepath" 2>/dev/null | while IFS= read -r line; do
        imp=$(echo "$line" | sed 's/^[0-9]*://' | sed 's/^\s*//')
        if echo "$imp" | grep -qE '^\s*import\s+\('; then
          in_block=1
          continue
        fi
        if [ "$in_block" -eq 1 ] && echo "$imp" | grep -qE '^\s*\)'; then
          in_block=0
          continue
        fi
        if [ "$in_block" -eq 1 ]; then
          raw_target=$(echo "$imp" | sed -n 's/.*"\([^"]*\)".*/\1/p')
        elif echo "$imp" | grep -qE '^\s*import\s+"'; then
          raw_target=$(echo "$imp" | sed -n 's/.*import\s*"\([^"]*\)".*/\1/p')
        else
          continue
        fi
        [ -z "$raw_target" ] && continue
        local pkg_base
        pkg_base=$(echo "$raw_target" | awk -F/ '{print $NF}')
        if echo "$raw_target" | grep -qE '^(\.|\.\.|./)'; then
          printf '%s\t%s\n' "$src_module" "$pkg_base"
        elif go_is_stdlib "$pkg_base"; then
          continue
        elif is_external "$pkg_base"; then
          printf '%s\text:%s\n' "$src_module" "$pkg_base"
        elif is_internal_dir "$pkg_base"; then
          printf '%s\t%s\n' "$src_module" "$pkg_base"
        fi
      done
      # Also catch multi-line import blocks that span across grep lines
      awk -v src="$src_module" -v stdlib="$GO_STDLIB" '
        BEGIN { in_block=0 }
        /import[[:space:]]*\(/ { in_block=1; next }
        in_block && /\)/ { in_block=0; next }
        in_block && /"/ {
          match($0, /"[^"]*"/)
          imp = substr($0, RSTART+1, RLENGTH-2)
          if (imp != "") {
            n = split(imp, parts, "/")
            pkg = parts[n]
            is_std = 0
            n2 = split(stdlib, a, ",")
            for (i=1; i<=n2; i++) if (a[i] == pkg) { is_std=1; break }
            if (!is_std) print src "\text:" pkg
          }
        }
        /^import[[:space:]]+"[^"]*"/ {
          match($0, /"[^"]*"/)
          imp = substr($0, RSTART+1, RLENGTH-2)
          if (imp != "") {
            n = split(imp, parts, "/")
            pkg = parts[n]
            is_std = 0
            n2 = split(stdlib, a, ",")
            for (i=1; i<=n2; i++) if (a[i] == pkg) { is_std=1; break }
            if (!is_std) print src "\text:" pkg
          }
        }
      ' "$filepath" 2>/dev/null
      ;;

    rs)
      grep -nE '^\s*(use\s+|mod\s+)' "$filepath" 2>/dev/null | while IFS= read -r line; do
        imp=$(echo "$line" | sed 's/^[0-9]*://' | sed 's/^\s*//')
        if echo "$imp" | grep -qE '^\s*use\s+crate::'; then
          path=$(echo "$imp" | sed 's/^\s*use\s*crate:://' | sed 's/[{;].*//' | sed 's/\s*$//' | sed 's/::.*//')
          [ -z "$path" ] && continue
          if is_internal_dir "$path"; then
            printf '%s\t%s\n' "$src_module" "$path"
          fi
        elif echo "$imp" | grep -qE '^\s*use\s+super::'; then
          : # skip super references in generic mode
        elif echo "$imp" | grep -qE '^\s*use\s+[a-z]'; then
          crate_name=$(echo "$imp" | sed 's/^\s*use\s*//' | sed 's/[{;].*//' | sed 's/\s*$//' | sed 's/::.*//')
          [ -z "$crate_name" ] && continue
          [ "$crate_name" = "crate" ] || [ "$crate_name" = "super" ] || [ "$crate_name" = "self" ] && continue
          if is_external "$crate_name"; then
            printf '%s\text:%s\n' "$src_module" "$crate_name"
          fi
        elif echo "$imp" | grep -qE '^\s*mod\s+'; then
          mod_name=$(echo "$imp" | sed 's/^\s*mod\s*//' | sed 's/[{;].*//' | sed 's/\s*$//')
          [ -z "$mod_name" ] && continue
          if is_internal_dir "$mod_name"; then
            printf '%s\t%s\n' "$src_module" "$mod_name"
          fi
        fi
      done
      ;;

    c|h|cpp|cc|cxx|hpp)
      grep -nE '^\s*#\s*include\s*"' "$filepath" 2>/dev/null | while IFS= read -r line; do
        raw_target=$(echo "$line" | sed -n 's/.*#include\s*"\([^"]*\)".*/\1/p')
        [ -z "$raw_target" ] && continue
        local topdir
        topdir=$(echo "$raw_target" | cut -d/ -f1)
        if [ "$topdir" != "$raw_target" ] && is_internal_dir "$topdir"; then
          printf '%s\t%s\n' "$src_module" "$topdir"
        else
          local base
          base=$(echo "$raw_target" | sed 's/\.[^.]*$//')
          if is_internal_dir "$base"; then
            printf '%s\t%s\n' "$src_module" "$base"
          fi
        fi
      done
      ;;

    java)
      grep -nE '^\s*import\s+' "$filepath" 2>/dev/null | while IFS= read -r line; do
        raw_target=$(echo "$line" | sed 's/.*import\s*//' | sed 's/;.*//' | sed 's/static\s*//')
        [ -z "$raw_target" ] && continue
        local top_pkg
        top_pkg=$(echo "$raw_target" | cut -d'.' -f1)
        if is_internal_dir "$top_pkg"; then
          printf '%s\t%s\n' "$src_module" "$top_pkg"
        elif is_external "$top_pkg"; then
          printf '%s\text:%s\n' "$src_module" "$(echo "$top_pkg" | tr '[:upper:]' '[:lower:]')"
        fi
      done
      ;;

    rb)
      grep -nE '^\s*(require|require_relative|gem)\s' "$filepath" 2>/dev/null | while IFS= read -r line; do
        imp=$(echo "$line" | sed 's/^[0-9]*://' | sed 's/^\s*//')
        if echo "$imp" | grep -qE 'require_relative'; then
          raw_target=$(echo "$imp" | sed "s/.*require_relative\s*//" | sed "s/['\"].*//" | sed 's/^\s*//;s/\s*$//')
          [ -z "$raw_target" ] && continue
          local topdir
          topdir=$(echo "$raw_target" | cut -d/ -f1)
          if is_internal_dir "$topdir"; then
            printf '%s\t%s\n' "$src_module" "$topdir"
          fi
        elif echo "$imp" | grep -qE '^(\s*)require'; then
          raw_target=$(echo "$imp" | sed "s/.*require\s*//" | sed "s/['\"].*//" | sed 's/^\s*//;s/\s*$//')
          [ -z "$raw_target" ] && continue
          local top_pkg
          top_pkg=$(echo "$raw_target" | cut -d'/' -f1 | tr '[:upper:]' '[:lower:]')
          if is_internal_dir "$top_pkg"; then
            printf '%s\t%s\n' "$src_module" "$top_pkg"
          elif is_external "$top_pkg"; then
            printf '%s\text:%s\n' "$src_module" "$top_pkg"
          fi
        fi
      done
      ;;

    php)
      grep -nE '^\s*(use\s+|require_once|include_once|require|include)\s' "$filepath" 2>/dev/null | while IFS= read -r line; do
        imp=$(echo "$line" | sed 's/^[0-9]*://' | sed 's/^\s*//')
        if echo "$imp" | grep -qE '^\s*use\s+'; then
          raw_target=$(echo "$imp" | sed 's/.*use\s*//' | sed 's/;.*//' | sed 's/\s*as\s.*//' | cut -d'\\' -f1)
          [ -z "$raw_target" ] && continue
          local top_pkg
          top_pkg=$(echo "$raw_target" | cut -d'\\' -f1 | tr '[:upper:]' '[:lower:]')
          if is_internal_dir "$top_pkg"; then
            printf '%s\t%s\n' "$src_module" "$top_pkg"
          elif is_external "$top_pkg"; then
            printf '%s\text:%s\n' "$src_module" "$top_pkg"
          fi
        fi
      done
      ;;

    cs)
      grep -nE '^\s*using\s+' "$filepath" 2>/dev/null | while IFS= read -r line; do
        raw_target=$(echo "$line" | sed 's/.*using\s*//' | sed 's/;.*//' | sed 's/\s*=.*//')
        [ -z "$raw_target" ] && continue
        local top_pkg
        top_pkg=$(echo "$raw_target" | cut -d'.' -f1)
        if is_internal_dir "$top_pkg"; then
          printf '%s\t%s\n' "$src_module" "$top_pkg"
        elif is_external "$top_pkg"; then
          printf '%s\text:%s\n' "$src_module" "$(echo "$top_pkg" | tr '[:upper:]' '[:lower:]')"
        fi
      done
      ;;

    swift|kt)
      grep -nE '^\s*import\s+' "$filepath" 2>/dev/null | while IFS= read -r line; do
        raw_target=$(echo "$line" | sed 's/.*import\s*//' | awk '{print $1}')
        [ -z "$raw_target" ] && continue
        if is_internal_dir "$raw_target"; then
          printf '%s\t%s\n' "$src_module" "$raw_target"
        elif is_external "$raw_target"; then
          printf '%s\text:%s\n' "$src_module" "$(echo "$raw_target" | tr '[:upper:]' '[:lower:]')"
        fi
      done
      ;;

    scala)
      grep -nE '^\s*import\s+' "$filepath" 2>/dev/null | while IFS= read -r line; do
        raw_target=$(echo "$line" | sed 's/.*import\s*//' | sed 's/\{.*//')
        [ -z "$raw_target" ] && continue
        local top_pkg
        top_pkg=$(echo "$raw_target" | cut -d'.' -f1)
        if is_internal_dir "$top_pkg"; then
          printf '%s\t%s\n' "$src_module" "$top_pkg"
        elif is_external "$top_pkg"; then
          printf '%s\text:%s\n' "$src_module" "$(echo "$top_pkg" | tr '[:upper:]' '[:lower:]')"
        fi
      done
      ;;

    sh)
      grep -nE '^\s*(source\s+|\.\s+)' "$filepath" 2>/dev/null | while IFS= read -r line; do
        raw_target=$(echo "$line" | sed 's/^[0-9]*://' | sed 's/^\s*//' | sed -e 's/^source\s*//' -e 's/^\.\s*//')
        raw_target=$(echo "$raw_target" | sed 's/^\s*//;s/\s*$//' | sed 's/ .*//')
        [ -z "$raw_target" ] && continue
        local topdir
        topdir=$(echo "$raw_target" | cut -d/ -f1)
        if is_internal_dir "$topdir"; then
          printf '%s\t%s\n' "$src_module" "$topdir"
        fi
      done
      ;;

    *)
      grep -nE '^\s*(import\s+|require\s*\(|#include\s*"|use\s+|from\s+.*import)' "$filepath" 2>/dev/null | while IFS= read -r line; do
        imp=$(echo "$line" | sed 's/^[0-9]*://' | sed 's/^\s*//')
        local raw_target=""
        if echo "$imp" | grep -qE 'from\s+["'"'"']'; then
          raw_target=$(echo "$imp" | sed -n "s/.*from\s*[\"']//p" | sed "s/[\"'].*//")
        elif echo "$imp" | grep -qE 'import\s+["'"'"']'; then
          raw_target=$(echo "$imp" | sed -n "s/.*import\s*[\"']//p" | sed "s/[\"'].*//")
        elif echo "$imp" | grep -qE 'require\s*\('; then
          raw_target=$(echo "$imp" | sed -n "s/.*require\s*(\s*[\"']//p" | sed "s/[\"'].*//")
        elif echo "$imp" | grep -qE '^\s*import\s+[a-zA-Z_]'; then
          raw_target=$(echo "$imp" | sed 's/.*import\s*//' | awk '{print $1}' | cut -d'.' -f1)
        fi
        [ -z "$raw_target" ] && continue
        if echo "$raw_target" | grep -qE '^\.{1,2}/'; then
          local resolved
          resolved=$(echo "$raw_target" | sed 's|^\./||;s|^\.\./||')
          local topdir
          topdir=$(echo "$resolved" | cut -d/ -f1)
          if is_internal_dir "$topdir"; then
            printf '%s\t%s\n' "$src_module" "$topdir"
          fi
        else
          local top_pkg
          top_pkg=$(echo "$raw_target" | sed 's|/.*||;s|@.*/||' | sed 's/@$//')
          if [ -n "$top_pkg" ]; then
            if is_internal_dir "$top_pkg"; then
              printf '%s\t%s\n' "$src_module" "$top_pkg"
            elif is_external "$top_pkg"; then
              printf '%s\text:%s\n' "$src_module" "$top_pkg"
            fi
          fi
        fi
      done
      ;;
  esac
}

directory_heuristic_edges() {
  local dirs=()
  for entry in "$PROJECT_ROOT"/*; do
    [ -d "$entry" ] || continue
    local dname
    dname=$(basename "$entry")
    echo "$dname" | grep -qE "^($EXCLUDE_DIRS)$" && continue
    echo "$dname" | grep -qE '^\.' && continue
    local has_src
    has_src=$(find "$entry" -maxdepth 2 -type f \( -name "*.js" -o -name "*.ts" -o -name "*.py" -o -name "*.go" -o -name "*.rs" -o -name "*.c" -o -name "*.cpp" -o -name "*.java" -o -name "*.rb" -o -name "*.php" -o -name "*.cs" -o -name "*.swift" -o -name "*.kt" \) -print -quit 2>/dev/null)
    [ -z "$has_src" ] && continue
    dirs+=("$dname")
  done

  local n=${#dirs[@]}
  if [ "$n" -lt 2 ]; then
    return
  fi

  for ((i = 0; i < n; i++)); do
    for ((j = i + 1; j < n; j++)); do
      printf '%s\t%s\n' "${dirs[$i]}" "${dirs[$j]}"
    done
  done
}

collect_external_deps

(
  has_edges=0

  while IFS= read -r srcfile; do
    [ -z "$srcfile" ] && continue

    src_module=$(file_to_module "$srcfile")
    [ -z "$src_module" ] && continue

    edges=$(extract_and_resolve "$src_module" "$srcfile")
    [ -z "$edges" ] && continue

    echo "$edges"
    has_edges=1
  done < <(find_source_files)

  if [ "$has_edges" -eq 0 ]; then
    directory_heuristic_edges
  fi

) 2>/dev/null | sort -u | head -"$((MAX_ARCH * 2))" | MAX_ARCH="$MAX_ARCH" bash "$NORMALIZE"