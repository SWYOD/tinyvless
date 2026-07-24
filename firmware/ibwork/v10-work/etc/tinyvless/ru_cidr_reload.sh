#!/bin/sh
# Перезагрузка набора ru_cidr без пересборки цепочек (toggle CIDR в панели).
# Тот же LOCKFILE, что и в tvroute.sh — оба скрипта мутируют одну nft-таблицу ip tinyvless.
# С 2026-07-12 api.sh фонит и этот скрипт, и apply-route.sh (→tvroute.sh) практически
# одновременно (ru_set больше не блокирует HTTP-ответ) — без общего лока их параллельные
# nft-транзакции гонялись по одной таблице и обрывали заливку набора на середине (QA-находка:
# 1396 из 2799 элементов, процесс молча умирал). flock без -w — очередь короткая (обе стороны
# укладываются в секунды-десятки секунд).
LOCKFILE=/tmp/.tv_route.lock
[ "${TV_LOCKED:-0}" = "1" ] || exec env TV_LOCKED=1 flock -x "$LOCKFILE" "$0" "$@"
set -e
CONF=/etc/tinyvless/config
[ -f "$CONF" ] && . "$CONF"

nft list set ip tinyvless ru_cidr >/dev/null 2>&1 || {
	nft add table ip tinyvless 2>/dev/null
	nft add set ip tinyvless ru_cidr '{ type ipv4_addr; flags interval; auto-merge; }' 2>/dev/null
}

if [ "${RU_SET:-1}" != "1" ]; then
	nft flush set ip tinyvless ru_cidr 2>/dev/null
	echo 0 > /etc/tinyvless/ru_cidr_active.meta 2>/dev/null || true
	exit 0
fi

nft flush set ip tinyvless ru_cidr
# Пакетная заливка из compact-файла (add element, таблица уже есть)
awk '
/elements = \{/ {in_el=1; next}
in_el && /\}/ {exit}
in_el {
	gsub(/\t/, " ")
	line = line $0 " "
}
END {
	n = split(line, a, ", ")
	buf = ""
	for (i = 1; i <= n; i++) {
		x = a[i]
		gsub(/^ +| +$/, "", x)
		if (x == "") continue
		if (buf != "") buf = buf ", "
		buf = buf x
		if (i % 80 == 0) {
			print "nft add element ip tinyvless ru_cidr { " buf " }"
			buf = ""
		}
	}
	if (buf != "") print "nft add element ip tinyvless ru_cidr { " buf " }"
}
' /etc/tinyvless/ru_cidr_compact.nft | sh

cnt=$(cat /etc/tinyvless/ru_cidr.meta 2>/dev/null | head -1)
echo "${cnt:-0}" > /etc/tinyvless/ru_cidr_active.meta
