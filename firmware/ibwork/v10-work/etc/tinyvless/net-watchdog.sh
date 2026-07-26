#!/bin/sh
# net-watchdog.sh — периодически опрашивает модем (сигнал) и здоровье сети провайдера
# (ping+nslookup к настраиваемому домену через checkreach.sh), пишет состояние в JSON
# для карточки "Модем" и баннера плохой связи. Один экземпляр (flock, паттерн dns-watchdog.sh).

[ "$TV_NETWD" = 1 ] || exec env TV_NETWD=1 flock -x /tmp/.tv_netwd.lock "$0" "$@"

MT=/etc/tinyvless/microtun.conf
STATE=/tmp/.tv_netcheck.json
WEAK_SIGNAL_PCT=30

get_mt() {
	k="$1"; d="$2"
	v=$(sed -n "s/^[[:space:]]*${k}=[[:space:]]*//p" "$MT" 2>/dev/null | head -1)
	[ -n "$v" ] && echo "$v" || echo "$d"
}

while true; do
	# перечитываем каждый цикл — интервал/цель/таймаут из микротюнинга подхватываются на
	# следующем же обороте, без рестарта демона (в отличие от tvled — тот compiled-loop,
	# читает свой env один раз при старте, поэтому его рестартит microtun-apply.sh).
	INTERVAL=$(get_mt NETWATCHDOG_POLL_INTERVAL 30)
	TARGET=$(get_mt NETCHECK_TARGET ya.ru)
	AT_TIMEOUT=$(get_mt AT_TIMEOUT_SEC 12)
	case "$INTERVAL" in ''|*[!0-9]*) INTERVAL=30 ;; esac
	case "$AT_TIMEOUT" in ''|*[!0-9]*) AT_TIMEOUT=12 ;; esac

	ni=$(TV_AT_TIMEOUT_SEC="$AT_TIMEOUT" atcmd net-info-json 2>/dev/null)
	sig_pct=$(printf '%s' "$ni" | jsonfilter -e '@.signal_pct' 2>/dev/null)
	sig_dbm=$(printf '%s' "$ni" | jsonfilter -e '@.signal_dbm' 2>/dev/null)
	case "$sig_pct" in ''|*[!0-9]*) sig_pct=0 ;; esac
	case "$sig_dbm" in ''|*[!0-9-]*) sig_dbm=0 ;; esac

	ping_res=$([ -x /etc/tinyvless/checkreach.sh ] && /etc/tinyvless/checkreach.sh ping "$TARGET" 2>/dev/null)
	ping_ok=$(printf '%s' "$ping_res" | jsonfilter -e '@.ok' 2>/dev/null)
	ping_detail=$(printf '%s' "$ping_res" | jsonfilter -e '@.detail' 2>/dev/null)

	ns_res=$([ -x /etc/tinyvless/checkreach.sh ] && /etc/tinyvless/checkreach.sh nslookup "$TARGET" 2>/dev/null)
	ns_ok=$(printf '%s' "$ns_res" | jsonfilter -e '@.ok' 2>/dev/null)

	if [ "$ping_ok" != "true" ]; then
		state=bad
	elif [ "$sig_pct" -lt "$WEAK_SIGNAL_PCT" ] 2>/dev/null; then
		state=warn
	else
		state=ok
	fi

	cat > "$STATE" <<-EOF
	{"signal_pct":${sig_pct:-0},"signal_dbm":${sig_dbm:-0},"ping_ok":${ping_ok:-false},"ping_detail":"${ping_detail:-}","dns_ok":${ns_ok:-false},"target":"$TARGET","state":"$state","checked_at":$(date +%s)}
	EOF

	sleep "$INTERVAL"
done
