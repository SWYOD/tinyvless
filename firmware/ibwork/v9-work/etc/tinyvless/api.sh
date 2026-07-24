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
		run=false; is_running && run=true
		mode=$(sed -n "s/^[[:space:]]*MODE=['\"]\?\([a-z]*\).*/\1/p" "$CONF" 2>/dev/null | head -1)
		[ -n "$mode" ] || mode=selective
		slvl=$(sed -n "s/^[[:space:]]*SELECT_LEVEL=['\"]\?\([a-z]*\)['\"]\?.*/\1/p" "$CONF" 2>/dev/null | head -1)
		[ -n "$slvl" ] || slvl=low
		ru_set=$(sed -n "s/^[[:space:]]*RU_SET=['\"]\?\([0-9]\).*/\1/p" "$CONF" 2>/dev/null | head -1)
		[ -n "$ru_set" ] || ru_set=1
		udpt=$(sed -n "s/^[[:space:]]*UDP_TUNNEL=['\"]\?\([a-z]*\)['\"]\?.*/\1/p" "$CONF" 2>/dev/null | head -1)
		[ -n "$udpt" ] || udpt=full
		ru=$(cat /etc/tinyvless/ru_cidr.meta 2>/dev/null | head -1); [ -n "$ru" ] || ru=0
		[ "$ru_set" = "0" ] && ru=0
		zap=$(sed -n "s/^[[:space:]]*ZAPRET_ENABLE=['\"]\?\([0-9]\).*/\1/p" "$CONF" 2>/dev/null | head -1); [ -n "$zap" ] || zap=0
		nfq=false; pidof nfqws >/dev/null 2>&1 && nfq=true
		dpri=$(sed -n "s/^[[:space:]]*DNS_PRIMARY=['\"]\?\([^'\"]*\)['\"]\?.*/\1/p" "$CONF" 2>/dev/null | head -1)
		[ -n "$dpri" ] || dpri=77.88.8.8
		dfb=$(sed -n "s/^[[:space:]]*DNS_FALLBACK=['\"]\?\([^'\"]*\)['\"]\?.*/\1/p" "$CONF" 2>/dev/null | head -1)
		[ -n "$dfb" ] || dfb=77.88.8.1
		dmode=$(sed -n "s/^[[:space:]]*DOH_MODE=['\"]\?\([a-z]*\)['\"]\?.*/\1/p" "$CONF" 2>/dev/null | head -1)
		[ -n "$dmode" ] || dmode=smart
		pcnt=0
		[ -f /etc/tinyvless/poisoned_domains.list ] && \
			pcnt=$(grep -vE '^[[:space:]]*#|^[[:space:]]*$' /etc/tinyvless/poisoned_domains.list | wc -l | tr -d ' ')
		# ubus system info — RAM/CPU/load/uptime/flash
		mem_t=$(ubus call system info 2>/dev/null | jsonfilter -e '@.memory.total' 2>/dev/null)
		mem_a=$(ubus call system info 2>/dev/null | jsonfilter -e '@.memory.available' 2>/dev/null)
		mem_f=$(ubus call system info 2>/dev/null | jsonfilter -e '@.memory.free' 2>/dev/null)
		up=$(ubus call system info 2>/dev/null | jsonfilter -e '@.uptime' 2>/dev/null)
		l1=$(ubus call system info 2>/dev/null | jsonfilter -e '@.load[0]' 2>/dev/null)
		l5=$(ubus call system info 2>/dev/null | jsonfilter -e '@.load[1]' 2>/dev/null)
		l15=$(ubus call system info 2>/dev/null | jsonfilter -e '@.load[2]' 2>/dev/null)
		fl_u=$(ubus call system info 2>/dev/null | jsonfilter -e '@.root.used' 2>/dev/null)
		fl_t=$(ubus call system info 2>/dev/null | jsonfilter -e '@.root.total' 2>/dev/null)
		fl_pct=0
		[ -n "$fl_u" ] && [ -n "$fl_t" ] && [ "$fl_t" -gt 0 ] && fl_pct=$((fl_u * 100 / fl_t))
		echo "{\"running\":$run,\"autostart\":$(is_autostart),\"mode\":\"$mode\",\"select_level\":\"$slvl\",\"ru_set\":$ru_set,\"udp_tunnel\":\"$udpt\",\"ru_subnets\":$ru,\"zapret\":$zap,\"nfqws\":$nfq,\"dns_primary\":\"$dpri\",\"dns_fallback\":\"$dfb\",\"doh_mode\":\"$dmode\",\"poisoned_count\":$pcnt,\"mem_total\":${mem_t:-0},\"mem_avail\":${mem_a:-0},\"mem_free\":${mem_f:-0},\"load_1\":${l1:-0},\"load_5\":${l5:-0},\"load_15\":${l15:-0},\"uptime\":${up:-0},\"flash_pct\":$fl_pct}"
		;;
	mode)
		# быстрый свитч режима БЕЗ рестарта Go-процесса. В ФОНЕ (setsid &) — раньше это был
		# блокирующий вызов, и под нагрузкой (nslookup + дамп nft-набора) иногда превышал
		# таймаут ubus/rpcd-exec из LuCI → морда показывала "не удалось", хотя свитч всё равно
		# применялся чуть позже. С кэшем IP + маркером набора (см apply-route.sh/tvroute.sh)
		# сам свитч теперь и так быстрый — но фон убирает риск таймаута совсем.
		m="$2"
		case "$m" in selective|full|off) ;; *) echo '{"error":"bad mode"}'; exit 1;; esac
		set_conf MODE "$m"
		setsid sh /etc/tinyvless/apply-route.sh "$m" >/dev/null 2>&1 </dev/null &
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
	poweroff)
		# корректное выключение OpenWrt (не обрыв питания). Ответ JSON до halt.
		/etc/init.d/tinyvless stop >/dev/null 2>&1
		TV_REDIR_PORT= TV_TPROXY_PORT= /etc/tinyvless/tvroute.sh purge >/dev/null 2>&1
		sync
		echo '{"ok":true}'
		( sleep 2; /sbin/poweroff ) >/dev/null 2>&1 &
		;;
	reboot)
		# перезагрузка OpenWrt (не путать с restart = рестарт tinyvless).
		sync
		echo '{"ok":true}'
		( sleep 1; /sbin/reboot ) >/dev/null 2>&1 &
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
	checkdomain)
		# проверка домена на DNS-травлю: основной резолвер vs DoH (см. checkdomain.sh)
		d="$2"
		[ -n "$d" ] || { echo '{"error":"no domain"}'; exit 1; }
		[ -x /etc/tinyvless/checkdomain.sh ] && /etc/tinyvless/checkdomain.sh "$d" || echo '{"error":"checkdomain unavailable"}'
		;;
	dnsapply)
		# применить DNS-настройки из config + poisoned_domains.list (регенерация dnsmasq)
		[ -x /etc/tinyvless/domains.sh ] && /etc/tinyvless/domains.sh >/dev/null 2>&1
		echo '{"ok":true}'
		;;
	zapret)
		# вкл/выкл обхода DPI: пишем флаг + переприменяем роутинг (очередь nfqws + демон).
		case "$2" in on) set_conf ZAPRET_ENABLE 1 ;; off) set_conf ZAPRET_ENABLE 0 ;; *) echo '{"error":"bad"}'; exit 1;; esac
		m=$(sed -n "s/^[[:space:]]*MODE=['\"]\?\([a-z]*\).*/\1/p" "$CONF" 2>/dev/null | head -1)
		setsid sh /etc/tinyvless/apply-route.sh "${m:-selective}" >/dev/null 2>&1 </dev/null &
		echo "{\"zapret\":\"$2\"}"
		;;
	tuning)
		# select_level low|high, ru_set on|off, udp_tunnel full|discord
		key="$2"; val="$3"
		case "$key" in
			select_level)
				case "$val" in low|high) set_conf SELECT_LEVEL "$val" ;; *) echo '{"error":"bad val"}'; exit 1;; esac
				;;
			ru_set)
				case "$val" in on) set_conf RU_SET 1 ;; off) set_conf RU_SET 0 ;; *) echo '{"error":"bad val"}'; exit 1;; esac
				[ -x /etc/tinyvless/ru_cidr_reload.sh ] && /etc/tinyvless/ru_cidr_reload.sh
				;;
			udp_tunnel)
				case "$val" in full|discord) set_conf UDP_TUNNEL "$val" ;; *) echo '{"error":"bad val"}'; exit 1;; esac
				;;
			*) echo '{"error":"bad key"}'; exit 1;;
		esac
		m=$(sed -n "s/^[[:space:]]*MODE=['\"]\?\([a-z]*\).*/\1/p" "$CONF" 2>/dev/null | head -1)
		setsid sh /etc/tinyvless/apply-route.sh "${m:-selective}" >/dev/null 2>&1 </dev/null &
		echo "{\"ok\":true,\"key\":\"$key\",\"val\":\"$val\"}"
		;;
	testlink)
		# валидация ссылки: морда пишет кандидата в /etc/tinyvless/testlink.txt, мы дёргаем
		# одноразовый tinyvless -testlink → он пробует поднять туннель и получить exit-IP.
		# У бинарника СВОЙ внутренний таймаут ~13с (внешний timeout в busybox отсутствует).
		# GODEBUG=asyncpreemptoff=1 — как в основном инстансе (иначе спин на mipsel).
		TL=$(cat /etc/tinyvless/testlink.txt 2>/dev/null)
		if [ -z "$TL" ]; then echo '{"ok":false,"error":"пустая ссылка"}'; exit 0; fi
		OUT=$(GODEBUG=asyncpreemptoff=1 /usr/bin/tinyvless -testlink "$TL" 2>/dev/null | tail -1)
		[ -n "$OUT" ] && echo "$OUT" || echo '{"ok":false,"error":"проверка не дала ответа"}'
		;;
	*)
		echo '{"error":"unknown"}'
		;;
esac
