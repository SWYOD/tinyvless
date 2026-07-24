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

# status_body — тело /status от tinyvless с коротким (2с) TTL-кэшем в /tmp. Панель дёргает
# 'status' и 'state' почти одновременно (см app4.js pollStatus/pollSysinfo), и 'state' для
# is_running раньше делал СВОЙ отдельный wget на тот же localhost-эндпоинт — то есть на каждый
# тик опроса было 2 wget вместо 1. Кэш убирает дубль без потери свежести (2с << 8с интервала).
status_body() {
	_f=/tmp/.tv_status_cache
	_now=$(date +%s)
	if [ -f "$_f" ]; then
		_cts=$(head -1 "$_f" 2>/dev/null)
		if [ -n "$_cts" ] && [ $((_now - _cts)) -lt 2 ] 2>/dev/null; then
			tail -n +2 "$_f"
			return 0
		fi
	fi
	_body=$(wget -q -O - -T 2 'http://127.0.0.1:19999/status' 2>/dev/null)
	if [ -n "$_body" ]; then
		{ echo "$_now"; printf '%s' "$_body"; } > "$_f"
		printf '%s' "$_body"
	fi
}
is_running() { status_body | grep -q '"running":true'; }
is_autostart() { ls /etc/rc.d/S*tinyvless >/dev/null 2>&1 && echo true || echo false; }

cpu_usage_pct() {
	_stat=/tmp/.tv_cpu_stat
	[ -r /proc/stat ] || { echo 0; return; }
	set -- $(grep '^cpu ' /proc/stat)
	shift
	_idle=$4
	_total=0
	for _v in "$@"; do _total=$((_total + _v)); done
	_pct=0
	if [ -f "$_stat" ]; then
		read _pt _pi < "$_stat" 2>/dev/null || _pt=0 _pi=0
		_dt=$((_total - _pt))
		_di=$((_idle - _pi))
		[ "$_dt" -gt 0 ] && _pct=$(( (_dt - _di) * 100 / _dt ))
		[ "$_pct" -gt 100 ] && _pct=100
		[ "$_pct" -lt 0 ] && _pct=0
	fi
	echo "$_total $_idle" > "$_stat"
	echo "$_pct"
}

