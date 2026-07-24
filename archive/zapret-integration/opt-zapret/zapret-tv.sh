#!/bin/sh
# zapret-tv.sh {start|stop} — демон nfqws для интеграции с tinyvless.
# БЕЗОПАСНОСТЬ (урок провала #1): очередь nft (в tvroute.sh) ловит ТОЛЬКО forwarded LAN-трафик
# (iifname lan) к @zapret_domains — router-output (туннель к серверу) и IP сервера исключены.
# СТРАТЕГИЯ: Flowseal/zapret-discord-youtube (подобрана под РФ-DPI) — YouTube (max_ru fake),
# Discord (google fake), QUIC. repeats снижены под 385МГц CPU.
ACTION="${1:-start}"
QNUM="${TV_ZAPRET_QNUM:-200}"
NFQWS=/opt/zapret/nfq/nfqws
F=/opt/zapret/files/fake

case "$ACTION" in
stop) killall nfqws 2>/dev/null; exit 0 ;;
esac

killall nfqws 2>/dev/null
modprobe nft_queue 2>/dev/null

# nfqws: разные стратегии по портам (пакеты уже отфильтрованы на nft — только @zapret_domains).
"$NFQWS" --daemon --qnum="$QNUM" \
	--filter-tcp=80,443 --dpi-desync=fake,multisplit --dpi-desync-split-seqovl=664 --dpi-desync-split-pos=1 --dpi-desync-fooling=md5sig --dpi-desync-repeats=6 --dpi-desync-fake-tls="$F/tls_clienthello_max_ru.bin" --new \
	--filter-tcp=2053,2083,2087,2096,8443 --dpi-desync=fake,multisplit --dpi-desync-split-seqovl=681 --dpi-desync-split-pos=1 --dpi-desync-fooling=md5sig --dpi-desync-repeats=6 --dpi-desync-fake-tls="$F/tls_clienthello_www_google_com.bin" --new \
	--filter-udp=443 --dpi-desync=fake --dpi-desync-repeats=6 --dpi-desync-fake-quic="$F/quic_initial_www_google_com.bin" --new \
	--filter-udp=19294-19344,50000-50100 --dpi-desync=fake --dpi-desync-repeats=6 \
	2>/dev/null

sleep 1
pidof nfqws >/dev/null && echo "zapret-tv: nfqws (Flowseal-стратегия) на очереди $QNUM" || echo "zapret-tv: ОШИБКА запуска nfqws"
