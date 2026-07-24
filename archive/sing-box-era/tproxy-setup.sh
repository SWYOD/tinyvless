#!/bin/sh
# Live transparent-proxy plumbing test (direct outbound). Idempotent-ish.
ip rule del fwmark 0x1 lookup 100 2>/dev/null
ip route flush table 100 2>/dev/null
nft delete table ip singbox 2>/dev/null
# routing: marked packets delivered locally
ip rule add fwmark 0x1 lookup 100
ip route add local 0.0.0.0/0 dev lo table 100
# nft tproxy for LAN clients
nft -f - <<'NFT'
table ip singbox {
  chain prerouting {
    type filter hook prerouting priority mangle; policy accept;
    ip saddr 192.168.10.0/24 jump sbproxy
  }
  chain sbproxy {
    ip daddr { 127.0.0.0/8, 192.168.10.0/24, 10.0.0.0/8, 172.16.0.0/12, 169.254.0.0/16, 224.0.0.0/4, 240.0.0.0/4, 100.64.0.0/10 } return
    meta l4proto tcp tproxy to 127.0.0.1:7893 meta mark set 0x1 accept
    meta l4proto udp tproxy to 127.0.0.1:7893 meta mark set 0x1 accept
  }
}
NFT
echo "plumbing applied:"; ip rule show | grep 0x1; ip route show table 100; nft list table ip singbox | head -3
