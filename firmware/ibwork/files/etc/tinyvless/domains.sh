#!/bin/sh
# domains.sh — генерирует в dnsmasq.conf ТРИ секции из конфига и пользовательских списков,
# перезагружает dnsmasq — НО ТОЛЬКО если что-то реально изменилось (см. ниже):
#   tinyvless-resolvers  <- DNS_PRIMARY/DNS_FALLBACK/DOH_MODE из /etc/tinyvless/config
#                           (какой резолвер используется по умолчанию для ВСЕГО)
#   tinyvless-nftset     <- direct/tunnel/zapret_domains.list (трафик — роутинг мимо/в туннель)
#   tinyvless-doh        <- poisoned_domains.list (ТОЛЬКО если DOH_MODE=smart: эти домены
#                           резолвятся строго через DoH-туннель, а не через DNS_PRIMARY/FALLBACK)
# Формат списков: один домен в строке, # — комментарий.

DIR=/etc/tinyvless
CONF=/etc/dnsmasq.conf
TABLE=tinyvless
BEGIN_RES="# BEGIN tinyvless-resolvers"
END_RES="# END tinyvless-resolvers"
BEGIN_SET="# BEGIN tinyvless-nftset"
END_SET="# END tinyvless-nftset"
BEGIN_DOH="# BEGIN tinyvless-doh"
END_DOH="# END tinyvless-doh"

build_nftset() { # $1=файл-список $2=имя-сета
	[ -f "$1" ] || return
	domains=$(grep -vE '^[[:space:]]*#|^[[:space:]]*$' "$1" | tr -d ' \t' | tr '\n' '/' | sed 's#/*$##;s#^/*##')
	[ -n "$domains" ] && echo "nftset=/$domains/ip#$TABLE#$2"
}

build_doh() { # $1=файл-список poisoned_domains.list -> server=/domain/127.0.0.1#5053 построчно
	[ -f "$1" ] || return
	grep -vE '^[[:space:]]*#|^[[:space:]]*$' "$1" | tr -d ' \t' | while read -r d; do
		[ -n "$d" ] && echo "server=/$d/127.0.0.1#5053"
	done
}

touch "$CONF"
# ★ АНТИ-ИЗБЫТОЧНОСТЬ: apply-route.sh зовёт этот скрипт на КАЖДЫЙ свитч режима/тумблер, не
# только при реальном изменении списков доменов. Раньше это означало безусловный restart
# dnsmasq на любой клик в морде — лишний риск (каждый restart = окно уязвимости, как мы
# выяснили на живом OOM-инциденте) и задержка. Теперь сравниваем СТАРЫЕ и НОВЫЕ секции —
# рестартим dnsmasq ТОЛЬКО если что-то реально поменялось.
OLD=$(sed -n "/$BEGIN_RES/,/$END_RES/p; /$BEGIN_SET/,/$END_SET/p; /$BEGIN_DOH/,/$END_DOH/p" "$CONF" 2>/dev/null)

# Дефолты, если config неполный/отсутствует.
ZAPRET_ENABLE=0
DNS_PRIMARY=77.88.8.8
DNS_FALLBACK=77.88.8.1
DOH_MODE=smart
[ -f "$DIR/config" ] && . "$DIR/config" 2>/dev/null

# ★ ГРАБЛИ ЭТОЙ СБОРКИ: `case...esac`, помещённый ВНУТРЬ `$( ... )` вместе с `#` где-либо в
# том же блоке (даже в другой ветке/echo), ломает лексер /bin/sh (bash 3.2 sh-режим, macOS-хост
# сборки) — "syntax error near unexpected token ';;'". Экранирование `#` НЕ помогает (баг на
# уровне поиска парной скобки `$(`, а не quoting). Фикс: считаем case ЗАРАНЕЕ, в обычную
# переменную ВНЕ command substitution, внутрь NEW=$(...) просто echo'им готовую строку.
RESOLVER_LINES=""
if [ "$DOH_MODE" = "full" ]; then
	RESOLVER_LINES="server=127.0.0.1#5053"
else
	[ -n "$DNS_PRIMARY" ] && RESOLVER_LINES="server=$DNS_PRIMARY"
	[ -n "$DNS_FALLBACK" ] && RESOLVER_LINES="$RESOLVER_LINES
server=$DNS_FALLBACK"
fi

NEW=$(
	echo "$BEGIN_RES"
	echo "$RESOLVER_LINES"
	echo "$END_RES"
	echo "$BEGIN_SET"
	build_nftset "$DIR/direct_domains.list" direct_domains
	build_nftset "$DIR/tunnel_domains.list" tunnel_domains
	[ "$ZAPRET_ENABLE" = "1" ] && build_nftset "$DIR/zapret_domains.list" zapret_domains
	echo "$END_SET"
	echo "$BEGIN_DOH"
	[ "$DOH_MODE" = "smart" ] && build_doh "$DIR/poisoned_domains.list"
	echo "$END_DOH"
)

if [ "$OLD" = "$NEW" ]; then
	echo "domains: без изменений, dnsmasq не трогаем"
	exit 0
fi

sed -i "/$BEGIN_RES/,/$END_RES/d; /$BEGIN_SET/,/$END_SET/d; /$BEGIN_DOH/,/$END_DOH/d" "$CONF" 2>/dev/null
echo "$NEW" >> "$CONF"

# сбрасываем сеты (убрать устаревшие IP удалённых доменов) — только когда реально применяем
nft flush set ip $TABLE direct_domains 2>/dev/null
nft flush set ip $TABLE tunnel_domains 2>/dev/null
[ "$ZAPRET_ENABLE" = "1" ] && nft flush set ip $TABLE zapret_domains 2>/dev/null

/etc/init.d/dnsmasq restart >/dev/null 2>&1
echo "domains: изменения применены, dnsmasq перезапущен"
