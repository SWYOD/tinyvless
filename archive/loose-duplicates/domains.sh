#!/bin/sh
# domains.sh — генерирует nftset-директивы dnsmasq из пользовательских списков доменов
# и перезагружает dnsmasq. dnsmasq (full) резолвит эти домены и кладёт их IP в nft-сеты:
#   direct_domains.list  -> set direct_domains  (идут НАПРЯМУЮ, в обход туннеля)
#   tunnel_domains.list   -> set tunnel_domains  (принудительно В ТУННЕЛЬ, приоритет)
# Формат списков: один домен в строке, # — комментарий.

DIR=/etc/tinyvless
CONF=/etc/dnsmasq.conf
TABLE=tinyvless
BEGIN="# BEGIN tinyvless-nftset"
END="# END tinyvless-nftset"

build_line() { # $1=файл-список $2=имя-сета
	[ -f "$1" ] || return
	domains=$(grep -vE '^[[:space:]]*#|^[[:space:]]*$' "$1" | tr -d ' \t' | tr '\n' '/' | sed 's#/*$##;s#^/*##')
	[ -n "$domains" ] && echo "nftset=/$domains/ip#$TABLE#$2"
}

touch "$CONF"
# вырезаем старую секцию
sed -i "/$BEGIN/,/$END/d" "$CONF" 2>/dev/null

# сбрасываем сеты (убрать устаревшие IP удалённых доменов)
nft flush set ip $TABLE direct_domains 2>/dev/null
nft flush set ip $TABLE tunnel_domains 2>/dev/null

{
	echo "$BEGIN"
	build_line "$DIR/direct_domains.list" direct_domains
	build_line "$DIR/tunnel_domains.list" tunnel_domains
	echo "$END"
} >> "$CONF"

/etc/init.d/dnsmasq restart >/dev/null 2>&1
echo "domains: применены списки direct/tunnel, dnsmasq перезапущен"
