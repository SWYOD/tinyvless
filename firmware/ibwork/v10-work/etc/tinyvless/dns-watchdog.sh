#!/bin/sh
# health-watchdog.sh — сторож dnsmasq + tinyvless после OOM-respawn.
# Один экземпляр (flock): procd respawn не должен плодить дубликаты.

[ "$TV_DNSWD" = 1 ] || exec env TV_DNSWD=1 flock -x /tmp/.tv_dnswd.lock "$0" "$@"

INTERVAL=20
LAST_TV_PID=""
TICK=0
# трафик не нуждается в 20-секундной точности (считаем день/месяц) — учитываем его раз в
# 3 тика (~60с), а health-check (respawn/dnsmasq) остаётся на КАЖДЫЙ тик, т.к. там важна
# быстрая реакция. Экономит wget+2×jsonfilter на 2 тика из 3 — треть фоновой нагрузки демона.
TRAFFIC_EVERY=3

while true; do
	sleep "$INTERVAL"
	TICK=$((TICK + 1))

	# dnsmasq мёртв → поднять
	if ! pidof dnsmasq >/dev/null 2>&1; then
		logger -t tv-health 'dnsmasq not running — auto-restart'
		/etc/init.d/dnsmasq restart >/dev/null 2>&1
		[ -x /etc/tinyvless/domains.sh ] && /etc/tinyvless/domains.sh >/dev/null 2>&1
	fi

	# tinyvless respawn (новый pid) → переприменить nft/ip rule.
	# ВАЖНО: `pidof tinyvless` матчит ЛЮБОЙ процесс с этим именем — включая одноразовые
	# `tinyvless -testlink ...` инстансы, которые панель поднимает при проверке конфигов
	# (карточка «Профили», кнопка проверки). Раньше это давало ложный "respawn" на каждый
	# запуск теста → лишний apply-route.sh сносил и пересобирал живые nft-цепочки роутинга
	# ПОКА ОСНОВНОЙ ТУННЕЛЬ РАБОТАЛ ШТАТНО (найдено 2026-07-13: тест конфигов гонял реальный
	# трафик через кратковременные обрывы). Матчим по -redir — этот флаг есть только у
	# основного procd-инстанса, у -testlink его нет.
	TV_PID=$(ps w | grep '[t]inyvless -redir' | awk '{print $1}' | head -1)
	if [ -n "$TV_PID" ] && [ -n "$LAST_TV_PID" ] && [ "$TV_PID" != "$LAST_TV_PID" ]; then
		logger -t tv-health "tinyvless respawn $LAST_TV_PID->$TV_PID — re-apply route"
		MODE=$(sed -n "s/^[[:space:]]*MODE=['\"]\?\([a-z]*\).*/\1/p" /etc/tinyvless/config 2>/dev/null | head -1)
		[ -f /etc/tinyvless/apply-route.sh ] && sh /etc/tinyvless/apply-route.sh "${MODE:-selective}" >/dev/null 2>&1
	fi
	[ -n "$TV_PID" ] && LAST_TV_PID=$TV_PID
	[ -z "$TV_PID" ] && LAST_TV_PID=""

	[ $((TICK % TRAFFIC_EVERY)) -eq 0 ] || continue

	# ---- учёт трафика (день/месяц) — копим дельту в /tmp (RAM, бесплатно), на flash
	# сбрасываем раз в ~10 минут (10 вызовов этого блока по TRAFFIC_EVERY×INTERVAL=60с) —
	# частая запись убивала бы flash.
	TRAF_STATE=/etc/tinyvless/traffic.stat
	TRAF_TMP=/tmp/.tv_traffic_acc
	_st=$(wget -q -O - -T 2 'http://127.0.0.1:19999/status' 2>/dev/null)
	_up=$(printf '%s' "$_st" | jsonfilter -e '@.up_bytes' 2>/dev/null)
	_down=$(printf '%s' "$_st" | jsonfilter -e '@.down_bytes' 2>/dev/null)
	if [ -n "$_up" ] && [ -n "$_down" ]; then
		_lp=0; _ld=0; _accu=0; _accd=0
		[ -f "$TRAF_TMP" ] && read _lp _ld _accu _accd < "$TRAF_TMP" 2>/dev/null
		if [ "$_up" -ge "$_lp" ] 2>/dev/null; then _du=$((_up - _lp)); else _du=$_up; fi
		if [ "$_down" -ge "$_ld" ] 2>/dev/null; then _dd=$((_down - _ld)); else _dd=$_down; fi
		_accu=$((_accu + _du)); _accd=$((_accd + _dd))
		echo "$_up $_down $_accu $_accd" > "$TRAF_TMP"

		_flushct=0
		[ -f /tmp/.tv_traffic_flushct ] && read _flushct < /tmp/.tv_traffic_flushct 2>/dev/null
		_flushct=$((_flushct + 1))
		if [ "$_flushct" -ge 10 ]; then
			_flushct=0
			_today=$(date +%Y-%m-%d); _month=$(date +%Y-%m)
			_od=""; _odu=0; _odd=0; _om=""; _omu=0; _omd=0
			[ -f "$TRAF_STATE" ] && read _od _odu _odd _om _omu _omd < "$TRAF_STATE" 2>/dev/null
			[ "$_od" = "$_today" ] || { _odu=0; _odd=0; }
			[ "$_om" = "$_month" ] || { _omu=0; _omd=0; }
			echo "$_today $((_odu + _accu)) $((_odd + _accd)) $_month $((_omu + _accu)) $((_omd + _accd))" > "$TRAF_STATE"
			echo "$_up $_down 0 0" > "$TRAF_TMP"
		fi
		echo "$_flushct" > /tmp/.tv_traffic_flushct
	fi
done
