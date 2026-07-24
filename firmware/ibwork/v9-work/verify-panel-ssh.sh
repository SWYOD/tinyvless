#!/bin/sh
# SSH smoke-test панели tinyvless (api.sh + CGI tuning).
PASS=0
FAIL=0
ok()  { PASS=$((PASS+1)); echo "  OK  $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL $1"; [ -n "$2" ] && echo "       $2"; }

API=/etc/tinyvless/api.sh
wait_run() {
	i=0
	while [ "$i" -lt 25 ]; do
		$API status 2>/dev/null | grep -q '"running":true' && return 0
		sleep 2
		i=$((i+1))
	done
	return 1
}
wait_off() {
	i=0
	while [ "$i" -lt 15 ]; do
		$API status 2>/dev/null | grep -q '"running":false' && return 0
		sleep 1
		i=$((i+1))
	done
	return 1
}
json_ok() { echo "$1" | grep -q '"ok":true'; }
wait_nft() {
	pat="$1"; i=0
	while [ "$i" -lt 20 ]; do
		nft list chain ip tinyvless "$2" 2>/dev/null | grep -q "$pat" && return 0
		sleep 1
		i=$((i+1))
	done
	return 1
}

echo "=== tinyvless panel SSH verify ==="

# 1 state + status
OUT=$($API state 2>&1) || true
echo "$OUT" | grep -q '"mem_total":[1-9]' && ok "state (sysinfo)" || bad "state sysinfo" "$OUT"
OUT=$($API status 2>&1) || true
echo "$OUT" | grep -q '"running":' && ok "status" || bad "status" "$OUT"

# 2 modes
for m in selective full off selective; do
	$API mode "$m" >/dev/null 2>&1
	CFG=$(grep '^MODE=' /etc/tinyvless/config | head -1)
	echo "$CFG" | grep -qE "MODE=['\"]?$m['\"]?$" && ok "mode $m config" || bad "mode $m config" "$CFG"
	if [ "$m" = "off" ]; then
		sleep 2
		/etc/tinyvless/tvroute.sh off 2>&1 | tail -1 | grep -q 'mode=off' && ok "mode off tvroute" || bad "mode off tvroute"
	else
		wait_nft redirect pre_tcp && ok "mode $m nft redirect" || bad "mode $m nft"
	fi
done
$API mode selective >/dev/null 2>&1

# 3 tuning
$API tuning select_level high | grep -q '"ok":true' && ok "tuning select_level high" || bad "tuning select high"
wait_nft 'ip daddr @direct_domains return' pre_tcp && ok "high: direct return present" || bad "high nft"
$API tuning select_level low | grep -q '"ok":true' && ok "tuning select_level low" || bad "tuning select low"
$API tuning ru_set off | grep -q '"ok":true' && ok "tuning ru_set off" || bad "ru_set off"
$API tuning ru_set on | grep -q '"ok":true' && ok "tuning ru_set on" || bad "ru_set on"
sleep 3
$API tuning udp_tunnel discord | grep -q '"ok":true' && ok "tuning udp discord" || bad "udp discord"
wait_nft '19294-19344' pre_udp && ok "udp discord ports in nft" || bad "udp discord nft"
$API tuning udp_tunnel full | grep -q '"ok":true' && ok "tuning udp full" || bad "udp full"

# 4 autostart
$API autostart off | grep -q '"autostart":false' && ok "autostart off" || bad "autostart off"
ls /etc/rc.d/S*tinyvless >/dev/null 2>&1 && bad "autostart symlink still exists" || ok "autostart disabled (no S* link)"
$API autostart on | grep -q '"autostart":true' && ok "autostart on" || bad "autostart on"
ls /etc/rc.d/S*tinyvless >/dev/null 2>&1 && ok "autostart enabled (S* link)" || bad "autostart no symlink"

# 5 power stop/start
$API stop >/dev/null 2>&1
sleep 3
wait_off && ok "stop → running false" || bad "stop"
$API start >/dev/null 2>&1
wait_run && ok "start → running true" || bad "start"
$API restart >/dev/null 2>&1
wait_run && ok "restart → running true" || bad "restart"

# 6 domains + dns
$API domains | grep -q '"ok":true' && ok "domains apply" || bad "domains"
$API dnsapply | grep -q '"ok":true' && ok "dnsapply" || bad "dnsapply"
OUT=$($API checkdomain youtube.com 2>&1)
echo "$OUT" | grep -q '"domain":"youtube.com"' && ok "checkdomain youtube" || bad "checkdomain" "$OUT"

# 7 CGI tuning (как /tinyvless)
export QUERY_STRING='a=exec&cmd=tuning&m=select_level&arg=low'
OUT=$(/www/cgi-bin/tv 2>/dev/null | tail -1)
echo "$OUT" | grep -q '"ok":true' && ok "CGI tuning" || bad "CGI tuning" "$OUT"

# 8 services
pidof tinyvless >/dev/null && ok "tinyvless pid" || bad "tinyvless pid"
pidof dnsmasq >/dev/null && ok "dnsmasq pid" || bad "dnsmasq pid"
pidof tvled >/dev/null && ok "tvled pid" || bad "tvled pid"

# restore defaults for manual UI test
$API tuning select_level low >/dev/null 2>&1
$API tuning ru_set on >/dev/null 2>&1
$API tuning udp_tunnel full >/dev/null 2>&1
$API mode selective >/dev/null 2>&1

echo "=== RESULT: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