case "$1" in
	status)
		_b=$(status_body)
		[ -n "$_b" ] && printf '%s' "$_b" || echo '{"running":false}'
		;;
	state)
		run=false; is_running && run=true
		# «медленные» поля (конфиг/poisoned-лист/autostart) реально меняются только когда
		# юзер явно сохраняет настройки в панели — незачем их же 7 sed'ами+grep'ами пересчитывать
		# на КАЖДЫЙ опрос state (панель дёргает его раз в 8с). Кэш на 15с — свежие cpu/mem/uptime
		# при этом всё равно считаются каждый раз ниже, без кэша.
		_scache=/tmp/.tv_state_slow_cache
		_now=$(date +%s)
		_scts=""
		[ -f "$_scache" ] && _scts=$(head -1 "$_scache" 2>/dev/null)
		if [ -n "$_scts" ] && [ $((_now - _scts)) -lt 15 ] 2>/dev/null; then
			_sline=$(sed -n 2p "$_scache" 2>/dev/null)
			_oldifs="$IFS"; IFS='	'
			set -- $_sline
			IFS="$_oldifs"
			mode="$1"; slvl="$2"; ru_set="$3"; udpt="$4"; ru="$5"; dpri="$6"; dfb="$7"; dmode="$8"; pcnt="$9"
			shift 9
			day_up="${1:-0}"; day_down="${2:-0}"; month_up="${3:-0}"; month_down="${4:-0}"
		else
			mode=$(sed -n "s/^[[:space:]]*MODE=['\"]\?\([a-z]*\).*/\1/p" "$CONF" 2>/dev/null | head -1)
			[ -n "$mode" ] || mode=selective
			slvl=$(sed -n "s/^[[:space:]]*SELECT_LEVEL=['\"]\?\([a-z]*\)['\"]\?.*/\1/p" "$CONF" 2>/dev/null | head -1)
			[ -n "$slvl" ] || slvl=low
			ru_set=$(sed -n "s/^[[:space:]]*RU_SET=['\"]\?\([0-9]\).*/\1/p" "$CONF" 2>/dev/null | head -1)
			[ -n "$ru_set" ] || ru_set=1
			udpt=$(sed -n "s/^[[:space:]]*UDP_TUNNEL=['\"]\?\([a-z]*\)['\"]\?.*/\1/p" "$CONF" 2>/dev/null | head -1)
			[ -n "$udpt" ] || udpt=full
			[ "$udpt" = "discord" ] && udpt=selective
			ru=$(cat /etc/tinyvless/ru_cidr.meta 2>/dev/null | head -1); [ -n "$ru" ] || ru=0
			[ "$ru_set" = "0" ] && ru=0
			dpri=$(sed -n "s/^[[:space:]]*DNS_PRIMARY=['\"]\?\([^'\"]*\)['\"]\?.*/\1/p" "$CONF" 2>/dev/null | head -1)
			[ -n "$dpri" ] || dpri=77.88.8.8
			dfb=$(sed -n "s/^[[:space:]]*DNS_FALLBACK=['\"]\?\([^'\"]*\)['\"]\?.*/\1/p" "$CONF" 2>/dev/null | head -1)
			[ -n "$dfb" ] || dfb=77.88.8.1
			dmode=$(sed -n "s/^[[:space:]]*DOH_MODE=['\"]\?\([a-z]*\)['\"]\?.*/\1/p" "$CONF" 2>/dev/null | head -1)
			[ -n "$dmode" ] || dmode=smart
			pcnt=0
			[ -f /etc/tinyvless/poisoned_domains.list ] && \
				pcnt=$(grep -vE '^[[:space:]]*#|^[[:space:]]*$' /etc/tinyvless/poisoned_domains.list | wc -l | tr -d ' ')
			# трафик день/месяц — flash-состояние (dns-watchdog.sh пишет раз в ~10мин) + свежий
			# ещё-не-сброшенный аккумулятор из /tmp (RAM, обновляется watchdog'ом каждые 20с)
			day_up=0; day_down=0; month_up=0; month_down=0
			_tset=/etc/tinyvless/traffic.stat
			_ttmp=/tmp/.tv_traffic_acc
			_today=$(date +%Y-%m-%d); _month=$(date +%Y-%m)
			_od=""; _odu=0; _odd=0; _om=""; _omu=0; _omd=0
			[ -f "$_tset" ] && read _od _odu _odd _om _omu _omd < "$_tset" 2>/dev/null
			[ "$_od" = "$_today" ] || { _odu=0; _odd=0; }
			[ "$_om" = "$_month" ] || { _omu=0; _omd=0; }
			_accu=0; _accd=0
			[ -f "$_ttmp" ] && { read _tu _td _accu _accd < "$_ttmp" 2>/dev/null; }
			day_up=$((_odu + _accu)); day_down=$((_odd + _accd))
			month_up=$((_omu + _accu)); month_down=$((_omd + _accd))
			printf '%s\n%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$_now" "$mode" "$slvl" "$ru_set" "$udpt" "$ru" "$dpri" "$dfb" "$dmode" "$pcnt" "$day_up" "$day_down" "$month_up" "$month_down" > "$_scache"
		fi
		# ubus system info — RAM/CPU/load/uptime/flash. ★ 2026-07-11: было 9 отдельных
		# `ubus call | jsonfilter` (18 форков процессов на КАЖДЫЙ опрос state — панель дёргает
		# его раз в 8с!). Это било по CPU одного ядра 385МГц и, судя по OOM-логу (tinyvless
		# убит kernel OOM во время YouTube-теста, ровно когда панель была открыта), вносило
		# заметный вклад в исчерпание ресурсов. Теперь: ОДИН ubus-вызов + ОДИН jsonfilter
		# с несколькими -e (печатает построчно в заданном порядке) — 2 форка вместо 18.
		_si=$(ubus call system info 2>/dev/null)
		_vals=$(printf '%s' "$_si" | jsonfilter -e '@.memory.total' -e '@.memory.available' -e '@.memory.free' -e '@.uptime' -e '@.load[0]' -e '@.load[1]' -e '@.load[2]' -e '@.root.used' -e '@.root.total' 2>/dev/null)
		_oldifs="$IFS"; IFS='
