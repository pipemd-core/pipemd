#!/usr/bin/env bash
set -uo pipefail
# Architecture map — Go module dependencies
source "$(dirname "$0")/../lib/limit.sh"

: "${MAX_ARCH:=100}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NORMALIZE="$SCRIPT_DIR/normalize.sh"
[ -f "$NORMALIZE" ] || NORMALIZE="$SCRIPT_DIR/../../Shared/architecture/normalize.sh"

if [ ! -f go.mod ]; then
  echo "No go.mod found"
  exit 0
fi

MODULE=$(awk '/^module /{print $2; exit}' go.mod 2>/dev/null)
if [ -z "$MODULE" ]; then
  echo "Could not parse module path from go.mod"
  exit 0
fi

GO_STDLIB='archive,tar,zip,bufio,builtin,bytes,compress,bzip2,flate,gzip,lzo,zlib,container,heap,list,ring,context,crypto,aes,cipher,des,dsa,ecdsa,ed25519,elliptic,hmac,md5,rand,rc4,rsa,sha256,sha512,subtle,tls,x509,pkix,database,sql,driver,debug,dwarf,elf,macho,pe,plan9obj,buildinfo,dwarf,runtime,encoding,ascii85,asn1,binary,csv,hex,json,jose,gob,base32,base64,pem,xml,errors,expvar,flag,fmt,go,ast,build,constant,doc,format,importer,parser,printer,scanner,token,typecheck,hash,adler32,crc32,crc64,fnv,maphash,html,template,image,color,draw,gif,jpeg,png,font,ccitt,dxt5,gaussian,riff,index,suffixarray,io,ioutil,log,syslog,maps,math,big,cmplx,rand,mime,multipart,quotedprintable,net,http,cgi,cookiejar,fcgi,httputil,pprof,trace,mail,rpc,jsonrpc,smtp,url,text,scanner,tabwriter,template,time,unicode,utf16,utf8,unsafe,os,exec,signal,user,filepath,syscall,unattended,path,reflect,regexp,syntax,runtime,cgo,debug,msan,pprof,race,trace,search,slices,sort,strconv,strings,sync,atomic,map,testing,fstest,iotest,mock,quick,internal'

(
  find . -name "*.go" \
    -not -name "*_test.go" \
    -not -path "*/vendor/*" \
    -not -path "*/.git/*" \
    -not -path "*/.pipemd/*" \
    2>/dev/null | while IFS= read -r gofile; do
    rel="${gofile#./}"
    pkg_dir="$(dirname "$rel")"
    [ "$pkg_dir" = "." ] && pkg_name="main" || pkg_name="$(basename "$pkg_dir")"

    awk -v pkg="$pkg_name" -v module="$MODULE" '
      /^import[[:space:]]*\(/ { in_block=1; next }
      in_block && /^\)[[:space:]]*$/ { in_block=0; next }
      in_block && /"/ {
        match($0, /"[^"]*"/)
        imp = substr($0, RSTART+1, RLENGTH-2)
        if (imp != "") print pkg "\t" imp
      }
      /^import[[:space:]]+"[^"]*"/ {
        match($0, /"[^"]*"/)
        imp = substr($0, RSTART+1, RLENGTH-2)
        if (imp != "") print pkg "\t" imp
      }
    ' "$gofile" 2>/dev/null
  done

) | awk -v module="$MODULE" -v go_stdlib="$GO_STDLIB" '
  BEGIN {
    n = split(go_stdlib, a, ",")
    for (i = 1; i <= n; i++) stdlib[a[i]] = 1
  }
  {
    pkg = $1; imp = $2
    if (imp == "") next
    if (index(imp, module) == 1) {
      rest = substr(imp, length(module) + 1)
      gsub(/^\/+/, "", rest)
      n = split(rest, parts, "/")
      if (n > 0 && parts[1] != "") {
        dep = parts[1]
        if (pkg != dep) print pkg "\t" dep
      }
    } else {
      n = split(imp, parts, "/")
      dep_name = parts[n]
      if (dep_name == "") next
      first = parts[1]
      if (first in stdlib) next
      if (match(dep_name, /\./) || match(imp, /^github\.com/) || match(imp, /^golang\.org/) || match(imp, /^google\.golang\.org/) || match(imp, /^go\.uber\.org/) || match(imp, /^cloud\.google\.com/) || match(imp, /^sigs\.k8s\.io/)) {
        print pkg "\text:" dep_name
      }
    }
  }
' | sort -u | MAX_ARCH="$MAX_ARCH" bash "$NORMALIZE"
