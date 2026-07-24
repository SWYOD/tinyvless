#!/bin/sh
# бэкенд для LuCI-морды tinyvless (v3)
CONF=/etc/tinyvless/config

# set_conf KEY VALUE — идемпотентно проставить KEY='VALUE' в config
set_conf() {
	k="$1"; v="$2"
	[ -f "$CONF" ] || : > "$CONF"
	if grep -q "^[[:space:]]*${k}=" "$CONF"; then
		sed -i "s#^[[:space:]]*${k}=.*#${k}='${v}'#" "$CONF"
	else
		echo "${k}='${v}'" >> "$CONF"
	fi
}

is_running() { wget -q -O - -T 2 'http://127.0.0.1:19999/status' 2>/dev/null | grep -q '"running":true'; }
is_autostart() { ls /etc/rc.d/S*tinyvless >/dev/null 2>&1 && echo true || echo false; }

case "$1" in
	status)
		wget -q -O - -T 3 'http://127.0.0.1:19999/status' 2>/dev/null || echo '{"running":false}'
		;;
	state)
		# сводка для инициализации морды
		run=false; is_running && run=true
		echo "{\"running\":$run,\"autostart\":$(is_autostart)}"
		;;
	mode)
		# быстрый свитч режима БЕЗ рестарта Go-процесса (~4с: перезагрузка RU-набора)
		m="$2"
		case "$m" in selective|full|off) ;; *) echo '{"error":"bad mode"}'; exit 1;; esac
		set_conf MODE "$m"
		/etc/tinyvless/apply-route.sh "$m" >/dev/null 2>&1
		echo '{"ok":true}'
		;;
	restart)
		# полный рестарт (новая активная ссылка) — в фоне, морда поллит /status
		setsid /etc/init.d/tinyvless restart >/dev/null 2>&1 </dev/null &
		echo '{"ok":true}'
		;;
	apply) # алиас restart (обратная совместимость)
		setsid /etc/init.d/tinyvless restart >/dev/null 2>&1 </dev/null &
		echo '{"ok":true}'
		;;
	start)
		setsid /etc/init.d/tinyvless start >/dev/null 2>&1 </dev/null &
		echo '{"ok":true}'
		;;
	stop)
		# полное выключение: гасим сервис (stop_service→off) + purge набора (−2.4МБ RAM)
		/etc/init.d/tinyvless stop >/dev/null 2>&1
		TV_REDIR_PORT= TV_TPROXY_PORT= /etc/tinyvless/tvroute.sh purge >/dev/null 2>&1
		echo '{"ok":true}'
		;;
	autostart)
		case "$2" in
			on)  /etc/init.d/tinyvless enable  >/dev/null 2>&1; echo "{\"autostart\":true}" ;;
			off) /etc/init.d/tinyvless disable >/dev/null 2>&1; echo "{\"autostart\":false}" ;;
			*)   echo "{\"autostart\":$(is_autostart)}" ;;
		esac
		;;
	domains)
		[ -x /etc/tinyvless/domains.sh ] && /etc/tinyvless/domains.sh >/dev/null 2>&1
		echo '{"ok":true}'
		;;
	*)
		echo '{"error":"unknown"}'
		;;
esac
