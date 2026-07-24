#!/bin/sh
# reachcheck.sh <ns|ping> <домен-или-IP> — быстрая проверка доступности одним методом.
# Печатает JSON на stdout: {"domain":"...","method":"...","ok":true/false,"detail":"..."}
METHOD="$1"
TARGET="$2"
[ -n "$TARGET" ] || { echo '{"error":"no target"}'; exit 1; }

json_esc() { echo "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

case "$METHOD" in
	ns)
		ip=$(nslookup -type=A "$TARGET" 127.0.0.1 2>/dev/null | awk '/^Address: [0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/{gsub(/:.*/,"",$2); print $2; exit}')
		if [ -n "$ip" ]; then
			echo "{\"domain\":\"$(json_esc "$TARGET")\",\"method\":\"ns\",\"ok\":true,\"detail\":\"$ip\"}"
		else
			echo "{\"domain\":\"$(json_esc "$TARGET")\",\"method\":\"ns\",\"ok\":false,\"detail\":\"не резолвится\"}"
		fi
		;;
	ping)
		out=$(ping -c 2 -W 2 "$TARGET" 2>&1)
		if echo "$out" | grep -qE '[1-9][0-9]* packets received|[1-9][0-9]* received'; then
			rtt=$(echo "$out" | sed -n "s#.*min/avg/max[^=]*= *\([0-9.]*\)/\([0-9.]*\).*#\2мс#p" | head -1)
			echo "{\"domain\":\"$(json_esc "$TARGET")\",\"method\":\"ping\",\"ok\":true,\"detail\":\"${rtt:-отвечает}\"}"
		else
			echo "{\"domain\":\"$(json_esc "$TARGET")\",\"method\":\"ping\",\"ok\":false,\"detail\":\"нет ответа\"}"
		fi
		;;
	*)
		echo '{"error":"bad method"}'
		exit 1
		;;
esac
