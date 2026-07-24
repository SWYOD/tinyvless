#!/bin/sh
# apply-route.sh <mode> — провязка селективного роутинга (nft/ip rule) для tinyvless.
# Общий код для init.d и api.sh (быстрый свитч режима без рестарта Go-процесса).
# Резолвит IP сервера (исключается из туннеля), экспортит env и зовёт tvroute.sh + domains.sh.
CONF=/etc/tinyvless/config
[ -f "$CONF" ] || exit 1
# shellcheck disable=SC1090
. "$CONF"

MODE="${1:-${MODE:-selective}}"

# извлекаем хост сервера из vless://uuid@HOST:PORT?...
host=$(echo "$VLESS_LINK" | sed -n 's#^vless://[^@]*@\([^:/?]*\).*#\1#p')
# КЭШ IP сервера (/tmp, живёт до ребута): nslookup под нагрузкой на 385МГц может занимать
# 1-5с+ и раньше блокировал КАЖДЫЙ свитч режима ("не мгновенно"). Теперь резолвим блокирующе
# только один раз (нет кэша), дальше — мгновенно из кэша, а свежий IP подтягиваем в ФОНЕ.
CACHE="/tmp/.tv_server_ip.$host"
sip=$(cat "$CACHE" 2>/dev/null)
if [ -z "$sip" ] && [ -n "$host" ]; then
	sip=$(nslookup "$host" 2>/dev/null | grep '^Address' | grep -v ':53' | tail -1 | sed 's/.* //')
	[ -n "$sip" ] && echo "$sip" > "$CACHE"
elif [ -n "$sip" ] && [ -n "$host" ]; then
	# фоновое обновление кэша к следующему разу (не блокирует текущий свитч)
	( sip2=$(nslookup "$host" 2>/dev/null | grep '^Address' | grep -v ':53' | tail -1 | sed 's/.* //'); [ -n "$sip2" ] && echo "$sip2" > "$CACHE" ) &
fi
export TV_SERVER_IP="${sip:-$host}"
export TV_REDIR_PORT="${REDIR_PORT:-1082}"
export TV_TPROXY_PORT="${TPROXY_PORT:-1083}"
export TV_RU_NFT=/etc/tinyvless/ru_cidr.nft
export TV_BYPASS_SRC   # список src-IP в обход туннеля (из config, опционально)
export TV_BYPASS_MAC   # список src-MAC в обход (устойчиво к смене IP)
export TV_ZAPRET_ENABLE="${ZAPRET_ENABLE:-0}"  # 1 = ставить очередь nfqws для @zapret_domains
export TV_ZAPRET_QNUM="${ZAPRET_QNUM:-200}"
export TV_LAN_IF="${LAN_IF:-br-lan}"
export TV_RU_SET="${RU_SET:-1}"  # 0 = не грузить 8626-набор RU (экономия 2.4МБ RAM под zapret)

/etc/tinyvless/tvroute.sh "$MODE"
# домены из пользовательских списков -> nft-сеты (через dnsmasq nftset)
[ -x /etc/tinyvless/domains.sh ] && /etc/tinyvless/domains.sh >/dev/null 2>&1

# Zapret: запускаем/останавливаем демон nfqws в соответствии с флагом (очередь уже настроена в tvroute)
if [ "$TV_ZAPRET_ENABLE" = "1" ]; then
	TV_ZAPRET_QNUM="$TV_ZAPRET_QNUM" /opt/zapret/zapret-tv.sh start >/dev/null 2>&1
else
	/opt/zapret/zapret-tv.sh stop >/dev/null 2>&1
fi
