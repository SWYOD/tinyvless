#!/bin/sh
# checkreach.sh <nslookup|ping> <domain> — быстрая проверка доступности домена для карточки
# "Проверка доступности" на морде. Один запрос = один результат, без хранения состояния.
t="$1"
d="$2"

# строгая валидация — domain приходит из веб-формы и идёт в аргументы shell-команд.
# Чисто через case/glob (без echo|grep) — на этом железе (58МБ RAM) лишняя пара процессов
# под нагрузкой туннеля иногда попадает под OOM-killer, и "Killed" ошибочно читался как invalid domain.
case "$d" in
	"") echo '{"error":"bad domain"}'; exit 0 ;;
esac
case "$d" in
	*[!a-zA-Z0-9.-]*) echo '{"error":"bad domain"}'; exit 0 ;;
esac

case "$t" in
	nslookup)
		out=$(nslookup "$d" 2>&1)
		# берём Address ТОЛЬКО сразу после строки Name: — так не путаем адрес резолвера
		# (первая пара Server:/Address: в выводе busybox nslookup) с реальным ответом
		ip=$(printf '%s\n' "$out" | awk '/^Name:/{want=1;next} want && /^Address/{print $2; exit}')
		if [ -n "$ip" ] && [ "$ip" != "$d" ]; then
			echo "{\"domain\":\"$d\",\"type\":\"nslookup\",\"ok\":true,\"detail\":\"$ip\"}"
		else
			echo "{\"domain\":\"$d\",\"type\":\"nslookup\",\"ok\":false,\"detail\":\"не резолвится\"}"
		fi
		;;
	ping)
		out=$(ping -c 2 -W 2 "$d" 2>&1)
		rc=$?
		if [ "$rc" -eq 0 ]; then
			rtt=$(printf '%s\n' "$out" | sed -n "s#.*time=\([0-9.]*\).*#\1ms#p" | tail -1)
			echo "{\"domain\":\"$d\",\"type\":\"ping\",\"ok\":true,\"detail\":\"${rtt:-ok}\"}"
		else
			echo "{\"domain\":\"$d\",\"type\":\"ping\",\"ok\":false,\"detail\":\"нет ответа\"}"
		fi
		;;
	*)
		echo '{"error":"bad type"}'
		;;
esac