'
		set -- $_vals
		IFS="$_oldifs"
		mem_t="$1"; mem_a="$2"; mem_f="$3"; up="$4"; l1="$5"; l5="$6"; l15="$7"; fl_u="$8"; fl_t="$9"
		fl_pct=0
		[ -n "$fl_u" ] && [ -n "$fl_t" ] && [ "$fl_t" -gt 0 ] && fl_pct=$((fl_u * 100 / fl_t))
		cpu_pct=$(cpu_usage_pct)
		cpus=$(grep -c ^processor /proc/cpuinfo 2>/dev/null || true)
		[ -n "$cpus" ] && [ "$cpus" -gt 0 ] || cpus=1
		# первый опрос /proc/stat ещё без дельты — грубая оценка из load average
		if [ "$cpu_pct" -eq 0 ] && [ -n "$l1" ] && [ "$l1" -gt 0 ]; then
			cpu_pct=$(( l1 * 100 / 65536 / cpus ))
			[ "$cpu_pct" -gt 100 ] && cpu_pct=100
		fi
		echo "{\"running\":$run,\"autostart\":$(is_autostart),\"mode\":\"$mode\",\"select_level\":\"$slvl\",\"ru_set\":$ru_set,\"udp_tunnel\":\"$udpt\",\"ru_subnets\":$ru,\"dns_primary\":\"$dpri\",\"dns_fallback\":\"$dfb\",\"doh_mode\":\"$dmode\",\"poisoned_count\":$pcnt,\"mem_total\":${mem_t:-0},\"mem_avail\":${mem_a:-0},\"mem_free\":${mem_f:-0},\"load_1\":${l1:-0},\"load_5\":${l5:-0},\"load_15\":${l15:-0},\"cpu_pct\":${cpu_pct:-0},\"uptime\":${up:-0},\"flash_pct\":$fl_pct,\"day_up\":${day_up:-0},\"day_down\":${day_down:-0},\"month_up\":${month_up:-0},\"month_down\":${month_down:-0}}"
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
	checkreach)
		# проверка доступности домена (nslookup/ping) для карточки "Проверка доступности"
		t="$2"; d="$3"
		[ -n "$d" ] || { echo '{"error":"no domain"}'; exit 1; }
		[ -x /etc/tinyvless/checkreach.sh ] && /etc/tinyvless/checkreach.sh "$t" "$d" || echo '{"error":"checkreach unavailable"}'
		;;
	netinfo)
		# диагностика модема (сигнал/оператор/тип сети/регистрация) для карточки "Модем"
		[ -x /usr/bin/atcmd ] && /usr/bin/atcmd net-info-json 2>/dev/null || echo '{"error":"atcmd unavailable"}'
		;;
	log)
		# сворачиваемый мини-журнал в панели мониторинга — только по клику, не на поллинге
		logread 2>/dev/null | grep -E 'tv-health|tinyvless|dnsmasq|OOM|Out of memory|Killed process' | tail -n 50
		;;
	speedtest_ping)
		# $2=via(tunnel|direct) $3=url $4=type(cf|generic). tunnel — через socks5 127.0.0.1:1080
		# (сам туннель, независимо от routing-правил), direct — обычным путём. url/type приходят
		# из /etc/tinyvless/speedtest_sources.json (редактируется в микротюнинге).
		# ★ ИСПРАВЛЕНО: раньше мерили time_starttransfer (время до ПЕРВОГО БАЙТА ОТВЕТА) — это
		# включает DNS+TCP+TLS+обработку страницы сервером (у динамических сайтов — до секунды и
		# больше), а вовсе не сетевой RTT. Отсюда "пинг" 2-6 секунд вместо реальных ~50-100мс
		# (проверено вручную: реальный ICMP до ya.ru — 35-64мс, ровно как показывает телефон).
		# direct → настоящий ICMP (тот же метод, что у обычных speedtest-приложений).
		# tunnel → ICMP через SOCKS5 физически невозможен. time_connect тут НЕ подходит — это
		# коннект к ЛОКАЛЬНОМУ сокету 127.0.0.1:1080 (всегда ~1-3мс, бессмысленно). Берём
		# time_appconnect — момент, когда TLS-сессия ЧЕРЕЗ туннель реально установлена (проверено
		# вручную: time_connect=3мс против time_appconnect=5.6с на том же запросе).
		via="$2"; url="$3"; type="${4:-generic}"
		echo "$url" | grep -qE '^https?://[A-Za-z0-9.-]+(/.*)?$' || { echo '{"error":"bad url"}'; exit 0; }
		_host=$(echo "$url" | sed -E 's#^https?://##; s#[:/].*##')
		if [ "$via" = "direct" ]; then
			# -c 2 -W 1 (не 3×2с) — uhttpd держит всего 3 одновременных CGI-слота (-n 3), а
			# недоступный (заблокированный за границей) хост держал бы слот занятым до 6с,
			# конкурируя с обычным поллингом панели каждые 8с — отсюда были подвисания страницы.
			_out=$(ping -c 2 -W 1 "$_host" 2>&1)
			_avg=$(printf '%s\n' "$_out" | sed -n "s#.*= [0-9.]*/\([0-9.]*\)/.*#\1#p" | tail -1)
			if [ -n "$_avg" ]; then
				_ms=$(awk "BEGIN{ printf \"%.0f\", $_avg }")
				echo "{\"ping_ms\":$_ms,\"http\":200}"
			else
				echo "{\"ping_ms\":0,\"http\":000}"
			fi
		else
			if [ "$type" = "cf" ]; then _target="${url%/}/__down?bytes=0"; else _target="$url"; fi
			_res=$(curl -m 8 -L --max-redirs 3 --socks5-hostname 127.0.0.1:1080 -o /dev/null -s -w '%{time_appconnect} %{http_code}' "$_target" 2>/dev/null)
			set -- $_res
			_t="${1:-0}"; _http="${2:-0}"
			_ms=0
			[ "$_http" = "200" ] && _ms=$(awk "BEGIN{ printf \"%.0f\", ${_t}*1000 }")
			echo "{\"ping_ms\":$_ms,\"http\":${_http:-0}}"
		fi
		;;
	speedtest_dl_chunk)
		# $2=via $3=url $4=type $5=bytes — один чанк скачивания (несколько мелких подряд вместо
		# одного долгого блокирующего — живой прогресс на фронте). cf — точный размер чанка
		# (__down?bytes=N); generic — сервер не даёт контроля размера ответа, мерим что есть
		# (с cache-bust query, чтобы не словить кэш).
		# ★ ИСПРАВЛЕНО: time_total включает DNS+TCP+TLS ДО начала передачи данных — на реальном
		# тесте это было ~70% всего времени запроса (проверено: 785мс total, из них только 211мс
		# реальная передача 203КБ). Из-за этого скорость считалась в разы заниженной. Теперь берём
		# ТОЛЬКО время самой передачи (time_total - time_starttransfer).
		via="$2"; url="$3"; type="${4:-generic}"; bytes="${5:-600000}"
		echo "$url" | grep -qE '^https?://[A-Za-z0-9.-]+(/.*)?$' || { echo '{"error":"bad url"}'; exit 0; }
		_sock=""; [ "$via" = "tunnel" ] && _sock="--socks5-hostname 127.0.0.1:1080"
		if [ "$type" = "cf" ]; then _target="${url%/}/__down?bytes=$bytes"; else _target="${url%/}/?_=$$-$RANDOM"; fi
		_res=$(curl -m 8 -L --max-redirs 3 $_sock -o /dev/null -s -w '%{size_download} %{time_total} %{time_starttransfer} %{http_code}' "$_target" 2>/dev/null)
		set -- $_res
		_bytes="${1:-0}"; _ttot="${2:-0}"; _tstart="${3:-0}"; _http="${4:-0}"
		_ttrans=$(awk "BEGIN{ d=${_ttot}-${_tstart}; if (d<0.001) d=0.001; printf \"%.6f\", d }")
		echo "{\"bytes\":$_bytes,\"time\":$_ttrans,\"http\":$_http}"
		;;
	speedtest_ul_chunk)
		# $2=via $3=url $4=type $5=bytes — та же поправка, что и в dl_chunk: время передачи
		# (time_total - time_pretransfer), а не полное время запроса с handshake'ом.
		via="$2"; url="$3"; type="${4:-generic}"; bytes="${5:-400000}"
		echo "$url" | grep -qE '^https?://[A-Za-z0-9.-]+(/.*)?$' || { echo '{"error":"bad url"}'; exit 0; }
		[ -f /tmp/.tv_speedtest_up ] || dd if=/dev/urandom of=/tmp/.tv_speedtest_up bs=1M count=2 2>/dev/null
		_sock=""; [ "$via" = "tunnel" ] && _sock="--socks5-hostname 127.0.0.1:1080"
		if [ "$type" = "cf" ]; then _target="${url%/}/__up"; else _target="${url%/}/"; fi
		_res=$(head -c "$bytes" /tmp/.tv_speedtest_up | curl -m 8 -L --max-redirs 3 $_sock -X POST --data-binary @- -o /dev/null -s -w '%{size_upload} %{time_total} %{time_pretransfer} %{http_code}' "$_target" 2>/dev/null)
		set -- $_res
		_bytes="${1:-0}"; _ttot="${2:-0}"; _tpre="${3:-0}"; _http="${4:-0}"
		_ttrans=$(awk "BEGIN{ d=${_ttot}-${_tpre}; if (d<0.001) d=0.001; printf \"%.6f\", d }")
		echo "{\"bytes\":$_bytes,\"time\":$_ttrans,\"http\":$_http}"
		;;
	dnsapply)
		# применить DNS-настройки из config + poisoned_domains.list (регенерация dnsmasq)
		[ -x /etc/tinyvless/domains.sh ] && /etc/tinyvless/domains.sh >/dev/null 2>&1
		echo '{"ok":true}'
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
				# фон, не синхронно — заливка 8626 подсетей батчами через nft занимает ~24с,
				# а uhttpd держит запрос всего -T 30с (было QA-находкой: ответ висел вплотную
				# к таймауту). apply-route.sh ниже уже фоновый — тот же паттерн.
				[ -x /etc/tinyvless/ru_cidr_reload.sh ] && setsid /etc/tinyvless/ru_cidr_reload.sh >/dev/null 2>&1 </dev/null &
				;;
			udp_tunnel)
				case "$val" in full|selective|discord) set_conf UDP_TUNNEL "$val" ;; *) echo '{"error":"bad val"}'; exit 1;; esac
				;;
			*) echo '{"error":"bad key"}'; exit 1;;
		esac
		m=$(sed -n "s/^[[:space:]]*MODE=['\"]\?\([a-z]*\).*/\1/p" "$CONF" 2>/dev/null | head -1)
		setsid sh /etc/tinyvless/apply-route.sh "${m:-selective}" >/dev/null 2>&1 </dev/null &
		echo "{\"ok\":true,\"key\":\"$key\",\"val\":\"$val\"}"
		;;
	clients)
		bmac=" $(sed -n "s/^[[:space:]]*BYPASS_MAC=['\"]\?\([^'\"]*\)['\"]\?.*/\1/p" "$CONF" 2>/dev/null | head -1 | tr 'A-Z' 'a-z') "
		printf '{"clients":['
		first=1
		if [ -f /tmp/dhcp.leases ]; then
			while read -r exp mac ip host _; do
				[ -z "$mac" ] && continue
				bypass=0
				echo "$bmac" | grep -q " ${mac} " && bypass=1
				[ "$first" -eq 0 ] && printf ','
				first=0
				host="${host:-*}"
				printf '{"mac":"%s","ip":"%s","hostname":"%s","proxy":%s}' "$mac" "$ip" "$host" "$([ "$bypass" = 1 ] && echo false || echo true)"
			done <<EOF
