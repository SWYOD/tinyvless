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
sip=""
if [ -n "$host" ]; then
	sip=$(nslookup "$host" 2>/dev/null | grep '^Address' | grep -v ':53' | tail -1 | sed 's/.* //')
fi
export TV_SERVER_IP="${sip:-$host}"
export TV_REDIR_PORT="${REDIR_PORT:-1082}"
export TV_TPROXY_PORT="${TPROXY_PORT:-1083}"
export TV_RU_NFT=/etc/tinyvless/ru_cidr.nft
export TV_BYPASS_SRC   # список src-IP в обход туннеля (из config, опционально)
export TV_BYPASS_MAC   # список src-MAC в обход (устойчиво к смене IP)

/etc/tinyvless/tvroute.sh "$MODE"
# домены из пользовательских списков -> nft-сеты (через dnsmasq nftset)
[ -x /etc/tinyvless/domains.sh ] && /etc/tinyvless/domains.sh >/dev/null 2>&1
