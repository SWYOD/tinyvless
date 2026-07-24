#!/bin/sh
# Сборка tinyvless-stability-v2 для mipsel (Cudy LT300).
set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"
SRC="$ROOT/../../../src/tinyvless"
OUT="$ROOT/bin"
TAG="tinyvless-stability-v2-20260708"
OUTFILE="$OUT/$TAG"

mkdir -p "$OUT"

echo "=== building $TAG ==="
docker run --rm \
  -v "$SRC:/src:ro" \
  -v "$OUT:/out" \
  -w /src \
  golang:1.25-bookworm \
  sh -c 'CGO_ENABLED=0 GOOS=linux GOARCH=mipsle GOMIPS=softfloat go build -ldflags="-s -w" -o /out/'"$TAG"' .'

MD5=$(md5 -q "$OUTFILE" 2>/dev/null || md5sum "$OUTFILE" | awk '{print $1}')
echo "$MD5" > "$OUTFILE.md5"

cat > "$OUT/MANIFEST-v2.txt" <<EOF
tinyvless stability-v2 build
date: 2026-07-08
tag: $TAG
md5: $MD5
GOOS=linux GOARCH=mipsle GOMIPS=softfloat
dialSem=64 poolBufSize=4096 tlsSessionCache=128 SetMemoryLimit=18MiB
overlay: dns-forward-max=50 cachesize=300
prev: tinyvless-stability-20260708 (v1, dialSem=72 pool=8K mem=22M)
rollback router: tinyvless.stability-v1.bak / tinyvless.perf.bak
analysis: STABILITY-V2.md
EOF

# архивная копия
REL="$ROOT/../../../releases/bin"
mkdir -p "$REL"
cp "$OUTFILE" "$OUTFILE.md5" "$OUT/MANIFEST-v2.txt" "$REL/"
mv "$REL/MANIFEST-v2.txt" "$REL/tinyvless-stability-v2-20260708-MANIFEST.txt"

echo "=== done ==="
ls -la "$OUTFILE" "$OUTFILE.md5" "$OUT/MANIFEST-v2.txt"
echo "md5: $MD5"
echo "archived: $REL/"
