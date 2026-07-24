#!/bin/sh
# apply-route.sh <mode> — провязка селективного роутинга (nft/ip rule) для tinyvless.
CONF=/etc/tinyvless/config
[ -f "$CONF" ] || exit 1
# shellcheck disable=SC1090
. "$CONF"

MODE="${1:-${MODE:-selective}}"

host=$(echo "$VLESS_LINK" | sed -n 's#^vless://[^@]*@\([^:/?]*\).*#\1#p')
CACHE="/tmp/.tv_server_ip.$host"
sip=$(cat "$CACHE" 2>/dev/null)
if [ -z "$sip" ] && [ -n "$host" ]; then
	sip=$(nslookup "$host" 2>/dev/null | grep '^Address' | grep -v ':53' | tail -1 | sed 's/.* //')
	[ -n "$sip" ] && echo "$sip" > "$CACHE"
elif [ -n "$sip" ] && [ -n "$host" ]; then
	( sip2=$(nslookup "$host" 2>/dev/null | grep '^Address' | grep -v ':53' | tail -1 | sed 's/.* //'); [ -n "$sip2" ] && echo "$sip2" > "$CACHE" ) &
fi
export TV_SERVER_IP="${sip:-$host}"
export TV_REDIR_PORT="${REDIR_PORT:-1082}"
export TV_TPROXY_PORT="${TPROXY_PORT:-1083}"
export TV_RU_NFT=/etc/tinyvless/ru_cidr_compact.nft
export TV_LAN_IF="${LAN_IF:-br-lan}"
export TV_RU_SET="${RU_SET:-1}"
export TV_SELECT_LEVEL="${SELECT_LEVEL:-low}"
export TV_UDP_TUNNEL="${UDP_TUNNEL:-full}"
# BYPASS_MAC — клиенты без проксирования (MAC через пробел, lower-case). tvroute.sh матчит их
# напрямую по `ether saddr` (L2, в prerouting-хуке на br-lan) — надёжнее резолва MAC->IP через
# dhcp.leases (та резолюция была убрана 2026-07-10: протухала молча при смене DHCP-аренды,
# пока ether-based правило продолжало работать корректно независимо от текущего IP клиента).
_bmac=$(sed -n "s/^[[:space:]]*BYPASS_MAC=['\"]\?\([^'\"]*\)['\"]\?.*/\1/p" "$CONF" 2>/dev/null | head -1 | tr 'A-Z' 'a-z')
export TV_BYPASS_MAC="${_bmac:-}"

/etc/tinyvless/tvroute.sh "$MODE"
[ -x /etc/tinyvless/domains.sh ] && /etc/tinyvless/domains.sh >/dev/null 2>&1
