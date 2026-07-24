#!/bin/bash
# V12 MagnumOpusPlus — публичный дистрибутивный релиз поверх V11: все бинари (tinyvless, tvled,
# atcmd), все скрипты/настройки проекта, LAN закреплён на 192.168.10.1. В отличие от личной
# сборки юзера: root-пароль НЕ задан (как vanilla OpenWrt — первый вход через failsafe/passwd),
# WiFi открыт без пароля (public-release-overlay/), VLESS_LINK пуст (заполняется получателем).
set -euo pipefail

IBWORK="$(cd "$(dirname "$0")/.." && pwd)"
V10="$(cd "$(dirname "$0")" && pwd)"
DATE="${1:-$(date +%Y%m%d)}"
TAG="v12-magnumopusplus-${DATE}"
STAGE="$V10/.staging-files-${TAG}"
SNAP="$V10/snapshot-${TAG}"
OUT="$IBWORK/out"
REL_DIR="$(cd "$IBWORK/../../releases" && pwd)"
REL_BIN="$REL_DIR/lt300-tinyvless-${TAG}.bin"
REL_MAN="$REL_DIR/lt300-tinyvless-${TAG}.manifest"
TV_BIN="$V10/bin/tinyvless-stability-v2-20260709"
TVLED="$V10/bin/tvled"
ATCMD="$IBWORK/../../src/atcmd/atcmd"
PUBLIC_OVERLAY="$V10/public-release-overlay"
IB_NAME="tinyvless-v12-magnumopusplus"

echo "=== MagnumOpusPlus $TAG: snapshot + staging ==="
mkdir -p "$SNAP"
rsync -a --exclude '.staging-files-*' --exclude 'snapshot-*' --exclude 'public-release-overlay' "$V10/" "$SNAP/v10-work/"

echo "=== staging overlay ==="
rm -rf "$STAGE"
mkdir -p "$STAGE"
rsync -a "$IBWORK/files/" "$STAGE/"
rsync -a "$V10/etc/" "$STAGE/etc/"
rsync -a "$V10/www/" "$STAGE/www/"
[ -d "$V10/usr" ] && rsync -a "$V10/usr/" "$STAGE/usr/"

echo "=== public-release overlay (открытый WiFi + пустой VLESS_LINK) ==="
[ -d "$PUBLIC_OVERLAY" ] && rsync -a "$PUBLIC_OVERLAY/" "$STAGE/"

mkdir -p "$STAGE/usr/bin"
cp "$TV_BIN" "$STAGE/usr/bin/tinyvless" && chmod +x "$STAGE/usr/bin/tinyvless"
[ -f "$TVLED" ] && cp "$TVLED" "$STAGE/usr/bin/tvled" && chmod +x "$STAGE/usr/bin/tvled"
[ -f "$ATCMD" ] && cp "$ATCMD" "$STAGE/usr/bin/atcmd" && chmod +x "$STAGE/usr/bin/atcmd"

find "$STAGE/etc/tinyvless" -name '*.sh' -exec chmod +x {} \;
find "$STAGE/etc/init.d" -type f -exec chmod +x {} \;
for f in tv backup sms; do [ -f "$STAGE/www/cgi-bin/$f" ] && chmod +x "$STAGE/www/cgi-bin/$f"; done
find "$STAGE/etc/uci-defaults" -type f -exec chmod +x {} \; 2>/dev/null
[ -d "$STAGE/etc/hotplug.d" ] && find "$STAGE/etc/hotplug.d" -type f -exec chmod +x {} \;
[ -f "$STAGE/etc/rc.local" ] && chmod +x "$STAGE/etc/rc.local"

rm -f "$STAGE/etc/tinyvless/ru_cidr.nft"

cat > "$SNAP/BUILD-${TAG}.md" <<EOF
# lt300-tinyvless-${TAG} (MagnumOpusPlus V12 — публичный релиз)

- Overlay: \`v10-work/\` + \`public-release-overlay/\` (последний накатывается поверх и
  переопределяет config/добавляет wifi-open uci-defaults — личный исходник v10-work/etc не тронут)
- Все бинари: tinyvless, tvled, atcmd (AT-команды к модему — впервые попадает в образ, раньше
  билд-скрипт его не копировал, из-за чего карточка «Модем» и SMS-страница не работали)
- Отличия от личной сборки юзера (V11):
  - root-пароль НЕ задан (vanilla-поведение OpenWrt — первый вход через passwd/failsafe)
  - WiFi открыт без пароля (SSID CUDY-OWRT-V3, encryption=none, канал 1)
  - LAN закреплён на 192.168.10.1/24 через uci-defaults (постоянно и для личной сборки тоже —
    единственное изменение, которое ушло и в общий v10-work/etc/uci-defaults/98-tinyvless-lan)
  - VLESS_LINK пуст — получатель добавляет свой профиль через панель
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
RC=1
for try in 1 2 3 4; do
  make image FORCE=1 \
    PROFILE=cudy_lt300-v3 \
    FILES=/files \
    EXTRA_IMAGE_NAME=\"${IB_NAME}\" \
    PACKAGES=\"apk-mbedtls base-files ca-bundle dnsmasq-full dropbear firewall4 fstools kmod-gpio-button-hotplug kmod-leds-gpio kmod-mt7603 kmod-nft-offload libc libgcc libustream-mbedtls logd mtd netifd nftables ppp ppp-mod-pppoe swconfig uci uclient-fetch urandom-seed urngd wpad-basic-mbedtls kmod-usb2 kmod-usb-ohci kmod-usb-net-rndis kmod-usb-serial-option luci rpcd-mod-file curl kmod-nft-tproxy kmod-nf-tproxy kmod-nft-nat libcap zlib https-dns-proxy ip-full\" \
    >/out/build-v12-magnumopusplus.log 2>&1
  RC=\$?
  [ \$RC -eq 0 ] && break
  sleep 5
done
set -e
[ \$RC -eq 0 ] || { tail -40 /out/build-v12-magnumopusplus.log; exit \$RC; }
cp -v /build/ib/bin/targets/ramips/mt76x8/*sysupgrade*.bin /out/ 2>/dev/null || true
cp -v /build/ib/bin/targets/ramips/mt76x8/*.manifest /out/ 2>/dev/null || true
"

ART=$(ls -1 "$OUT"/*"${IB_NAME}"*sysupgrade.bin 2>/dev/null | head -1)
[ -n "$ART" ] || ART=$(ls -1 "$OUT"/*sysupgrade.bin 2>/dev/null | head -1)
[ -f "$ART" ] || { echo "no sysupgrade.bin"; exit 1; }

cp -v "$ART" "$REL_BIN"
MAN=$(ls -1 "$OUT"/*"${IB_NAME}"*.manifest 2>/dev/null | head -1)
[ -n "$MAN" ] && cp -v "$MAN" "$REL_MAN"

SHA=$(shasum -a 256 "$REL_BIN" | awk '{print $1}')
echo "$SHA  $(basename "$REL_BIN")" > "$REL_BIN.sha256"
echo "=== OK MagnumOpusPlus V12 ==="
echo "Image: $REL_BIN"
echo "SHA256: $SHA"
