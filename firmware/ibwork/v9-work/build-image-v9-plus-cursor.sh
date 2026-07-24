#!/bin/bash
# Сборка lt300-tinyvless-v9-plus-cursor — v9-work + экономный дефолт тюнинга.
# Не меняет v9-work/etc/tinyvless/config (overlay/роутер) — патч только в staging.
set -euo pipefail

IBWORK="$(cd "$(dirname "$0")/.." && pwd)"
V9="$(cd "$(dirname "$0")" && pwd)"
DATE="${1:-$(date +%Y%m%d)}"
TAG="v9-plus-cursor-${DATE}"
STAGE="$V9/.staging-files-${TAG}"
SNAP="$V9/snapshot-${TAG}"
OUT="$IBWORK/out"
REL_DIR="$(cd "$IBWORK/../../releases" && pwd)"
REL_BIN="$REL_DIR/lt300-tinyvless-${TAG}.bin"
REL_MAN="$REL_DIR/lt300-tinyvless-${TAG}.manifest"
TV_BIN="$V9/bin/tinyvless-stability-v2-20260708"
TVLED="$V9/bin/tvled"
IB_NAME="tinyvless-v9-plus-cursor"

echo "=== $TAG: snapshot + staging ==="
mkdir -p "$SNAP"
rsync -a \
	--exclude '.staging-files-*' \
	--exclude 'snapshot-*' \
	"$V9/" "$SNAP/v9-work/"
cp -a "$IBWORK/files" "$SNAP/files-canonical-ref"

echo "=== staging overlay (files + v9-work) ==="
rm -rf "$STAGE"
mkdir -p "$STAGE"
rsync -a "$IBWORK/files/" "$STAGE/"
rsync -a "$V9/etc/" "$STAGE/etc/"
rsync -a "$V9/www/" "$STAGE/www/"
[ -d "$V9/usr" ] && rsync -a "$V9/usr/" "$STAGE/usr/"

mkdir -p "$STAGE/usr/bin"
[ -f "$TV_BIN" ] || { echo "missing $TV_BIN"; exit 1; }
cp "$TV_BIN" "$STAGE/usr/bin/tinyvless"
chmod +x "$STAGE/usr/bin/tinyvless"
[ -f "$TVLED" ] && cp "$TVLED" "$STAGE/usr/bin/tvled" && chmod +x "$STAGE/usr/bin/tvled"

# macOS/rsync не сохраняет +x — явно для всех скриптов overlay
find "$STAGE/etc/tinyvless" -name '*.sh' -exec chmod +x {} \;
find "$STAGE/etc/init.d" -type f -exec chmod +x {} \;
[ -f "$STAGE/www/cgi-bin/tv" ] && chmod +x "$STAGE/www/cgi-bin/tv"
[ -f "$STAGE/etc/uci-defaults/99-tinyvless-system-tuning" ] && chmod +x "$STAGE/etc/uci-defaults/99-tinyvless-system-tuning"

rm -f "$STAGE/etc/tinyvless/ru_cidr.nft"

# Экономный дефолт тюнинга (только в образе):
# RU CIDR off, Select High, UDP Discord-only
CFG="$STAGE/etc/tinyvless/config"
sed -i.bak \
	-e 's/^RU_SET=.*/RU_SET=0/' \
	-e "s/^SELECT_LEVEL=.*/SELECT_LEVEL='high'/" \
	-e "s/^UDP_TUNNEL=.*/UDP_TUNNEL='discord'/" \
	"$CFG"
rm -f "$CFG.bak"

cat > "$SNAP/BUILD-${TAG}.md" <<EOF
# lt300-tinyvless-${TAG}

