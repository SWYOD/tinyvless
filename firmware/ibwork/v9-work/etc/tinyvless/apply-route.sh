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
export TV_ZAPRET_ENABLE="${ZAPRET_ENABLE:-0}"
export TV_ZAPRET_QNUM="${ZAPRET_QNUM:-200}"
export TV_LAN_IF="${LAN_IF:-br-lan}"
export TV_RU_SET="${RU_SET:-1}"
export TV_SELECT_LEVEL="${SELECT_LEVEL:-low}"
export TV_UDP_TUNNEL="${UDP_TUNNEL:-full}"

/etc/tinyvless/tvroute.sh "$MODE"
[ -x /etc/tinyvless/domains.sh ] && /etc/tinyvless/domains.sh >/dev/null 2>&1

if [ "$TV_ZAPRET_ENABLE" = "1" ]; then
	TV_ZAPRET_QNUM="$TV_ZAPRET_QNUM" /opt/zapret/zapret-tv.sh start >/dev/null 2>&1
else
	/opt/zapret/zapret-tv.sh stop >/dev/null 2>&1
fi
