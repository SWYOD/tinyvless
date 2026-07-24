#!/bin/sh
# tvroute.sh — селективный роутинг для tinyvless.
#   TCP -> REDIRECT на :$REDIR_PORT (nat)         — проверенный путь
#   UDP -> TPROXY   на :$TPROXY_PORT (mangle+mark) — для Discord и пр.
# Режимы: selective (RU/direct-домены напрямую) | full (всё в туннель) | off.
#
# tinyvless должен слушать оба: -redir 0.0.0.0:$REDIR_PORT -tproxy 0.0.0.0:$TPROXY_PORT

# ★ БЛОКИРОВКА (КРИТИЧНО): этот скрипт зовётся из НЕСКОЛЬКИХ мест (init start/stop, api.sh mode
# в фоне через setsid, api.sh stop) и мутирует ОДНУ nft-таблицу (flush/delete/add цепочек).
# Без сериализации два одновременных вызова (напр. быстрые клики по кнопкам режима) гоняются
# по одной таблице параллельно → уже роняло роутер в OOM/краш (2026-07-07, при собственном
# benchmark-тесте трёх свитчей подряд). flock блокирует ВСЁ тело скрипта — конкурентный вызов
# просто ждёт своей очереди (busybox flock тут без -w, но свитчи и так <1с — очередь короткая).
LOCKFILE=/tmp/.tv_route.lock
[ "$TV_LOCKED" = "1" ] || exec env TV_LOCKED=1 flock -x "$LOCKFILE" "$0" "$@"

MODE="${1:-selective}"
REDIR_PORT="${TV_REDIR_PORT:-1082}"
TPROXY_PORT="${TV_TPROXY_PORT:-1083}"
MARK="${TV_MARK:-1}"
TABLE="${TV_TABLE:-100}"
SERVER_IP="${TV_SERVER_IP:-84.201.132.137}"
RU_NFT="${TV_RU_NFT:-/etc/tinyvless/ru_cidr_compact.nft}"
SELECT_LEVEL="${TV_SELECT_LEVEL:-low}"
UDP_TUNNEL="${TV_UDP_TUNNEL:-full}"

PRIV='{ 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 127.0.0.0/8, 100.64.0.0/10, 169.254.0.0/16, 224.0.0.0/4, 240.0.0.0/4 }'
RU_MARKER=/tmp/.tv_ru_ready

# ---- teardown: сносим ТОЛЬКО хук-цепочки, сохраняя table+наборы (RU ~8600 подсетей) ----
# Это даёт МГНОВЕННЫЙ свитч режима: набор ru_cidr грузится один раз (~25с под нагрузкой),
# а переключение selective/full/off пересобирает лишь лёгкие цепочки.
for ch in pre_tcp pre_udp fwd_quic out_doh zapret_q; do
	nft flush chain ip tinyvless "$ch" 2>/dev/null
	nft delete chain ip tinyvless "$ch" 2>/dev/null
done
ip rule del fwmark $MARK table $TABLE 2>/dev/null
ip route flush table $TABLE 2>/dev/null

# off = проксирование выключено (весь трафик direct), но table+наборы ОСТАВЛЯЕМ загруженными
# для мгновенного возврата в selective/full.
[ "$MODE" = "off" ] && { echo "tvroute: mode=off (proxying disabled, sets kept)"; exit 0; }
# purge = полная очистка (при остановке сервиса) — освобождаем ~2.4МБ RAM набора.
[ "$MODE" = "purge" ] && { nft delete table ip tinyvless 2>/dev/null; rm -f "$RU_MARKER"; echo "tvroute: purged"; exit 0; }

# ---- policy routing для TPROXY (маркированное -> локально) ----
ip rule add fwmark $MARK table $TABLE 2>/dev/null
ip route add local 0.0.0.0/0 dev lo table $TABLE 2>/dev/null

