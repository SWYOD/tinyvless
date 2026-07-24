#!/bin/sh
# tvroute.sh — селективный роутинг для tinyvless.
#   TCP -> REDIRECT на :$REDIR_PORT (nat)         — проверенный путь
#   UDP -> TPROXY   на :$TPROXY_PORT (mangle+mark) — для Discord и пр.
# Режимы: selective (RU/direct-домены напрямую) | full (всё в туннель) | off.
#
# tinyvless должен слушать оба: -redir 0.0.0.0:$REDIR_PORT -tproxy 0.0.0.0:$TPROXY_PORT

MODE="${1:-selective}"
REDIR_PORT="${TV_REDIR_PORT:-1082}"
TPROXY_PORT="${TV_TPROXY_PORT:-1083}"
MARK="${TV_MARK:-1}"
TABLE="${TV_TABLE:-100}"
SERVER_IP="${TV_SERVER_IP:-84.201.132.137}"
RU_NFT="${TV_RU_NFT:-/etc/tinyvless/ru_cidr.nft}"

PRIV='{ 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 127.0.0.0/8, 100.64.0.0/10, 169.254.0.0/16, 224.0.0.0/4, 240.0.0.0/4 }'

# ---- teardown: сносим ТОЛЬКО хук-цепочки, сохраняя table+наборы (RU ~8600 подсетей) ----
# Это даёт МГНОВЕННЫЙ свитч режима: набор ru_cidr грузится один раз (~25с под нагрузкой),
# а переключение selective/full/off пересобирает лишь лёгкие цепочки.
for ch in pre_tcp pre_udp fwd_quic; do
	nft flush chain ip tinyvless "$ch" 2>/dev/null
	nft delete chain ip tinyvless "$ch" 2>/dev/null
done
ip rule del fwmark $MARK table $TABLE 2>/dev/null
ip route flush table $TABLE 2>/dev/null

# off = проксирование выключено (весь трафик direct), но table+наборы ОСТАВЛЯЕМ загруженными
# для мгновенного возврата в selective/full.
[ "$MODE" = "off" ] && { echo "tvroute: mode=off (proxying disabled, sets kept)"; exit 0; }
# purge = полная очистка (при остановке сервиса) — освобождаем ~2.4МБ RAM набора.
[ "$MODE" = "purge" ] && { nft delete table ip tinyvless 2>/dev/null; echo "tvroute: purged"; exit 0; }

# ---- policy routing для TPROXY (маркированное -> локально) ----
ip rule add fwmark $MARK table $TABLE 2>/dev/null
ip route add local 0.0.0.0/0 dev lo table $TABLE 2>/dev/null

# rp_filter=0 — КРИТИЧНО для tproxy-UDP: иначе ядро дропает ответы транспарентного сокета
sysctl -qw net.ipv4.conf.all.rp_filter=0 2>/dev/null
sysctl -qw net.ipv4.conf.default.rp_filter=0 2>/dev/null
for f in /proc/sys/net/ipv4/conf/*/rp_filter; do echo 0 > "$f" 2>/dev/null; done

# ---- таблица + наборы: RU грузим ТОЛЬКО если ещё не загружен (дорого!) ----
if ! nft list set ip tinyvless ru_cidr >/dev/null 2>&1; then
	if [ -f "$RU_NFT" ]; then
		nft -f "$RU_NFT"
	else
		nft add table ip tinyvless
		nft add set ip tinyvless ru_cidr { type ipv4_addr\; flags interval\; }
	fi
fi
nft list table ip tinyvless >/dev/null 2>&1 || nft add table ip tinyvless
nft list set ip tinyvless direct_domains >/dev/null 2>&1 || nft add set ip tinyvless direct_domains { type ipv4_addr\; }
nft list set ip tinyvless tunnel_domains >/dev/null 2>&1 || nft add set ip tinyvless tunnel_domains { type ipv4_addr\; }

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
	if [ "$MODE" = "selective" ]; then
		nft add rule ip tinyvless "$ch" ip daddr @ru_cidr return
		nft add rule ip tinyvless "$ch" ip daddr @direct_domains return
	fi
}

# ---- TCP: nat prerouting, REDIRECT (только форвардящийся трафик LAN-клиентов) ----
# ВАЖНО: НЕ тоннелируем собственный трафик роутера (нет output-цепочки) —
# иначе фоновые сервисы роутера забивают пул соединений к серверу.
nft add chain ip tinyvless pre_tcp { type nat hook prerouting priority -100\; }
nft add rule ip tinyvless pre_tcp iifname "lo" return
nft add rule ip tinyvless pre_tcp meta l4proto != tcp return
add_bypass pre_tcp
nft add rule ip tinyvless pre_tcp meta l4proto tcp redirect to :$REDIR_PORT

# ---- UDP: mangle prerouting, TPROXY (только форвардящийся) ----
nft add chain ip tinyvless pre_udp { type filter hook prerouting priority mangle\; policy accept\; }
nft add rule ip tinyvless pre_udp meta l4proto != udp return
nft add rule ip tinyvless pre_udp udp dport 53 return
# QUIC (UDP 443): НЕ тоннелируем (return, минуем tproxy), а reject-им в forward-цепочке ниже —
# браузер получает ICMP port-unreachable и СРАЗУ падает на TCP (без ожидания таймаута = быстрее YouTube).
# Discord-голос идёт на других UDP-портах и продолжит туннелироваться.
nft add rule ip tinyvless pre_udp udp dport 443 return
add_bypass pre_udp
nft add rule ip tinyvless pre_udp meta l4proto udp tproxy to :$TPROXY_PORT meta mark set $MARK

# ---- QUIC reject: forward-цепочка (форвардящийся udp:443 → ICMP port-unreachable → быстрый TCP-fallback) ----
nft add chain ip tinyvless fwd_quic { type filter hook forward priority filter\; policy accept\; }
nft add rule ip tinyvless fwd_quic udp dport 443 reject with icmp type port-unreachable

echo "tvroute: mode=$MODE tcp->redir:$REDIR_PORT udp->tproxy:$TPROXY_PORT quic->reject"
