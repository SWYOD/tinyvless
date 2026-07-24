#!/bin/sh
# health-watchdog.sh — сторож dnsmasq + tinyvless после OOM-respawn.
# Один экземпляр (flock): procd respawn не должен плодить дубликаты.

[ "$TV_DNSWD" = 1 ] || exec env TV_DNSWD=1 flock -x /tmp/.tv_dnswd.lock "$0" "$@"

INTERVAL=20
LAST_TV_PID=""

while true; do
	sleep "$INTERVAL"

	# dnsmasq мёртв → поднять
	if ! pidof dnsmasq >/dev/null 2>&1; then
		logger -t tv-health 'dnsmasq not running — auto-restart'
		/etc/init.d/dnsmasq restart >/dev/null 2>&1
		[ -x /etc/tinyvless/domains.sh ] && /etc/tinyvless/domains.sh >/dev/null 2>&1
	fi

	# tinyvless respawn (новый pid) → переприменить nft/ip rule
	TV_PID=$(pidof tinyvless 2>/dev/null | awk '{print $1}')
	if [ -n "$TV_PID" ] && [ -n "$LAST_TV_PID" ] && [ "$TV_PID" != "$LAST_TV_PID" ]; then
		logger -t tv-health "tinyvless respawn $LAST_TV_PID->$TV_PID — re-apply route"
		MODE=$(sed -n "s/^[[:space:]]*MODE=['\"]\?\([a-z]*\).*/\1/p" /etc/tinyvless/config 2>/dev/null | head -1)
		[ -f /etc/tinyvless/apply-route.sh ] && sh /etc/tinyvless/apply-route.sh "${MODE:-selective}" >/dev/null 2>&1
	fi
	[ -n "$TV_PID" ] && LAST_TV_PID=$TV_PID
	[ -z "$TV_PID" ] && LAST_TV_PID=""
done
