#!/bin/sh
# Комплексный smoke-test tinyvless: режимы, тюнинг, DNS, ping, HTTP (RU + зарубеж).
# Запуск: sh /etc/tinyvless/smoke-test-routing.sh

set -u
API=/etc/tinyvless/api.sh
PASS=0
FAIL=0
WARN=0
REPORT=/tmp/tv-smoke-report.txt

ok()   { PASS=$((PASS+1)); echo "  OK   $1"; echo "OK   $1" >> "$REPORT"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL $1"; [ -n "${2:-}" ] && echo "       $2"; echo "FAIL $1 ${2:-}" >> "$REPORT"; }
warn() { WARN=$((WARN+1)); echo "  WARN $1"; [ -n "${2:-}" ] && echo "       $2"; echo "WARN $1 ${2:-}" >> "$REPORT"; }
info() { echo "  ..   $1"; echo "..   $1" >> "$REPORT"; }

wait_run() {
	i=0
	while [ "$i" -lt 30 ]; do
		$API status 2>/dev/null | grep -q '"running":true' && return 0
		sleep 2
		i=$((i+1))
	done
	return 1
}

wait_route() { sleep 6; }

apply_mode() {
	m="$1"
	# синхронно — api mode асинхронный, для тестов ждём реальный apply
	case "$m" in selective|full|off) ;; *) return 1;; esac
	$API mode "$m" >/dev/null 2>&1 || return 1
	grep -qE "^MODE=['\"]?$m['\"]?$" /etc/tinyvless/config || return 1
	sh /etc/tinyvless/apply-route.sh "$m" >/dev/null 2>&1 || return 1
	wait_route
	return 0
}

apply_tuning() {
	key="$1"; val="$2"
	out=$($API tuning "$key" "$val" 2>&1) || true
	echo "$out" | grep -q '"ok":true' || return 1
	m=$(grep '^MODE=' /etc/tinyvless/config | sed "s/^MODE=//;s/['\"]//g")
	sh /etc/tinyvless/apply-route.sh "${m:-selective}" >/dev/null 2>&1 || return 1
	wait_route
	return 0
}

dns_resolve_v4() {
	d="$1"
	nslookup "$d" 127.0.0.1 2>/dev/null | awk '/^Address: [0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/{gsub(/:.*/,"",$2); print $2; exit}'
}

ping_host() { ping -c 1 -W 3 "$1" >/dev/null 2>&1; }

http_ok() {
	url="$1"
	wget -q -O /dev/null -T 10 "$url" 2>/dev/null
}

nft_has() { nft list ruleset 2>/dev/null | grep -q "$1"; }

nft_table_exists() { nft list table ip tinyvless >/dev/null 2>&1; }

tunnel_set_count() {
	n=$(nft list set ip tinyvless tunnel_domains 2>/dev/null | grep -cE '^\s+[0-9]+\.[0-9]+' || true)
	[ -n "$n" ] && echo "$n" || echo 0
}

check_nft_expect() {
	label="$1"; expect="$2"
	nft_table_exists || { bad "$label nft table missing"; return; }
	case "$expect" in
		high)
			nft_has '@tunnel_domains meta l4proto tcp redirect' && ok "$label nft tunnel-only redirect" || bad "$label nft tunnel redirect"
			nft list chain ip tinyvless pre_tcp 2>/dev/null | grep -q 'meta l4proto tcp redirect to' || bad "$label nft no catch-all"
			;;
		low|full)
			nft list chain ip tinyvless pre_tcp 2>/dev/null | grep -q 'meta l4proto tcp redirect' && ok "$label nft tcp redirect" || bad "$label nft tcp redirect"
			;;
		off)
			nft list chain ip tinyvless pre_tcp >/dev/null 2>&1 && bad "$label nft pre_tcp should be gone" || ok "$label nft off (no pre_tcp)"
			;;
	esac
}

