#!/bin/sh /etc/rc.common
# sing-box transparent proxy (tproxy) for Cudy LT300 v3.
# Sets up nftables tproxy + policy routing on start, tears down on stop.
START=99
STOP=10
USE_PROCD=1

PROG=/usr/bin/sing-box
CONF=/etc/sing-box/config.json
TPROXY_PORT=7893
FWMARK=0x1
RT_TABLE=100
LAN_SUBNET=192.168.10.0/24

_plumbing_up() {
	ip rule del fwmark $FWMARK lookup $RT_TABLE 2>/dev/null
	ip route flush table $RT_TABLE 2>/dev/null
	nft delete table ip singbox 2>/dev/null
	ip rule add fwmark $FWMARK lookup $RT_TABLE
	ip route add local 0.0.0.0/0 dev lo table $RT_TABLE
	nft -f - <<-NFT
		table ip singbox {
		  chain prerouting {
		    type filter hook prerouting priority mangle; policy accept;
		    ip saddr $LAN_SUBNET jump sbproxy
		  }
		  chain sbproxy {
		    ip daddr { 127.0.0.0/8, $LAN_SUBNET, 10.0.0.0/8, 172.16.0.0/12, 169.254.0.0/16, 224.0.0.0/4, 240.0.0.0/4, 100.64.0.0/10 } return
		    meta l4proto tcp tproxy to 127.0.0.1:$TPROXY_PORT meta mark set $FWMARK accept
		    meta l4proto udp tproxy to 127.0.0.1:$TPROXY_PORT meta mark set $FWMARK accept
		  }
		}
	NFT
}

_plumbing_down() {
	nft delete table ip singbox 2>/dev/null
	ip rule del fwmark $FWMARK lookup $RT_TABLE 2>/dev/null
	ip route flush table $RT_TABLE 2>/dev/null
}

start_service() {
	_plumbing_up
	procd_open_instance
	procd_set_param command "$PROG" run -c "$CONF"
	procd_set_param env GOMAXPROCS=1
	procd_set_param respawn 3600 5 0
	procd_set_param stdout 1
	procd_set_param stderr 1
	procd_close_instance
}

stop_service() {
	_plumbing_down
}
