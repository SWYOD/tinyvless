#!/bin/sh
# Применить microtun.conf → dnsmasq, uci, config (порты), logd.
MT=/etc/tinyvless/microtun.conf
CONF=/etc/tinyvless/config
DNSMASQ=/etc/dnsmasq.conf

get_mt() {
	k="$1"; d="$2"
	v=$(sed -n "s/^[[:space:]]*${k}=[[:space:]]*//p" "$MT" 2>/dev/null | head -1)
	[ -n "$v" ] && echo "$v" || echo "$d"
}

[ -f "$MT" ] || exit 1

dfm=$(get_mt DNS_FORWARD_MAX 50)
cache=$(get_mt DNS_CACHESIZE 300)
logkb=$(get_mt LOG_SIZE_KB 96)
redir=$(get_mt REDIR_PORT 1082)
tproxy=$(get_mt TPROXY_PORT 1083)

# dns-forward-max в статическом dnsmasq.conf + cachesize/filter_aaaa через UCI — рестартим
# dnsmasq ТОЛЬКО если что-то из этого реально поменялось (тот же анти-избыточность паттерн,
# что в domains.sh с 2026-07-08: рестарт dnsmasq на каждый клик «Применить», даже если менялось
# несвязанное поле вроде TINYVLESS_NICE или портов — лишний риск без всякой пользы).
DNSMASQ_CHANGED=0
if [ -f "$DNSMASQ" ]; then
	old_dfm=$(sed -n 's/^dns-forward-max=//p' "$DNSMASQ" | head -1)
	if [ "$old_dfm" != "$dfm" ]; then
		DNSMASQ_CHANGED=1
		if grep -q '^dns-forward-max=' "$DNSMASQ"; then
			sed -i "s/^dns-forward-max=.*/dns-forward-max=${dfm}/" "$DNSMASQ"
		else
			echo "dns-forward-max=${dfm}" >> "$DNSMASQ"
		fi
	fi
fi

# cachesize через UCI (не дублировать в dnsmasq.conf)
if [ -f /etc/config/dhcp ]; then
	old_cache=$(uci -q get dhcp.@dnsmasq[0].cachesize 2>/dev/null)
	old_faaaa=$(uci -q get dhcp.@dnsmasq[0].filter_aaaa 2>/dev/null)
	if [ "$old_cache" != "$cache" ] || [ "$old_faaaa" != "1" ]; then
		DNSMASQ_CHANGED=1
		uci set dhcp.@dnsmasq[0].cachesize="$cache"
		uci set dhcp.@dnsmasq[0].filter_aaaa='1'
		uci commit dhcp
	fi
fi

# logd
if [ -f /etc/config/system ]; then
	uci -q get system.@system[0].log_size >/dev/null 2>&1 || uci add system system
	uci set system.@system[0].log_size="$logkb"
	uci commit system
fi

# порты в основной config (init.d читает их)
set_kv() {
	k="$1"; v="$2"
	if grep -q "^[[:space:]]*${k}=" "$CONF" 2>/dev/null; then
		sed -i "s#^[[:space:]]*${k}=.*#${k}='${v}'#" "$CONF"
	else
		echo "${k}='${v}'" >> "$CONF"
	fi
}
set_kv REDIR_PORT "$redir"
set_kv TPROXY_PORT "$tproxy"
set_kv LAN_IF "$(get_mt LAN_IF br-lan)"

/etc/init.d/log restart >/dev/null 2>&1
if [ "$DNSMASQ_CHANGED" = "1" ]; then
	/etc/init.d/dnsmasq restart >/dev/null 2>&1
fi

echo "microtun-apply: ok forward_max=$dfm cache=$cache ports=${redir}/${tproxy} dnsmasq_restarted=$DNSMASQ_CHANGED"