check_sites() {
	label="$1"
	info "$label — DNS v4 / ping / HTTPS / nftset"
	for d in youtube.com instagram.com yandex.ru sberbank.ru; do
		ip=$(dns_resolve_v4 "$d") || true
		if [ -n "${ip:-}" ]; then ok "$label DNS $d → $ip"; else bad "$label DNS $d"; fi
		if ping -c 1 -W 3 "$ip" >/dev/null 2>&1; then ok "$label ping $d ($ip)"; else warn "$label ping $d" "ICMP blocked?"; fi
		case "$d" in youtube.com|instagram.com)
			# с роутера HTTPS идёт напрямую (нет output-hook) — проверяем попадание IP в nftset
			if nft list set ip tinyvless tunnel_domains 2>/dev/null | grep -q "$ip"; then
				ok "$label nftset tunnel $d ($ip)"
			else
				warn "$label nftset tunnel $d" "IP $ip not in set yet"
			fi
			;;
		*)
			if http_ok "https://$d/"; then ok "$label HTTPS $d"; else warn "$label HTTPS $d" "direct wget failed"; fi
			;;
		esac
	done
}

: > "$REPORT"
echo "=== tinyvless routing smoke-test ==="
date >> "$REPORT"

info "baseline"
wait_run && ok "tinyvless running" || bad "tinyvless running"
pidof dnsmasq >/dev/null && ok "dnsmasq pid" || bad "dnsmasq pid"
nft_table_exists && ok "nft table exists" || bad "nft table missing (apply-route broken?)"
tc=$(tunnel_set_count)
[ "$tc" -gt 3 ] && ok "tunnel_domains populated ($tc)" || warn "tunnel_domains count" "$tc (DNS may still be warming)"
$API domains >/dev/null 2>&1 && ok "domains apply" || bad "domains apply"
OUT=$($API checkdomain youtube.com 2>&1)
echo "$OUT" | grep -q '"domain":"youtube.com"' && ok "checkdomain youtube" || bad "checkdomain youtube" "$OUT"

SAVE_MODE=$(grep '^MODE=' /etc/tinyvless/config | sed "s/^MODE=//;s/['\"]//g")
SAVE_SL=$(grep '^SELECT_LEVEL=' /etc/tinyvless/config | sed "s/^SELECT_LEVEL=//;s/['\"]//g")
SAVE_RU=$(grep '^RU_SET=' /etc/tinyvless/config | sed 's/^RU_SET=//')
SAVE_UDP=$(grep '^UDP_TUNNEL=' /etc/tinyvless/config | sed "s/^UDP_TUNNEL=//;s/['\"]//g")

for m in selective full off selective; do
	info "--- mode $m ---"
	apply_mode "$m" && ok "mode $m" || bad "mode $m"
	case "$m" in off) check_nft_expect "mode $m" off ;; full) check_nft_expect "mode $m" full ;; *) check_nft_expect "mode $m" low ;; esac
	[ "$m" != "off" ] && check_sites "mode=$m"
done

run_matrix() {
	sl="$1"; ru="$2"; udp="$3"
	info "--- selective select=$sl ru=$ru udp=$udp ---"
	apply_tuning select_level "$sl" && ok "tuning select=$sl" || bad "tuning select=$sl"
	apply_tuning ru_set "$([ "$ru" = 1 ] && echo on || echo off)" && ok "tuning ru_set=$ru" || bad "tuning ru_set=$ru"
	apply_tuning udp_tunnel "$udp" && ok "tuning udp=$udp" || bad "tuning udp=$udp"
	apply_mode selective && ok "mode selective" || bad "mode selective"
	check_nft_expect "matrix/$sl" "$sl"
	check_sites "sel/$sl/ru$ru/$udp"
}

run_matrix low 1 full
run_matrix high 0 discord
run_matrix high 1 discord
run_matrix low 0 full

info "restore"
apply_tuning select_level "${SAVE_SL:-low}" >/dev/null 2>&1
apply_tuning ru_set "$([ "${SAVE_RU:-1}" = 1 ] && echo on || echo off)" >/dev/null 2>&1
apply_tuning udp_tunnel "${SAVE_UDP:-full}" >/dev/null 2>&1
apply_mode "${SAVE_MODE:-selective}" >/dev/null 2>&1

echo "=== RESULT: $PASS passed, $FAIL failed, $WARN warnings ==="
echo "Report: $REPORT"
[ "$FAIL" -eq 0 ]