# rp_filter=0 — КРИТИЧНО для tproxy-UDP: иначе ядро дропает ответы транспарентного сокета
sysctl -qw net.ipv4.conf.all.rp_filter=0 2>/dev/null
sysctl -qw net.ipv4.conf.default.rp_filter=0 2>/dev/null
for f in /proc/sys/net/ipv4/conf/*/rp_filter; do echo 0 > "$f" 2>/dev/null; done

# ---- таблица + наборы: RU грузим ТОЛЬКО если ещё не загружен (дорого!) ----
# Маркер без таблицы (OOM/reboot/purge) → stale state, tvroute не создавал table → весь трафик direct.
if [ -f "$RU_MARKER" ] && ! nft list table ip tinyvless >/dev/null 2>&1; then
	rm -f "$RU_MARKER"
fi
# ВАЖНО: проверяем через ФАЙЛ-МАРКЕР (stat, ~0мс), а НЕ `nft list set ru_cidr` — дамп 8600-элементного
# interval-набора на 385МГц даже с редиректом в /dev/null занимает заметное время и был причиной
# "не мгновенного" свитча режима. Маркер снимается только в purge (когда набор реально удаляется).
if [ ! -f "$RU_MARKER" ]; then
	# TV_RU_SET=1 → грузим полную RU-базу (8626 подсетей, ~2.4МБ RAM). TV_RU_SET=0 → пустой набор
	# (RAM~0), RU-роутинг только по доменам из direct_domains — освобождает память под Zapret/nfqws.
	if [ "${TV_RU_SET:-1}" = "1" ] && [ -f "$RU_NFT" ]; then
		nft -f "$RU_NFT"
	else
		nft add table ip tinyvless 2>/dev/null
		nft add set ip tinyvless ru_cidr { type ipv4_addr\; flags interval\; } 2>/dev/null
	fi
	nft add set ip tinyvless direct_domains { type ipv4_addr\; } 2>/dev/null
	nft add set ip tinyvless tunnel_domains { type ipv4_addr\; } 2>/dev/null
	touch "$RU_MARKER"
fi
# zapret_domains создаём ТОЛЬКО когда zapret реально включён (иначе лишний `nft list set`
# дорогая проверка на КАЖДЫЙ apply-route.sh вызов ради никогда не используемого набора).
if [ "${TV_ZAPRET_ENABLE:-0}" = "1" ]; then
	nft list set ip tinyvless zapret_domains >/dev/null 2>&1 || nft add set ip tinyvless zapret_domains { type ipv4_addr\; } 2>/dev/null
fi

# bypass-правила общие для TCP и UDP цепочек ($1 = chain)
# TV_BYPASS_SRC — список src-IP (через пробел), чей трафик НЕ тоннелируется (идёт напрямую).
add_bypass() {
	ch="$1"
	for s in $TV_BYPASS_SRC; do
		nft add rule ip tinyvless "$ch" ip saddr "$s" return
	done
	for m in $TV_BYPASS_MAC; do
		nft add rule ip tinyvless "$ch" ether saddr "$m" return
	done
	nft add rule ip tinyvless "$ch" ip daddr "$SERVER_IP" return
	nft add rule ip tinyvless "$ch" ip daddr $PRIV return
	# домены Zapret покидают туннель (идут напрямую под nfqws) ТОЛЬКО когда zapret ВКЛючён.
	# Если zapret выкл — они идут как обычно (через туннель), иначе шли бы напрямую БЕЗ обхода
	# DPI → блокировка (ровно это ломало YouTube при выключенном zapret).
	[ "${TV_ZAPRET_ENABLE:-0}" = "1" ] && nft add rule ip tinyvless "$ch" ip daddr @zapret_domains return
	if [ "$MODE" = "selective" ]; then
		# tunnel_domains ПЕРЕД ru_cidr: 2ip.ru резолвится в RU-IP внутри ru_cidr → иначе direct.
		if [ "$ch" = "pre_tcp" ]; then
			nft add rule ip tinyvless "$ch" ip daddr @tunnel_domains meta l4proto tcp redirect to :$REDIR_PORT
			nft add rule ip tinyvless "$ch" ip daddr @tunnel_domains return
		elif [ "$ch" = "pre_udp" ]; then
			nft add rule ip tinyvless "$ch" ip daddr @tunnel_domains meta l4proto udp tproxy to :$TPROXY_PORT meta mark set $MARK
			nft add rule ip tinyvless "$ch" ip daddr @tunnel_domains return
		fi
		if [ "${TV_RU_SET:-1}" = "1" ]; then
			nft add rule ip tinyvless "$ch" ip daddr @ru_cidr return
		fi
		nft add rule ip tinyvless "$ch" ip daddr @direct_domains return
		# high: только tunnel_domains в туннель; low: всё остальное — в туннель (ниже).
		[ "$SELECT_LEVEL" = "high" ] && nft add rule ip tinyvless "$ch" return
	fi
}

# ---- DoH через туннель: Yota блокирует IP публичных DoH-резолверов (1.1.1.1/8.8.8.8/9.9.9.9)
# напрямую (обнаружено 2026-07-08 — DNS резолв зарубежных доменов зависал/падал). Точечное
# исключение из общей политики "не тоннелировать трафик роутера": ТОЛЬКО DoH-запрос
# https-dns-proxy к резолверу заворачиваем в туннель (нужен свежий/чистый DNS, вреда от
# occasional-запросов пулу соединений нет — в отличие от общего output-хука).
DOH_IP="${TV_DOH_IP:-1.1.1.1}"
nft add chain ip tinyvless out_doh { type nat hook output priority -100\; } 2>/dev/null
nft add rule ip tinyvless out_doh ip daddr "$DOH_IP" tcp dport 443 redirect to :$REDIR_PORT 2>/dev/null

# ---- TCP: nat prerouting, REDIRECT (только форвардящийся трафик LAN-клиентов) ----
# ВАЖНО: НЕ тоннелируем собственный трафик роутера (нет output-цепочки для всего) —
# иначе фоновые сервисы роутера забивают пул соединений к серверу. Исключение — DoH выше.
nft add chain ip tinyvless pre_tcp { type nat hook prerouting priority -100\; }
nft add rule ip tinyvless pre_tcp iifname "lo" return
nft add rule ip tinyvless pre_tcp meta l4proto != tcp return
add_bypass pre_tcp
if [ "$MODE" != "selective" ] || [ "$SELECT_LEVEL" != "high" ]; then
	nft add rule ip tinyvless pre_tcp meta l4proto tcp redirect to :$REDIR_PORT
fi

# ---- UDP: mangle prerouting, TPROXY (только форвардящийся) ----
nft add chain ip tinyvless pre_udp { type filter hook prerouting priority mangle\; policy accept\; }
nft add rule ip tinyvless pre_udp meta l4proto != udp return
nft add rule ip tinyvless pre_udp udp dport 53 return
# QUIC (UDP 443): НЕ тоннелируем (return, минуем tproxy), а reject-им в forward-цепочке ниже —
# браузер получает ICMP port-unreachable и СРАЗУ падает на TCP (без ожидания таймаута = быстрее YouTube).
# Discord-голос идёт на других UDP-портах и продолжит туннелироваться.
nft add rule ip tinyvless pre_udp udp dport 443 return
add_bypass pre_udp
if [ "$UDP_TUNNEL" = "discord" ]; then
	# Discord voice/media UDP; остальной UDP — direct (экономия RAM/CPU под MacBook).
	nft add rule ip tinyvless pre_udp udp dport { 19294-19344, 50000-65535 } tproxy to :$TPROXY_PORT meta mark set $MARK
else
	nft add rule ip tinyvless pre_udp meta l4proto udp tproxy to :$TPROXY_PORT meta mark set $MARK
fi

# ---- QUIC reject: forward-цепочка (форвардящийся udp:443 → ICMP port-unreachable → быстрый TCP-fallback) ----
nft add chain ip tinyvless fwd_quic { type filter hook forward priority filter\; policy accept\; }
# домены Zapret: их QUIC НЕ реджектим — отдаём nfqws на обход (иначе YouTube-QUIC не пройдёт
# через запрет). УСЛОВНО: набор zapret_domains существует ТОЛЬКО когда zapret включён (см. выше) —
# безусловная ссылка на несуществующий набор уронила бы весь `nft add rule` с ошибкой.
[ "${TV_ZAPRET_ENABLE:-0}" = "1" ] && nft add rule ip tinyvless fwd_quic ip daddr @zapret_domains return
nft add rule ip tinyvless fwd_quic udp dport 443 reject with icmp type port-unreachable

# ---- ZAPRET: очередь nfqws (только forwarded LAN-трафик к @zapret_domains) ----
# БЕЗОПАСНО: (1) mark-исключение nfqws-переинжектнутых пакетов; (2) iifname lan → router-output
# (соединение туннеля к серверу) НЕ попадает; (3) только @zapret_domains → IP сервера исключён.
# Цепочку ставим ТОЛЬКО если zapret включён (иначе пакеты уходили бы в несуществующую очередь).
if [ "${TV_ZAPRET_ENABLE:-0}" = "1" ]; then
	ZQNUM="${TV_ZAPRET_QNUM:-200}"
	ZLAN="${TV_LAN_IF:-br-lan}"
	nft add chain ip tinyvless zapret_q { type filter hook postrouting priority mangle\; policy accept\; }
	nft add rule ip tinyvless zapret_q meta mark and 0x40000000 != 0 return
	nft add rule ip tinyvless zapret_q iifname != "$ZLAN" return
	# `ct original packets 1-9` — очередь ловит ТОЛЬКО первые 9 пакетов соединения (значение
	# по умолчанию из zapret config: NFQWS_TCP/UDP_PKT_OUT=9). Без этого лимита ВЕСЬ трафик
	# (напр. целый YouTube-видеопоток) шёл через nfqws бесконечно — вот что взрывало RAM.
	# nfqws нужен только ClientHello/QUIC Initial, остальные пакеты дальше идут напрямую.
	nft add rule ip tinyvless zapret_q ip daddr @zapret_domains meta l4proto tcp th dport { 80, 443, 2053, 2083, 2087, 2096, 8443 } ct original packets 1-9 queue num $ZQNUM bypass
	nft add rule ip tinyvless zapret_q ip daddr @zapret_domains meta l4proto udp th dport { 443, 19294-19344, 50000-50100 } ct original packets 1-9 queue num $ZQNUM bypass
fi

echo "tvroute: mode=$MODE select=$SELECT_LEVEL ru_set=${TV_RU_SET:-1} udp=$UDP_TUNNEL tcp->redir:$REDIR_PORT udp->tproxy:$TPROXY_PORT quic->reject zapret=${TV_ZAPRET_ENABLE:-0}"
