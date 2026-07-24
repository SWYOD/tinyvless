#!/bin/bash
# V11 MagnumOpusPlus — консолидирует QA-фиксы 2026-07-12/13 поверх V10 MagnumOpusPlus.
# Тот же overlay-каталог (v10-work/) — переименование каталога не требуется, версионируется тег.
set -euo pipefail

IBWORK="$(cd "$(dirname "$0")/.." && pwd)"
V10="$(cd "$(dirname "$0")" && pwd)"
DATE="${1:-$(date +%Y%m%d)}"
TAG="v11-magnumopusplus-${DATE}"
STAGE="$V10/.staging-files-${TAG}"
SNAP="$V10/snapshot-${TAG}"
OUT="$IBWORK/out"
REL_DIR="$(cd "$IBWORK/../../releases" && pwd)"
REL_BIN="$REL_DIR/lt300-tinyvless-${TAG}.bin"
REL_MAN="$REL_DIR/lt300-tinyvless-${TAG}.manifest"
TV_BIN="$V10/bin/tinyvless-stability-v2-20260709"
TVLED="$V10/bin/tvled"
ATCMD="$IBWORK/../../src/atcmd/atcmd"
IB_NAME="tinyvless-v11-magnumopusplus"

echo "=== MagnumOpusPlus $TAG: snapshot + staging ==="
mkdir -p "$SNAP"
rsync -a --exclude '.staging-files-*' --exclude 'snapshot-*' "$V10/" "$SNAP/v10-work/"

echo "=== staging overlay ==="
rm -rf "$STAGE"
mkdir -p "$STAGE"
rsync -a "$IBWORK/files/" "$STAGE/"
rsync -a "$V10/etc/" "$STAGE/etc/"
rsync -a "$V10/www/" "$STAGE/www/"
[ -d "$V10/usr" ] && rsync -a "$V10/usr/" "$STAGE/usr/"

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
# lt300-tinyvless-${TAG} (MagnumOpusPlus V11)

- Overlay: \`v10-work/\` (каталог не переименован — версионируется тег сборки, не путь)
- Go-бинарь tinyvless без изменений с V10 (src/tinyvless/main.go не трогали — TLS_CACHE/dialSem
  сознательно оставлены как есть, см. анализ в сессии 2026-07-13)
- Изменения относительно V10 MagnumOpusPlus (20260711):
  - etc/init.d/tinyvless — TINYVLESS_NICE реально читается из microtun.conf (была мёртвая
    настройка в UI, жёстко висел nice -n 10)
  - etc/tinyvless/api.sh — tuning ru_set забэкграунжен, ответ панели 24с блокировки -> ~0.1с
  - etc/tinyvless/ru_cidr_reload.sh — flock на тот же лок, что tvroute.sh (закрыта гонка,
    которую само по себе создало бы предыдущее изменение)
  - etc/tinyvless/dns-watchdog.sh — PID основного сервиса матчится по -redir, не по имени
    процесса (тестовые tinyvless -testlink больше не триггерят ложный respawn/re-apply route)
  - etc/tinyvless/subscription.sh — таймауты 45+45с -> 20+15с, конкретная причина ошибки
    вместо общей фразы
  - www/.../app4.js — testingAll ставит поллинг на паузу (как speedBusy), 1.5с между тестами
    профилей подряд
  - www/.../dev.js — карточка «Роадмап»: USB-модем hotplug зафиксирован как отложенный до
    более мощного железа (LT300: /overlay 3.7МБ свободно, QMI/MBIM не влезает)
  - www/tinyvless/index.html — cache-bust версия app4.js
- Все пункты выше живо проверены на роутере в течение сессии (mutate/verify/revert,
  подтверждено что основной туннель не прерывался).
- Defaults без изменений: SELECT_LEVEL=low, RU_SET=1, UDP_TUNNEL=selective
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
    >/out/build-v11-magnumopusplus.log 2>&1
  RC=\$?
  [ \$RC -eq 0 ] && break
  sleep 5
done
set -e
[ \$RC -eq 0 ] || { tail -40 /out/build-v11-magnumopusplus.log; exit \$RC; }
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
echo "=== OK MagnumOpusPlus V11 ==="
echo "Image: $REL_BIN"
echo "SHA256: $SHA"