- Base: OpenWrt ImageBuilder \`firmware/ibwork/ib\`
- Overlay: \`v9-work/\` (канонический config в репо не менялся)
- tinyvless: stability-v2 (\`$(md5 -q "$TV_BIN" 2>/dev/null || md5sum "$TV_BIN" | awk '{print $1}')\`)
- tvled: included
- ru_cidr: compact file present, **RU_SET=0 by default** (не грузится в RAM)
- **Default tuning:** SELECT_LEVEL=high, RU_SET=0, UDP_TUNNEL=discord
- Built: $(date -u +"%Y-%m-%dT%H:%M:%SZ")
EOF

echo "=== docker ImageBuilder ($TAG) ==="
mkdir -p "$OUT"
docker run --rm \
	-v "$IBWORK/ib:/ib:ro" \
	-v "$STAGE:/files:ro" \
	-v "$OUT:/out" \
	debian:bookworm bash -c "
set -e
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null
apt-get install -y -qq build-essential libncurses-dev zlib1g-dev gawk git \
	gettext libssl-dev xsltproc rsync wget unzip python3 python3-distutils python3-setuptools file zstd >/dev/null
rm -rf /build && mkdir -p /build
cp -a /ib /build/ib
cd /build/ib
export FORCE_UNSAFE_CONFIGURE=1
set +e
for try in 1 2 3 4; do
  make image FORCE=1 \
    PROFILE=cudy_lt300-v3 \
    FILES=/files \
    EXTRA_IMAGE_NAME=\"${IB_NAME}\" \
    PACKAGES=\"apk-mbedtls base-files ca-bundle dnsmasq-full dropbear firewall4 fstools kmod-gpio-button-hotplug kmod-leds-gpio kmod-mt7603 kmod-nft-offload libc libgcc libustream-mbedtls logd mtd netifd nftables ppp ppp-mod-pppoe swconfig uci uclient-fetch urandom-seed urngd wpad-basic-mbedtls kmod-usb2 kmod-usb-ohci kmod-usb-net-rndis kmod-usb-serial-option luci luci-app-attendedsysupgrade rpcd-mod-file curl kmod-nft-tproxy kmod-nf-tproxy kmod-nft-queue kmod-nft-nat libnetfilter-queue1 libnfnetlink0 libmnl0 libcap zlib coreutils-sort coreutils-sleep gzip https-dns-proxy -odhcp6c -odhcpd-ipv6only -sing-box-tiny -sing-box ip-full\" \
    >/out/build-v9-plus-cursor.log 2>&1
  RC=\$?
  [ \$RC -eq 0 ] && break
  echo \"make attempt \$try failed rc=\$RC\"
  sleep 5
done
set -e
[ \$RC -eq 0 ] || { tail -40 /out/build-v9-plus-cursor.log; exit \$RC; }
cp -v /build/ib/bin/targets/ramips/mt76x8/*sysupgrade*.bin /out/ 2>/dev/null || true
cp -v /build/ib/bin/targets/ramips/mt76x8/*.manifest /out/ 2>/dev/null || true
ls -la /build/ib/bin/targets/ramips/mt76x8/
"

ART=$(ls -1 "$OUT"/*"${IB_NAME}"*sysupgrade.bin 2>/dev/null | head -1)
[ -n "$ART" ] || ART=$(ls -1 "$OUT"/*sysupgrade.bin 2>/dev/null | head -1)
[ -f "$ART" ] || { echo "no sysupgrade.bin in $OUT"; exit 1; }

cp -v "$ART" "$REL_BIN"
MAN=$(ls -1 "$OUT"/*"${IB_NAME}"*.manifest 2>/dev/null | head -1)
[ -z "$MAN" ] && MAN=$(ls -1 "$OUT"/*.manifest 2>/dev/null | head -1)
[ -n "$MAN" ] && cp -v "$MAN" "$REL_MAN"

SHA=$(shasum -a 256 "$REL_BIN" | awk '{print $1}')
echo "$SHA  $(basename "$REL_BIN")" > "$REL_BIN.sha256"
echo "=== OK ==="
echo "Image: $REL_BIN"
echo "SHA256: $SHA"
echo "Defaults: RU_SET=0 SELECT_LEVEL=high UDP_TUNNEL=discord"
echo "Snapshot: $SNAP"
echo "Staging (temp): $STAGE"