$(grep -E '^[0-9]+ [0-9a-f:]{17} [0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' /tmp/dhcp.leases 2>/dev/null)
EOF
		fi
		printf ']}'
		;;
	client_bypass)
		mac=$(echo "$2" | tr 'A-Z' 'a-z')
		action="$3"
		[ -n "$mac" ] && echo "$mac" | grep -qE '^([0-9a-f]{2}:){5}[0-9a-f]{2}$' || { echo '{"error":"bad mac"}'; exit 1; }
		case "$action" in on|off) ;; *) echo '{"error":"bad action"}'; exit 1;; esac
		cur=$(sed -n "s/^[[:space:]]*BYPASS_MAC=['\"]\?\([^'\"]*\)['\"]\?.*/\1/p" "$CONF" 2>/dev/null | head -1 | tr 'A-Z' 'a-z')
		set -- $cur
		new=""
		for x in "$@"; do
			[ -z "$x" ] && continue
			[ "$x" = "$mac" ] && continue
			new="$new $x"
		done
		if [ "$action" = "on" ]; then
			echo " $new " | grep -q " $mac " || new="$new $mac"
		fi
		new=$(echo "$new" | sed 's/^ *//;s/ *$//')
		set_conf BYPASS_MAC "$new"
		m=$(sed -n "s/^[[:space:]]*MODE=['\"]\?\([a-z]*\).*/\1/p" "$CONF" 2>/dev/null | head -1)
		setsid sh /etc/tinyvless/apply-route.sh "${m:-selective}" >/dev/null 2>&1 </dev/null &
		echo "{\"ok\":true,\"mac\":\"$mac\",\"proxy\":$([ "$action" = "off" ] && echo true || echo false)}"
		;;
	microtun_get)
		MT=/etc/tinyvless/microtun.conf
		[ -f "$MT" ] || MT=/etc/tinyvless/microtun.defaults
		printf '{'
		first=1
		while read -r line; do
			case "$line" in ''|\#*) continue ;; esac
			k=${line%%=*}; v=${line#*=}
			[ -n "$k" ] || continue
			[ "$first" -eq 0 ] && printf ','
			first=0
			printf '"%s":"%s"' "$k" "$v"
		done < "$MT"
		printf '}'
		;;
	microtun_apply)
		MT=/etc/tinyvless/microtun.conf
		if [ -n "$MICROTUN_BODY" ]; then
			echo "$MICROTUN_BODY" > "$MT"
		fi
		sh /etc/tinyvless/microtun-apply.sh >/dev/null 2>&1
		m=$(sed -n "s/^[[:space:]]*MODE=['\"]\?\([a-z]*\).*/\1/p" "$CONF" 2>/dev/null | head -1)
		setsid sh /etc/tinyvless/apply-route.sh "${m:-selective}" >/dev/null 2>&1 </dev/null &
		echo '{"ok":true}'
		;;
	microtun_reset)
		cp /etc/tinyvless/microtun.defaults /etc/tinyvless/microtun.conf
		sh /etc/tinyvless/microtun-apply.sh >/dev/null 2>&1
		m=$(sed -n "s/^[[:space:]]*MODE=['\"]\?\([a-z]*\).*/\1/p" "$CONF" 2>/dev/null | head -1)
		setsid sh /etc/tinyvless/apply-route.sh "${m:-selective}" >/dev/null 2>&1 </dev/null &
		echo '{"ok":true}'
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
	subscription_fetch)
		[ -n "$2" ] || { echo '{"ok":false,"error":"no url"}'; exit 0; }
		/etc/tinyvless/subscription.sh fetch "$2"
		;;
	*)
		echo '{"error":"unknown"}'
		;;
esac
