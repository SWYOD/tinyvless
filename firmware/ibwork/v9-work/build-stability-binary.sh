#!/bin/sh
# Сборка tinyvless-stability для mipsel (Cudy LT300).
set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"
SRC="$ROOT/../../../src/tinyvless"
OUT="$ROOT/bin"
TAG="tinyvless-stability-20260708"
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

cat > "$OUT/MANIFEST.txt" <<EOF
tinyvless stability build
date: 2026-07-08
tag: $TAG
md5: $MD5
GOOS=linux GOARCH=mipsle GOMIPS=softfloat
dialSem=72 poolBufSize=8192 tlsSessionCache=128 SetMemoryLimit=22MiB
base: src/tinyvless/main.go (stability profile)
rollback: tinyvless.perf.bak on router
EOF

echo "=== done ==="
ls -la "$OUTFILE" "$OUTFILE.md5" "$OUT/MANIFEST.txt"
echo "md5: $MD5"
