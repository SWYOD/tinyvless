#!/bin/sh
# Деплой v9-work overlay на живой роутер через HTTP-раздачу с Mac.

set -e
MAC_IP="${1:?usage: $0 <mac-ip>}"
BASE="http://${MAC_IP}:8000"
ROOT="$(cd "$(dirname "$0")" && pwd)"
RSSH="$ROOT/../../../scripts/rssh.exp"

fetch() {
	rel="$1"
	dst="$2"
	echo "→ $dst"
	"$RSSH" "wget -q -O '$dst' '$BASE/$rel'" 30
}

fetch_binary() {
	echo "→ /tmp/tinyvless.new (tmpfs, overlay full)"
	"$RSSH" "wget -q -O /tmp/tinyvless.new '$BASE/bin/$BIN_TAG'" 120
}

fetch_tvled() {
	echo "→ /tmp/tvled.new"
	"$RSSH" "wget -q -O /tmp/tvled.new '$BASE/bin/tvled'" 60
}

echo "=== tinyvless v9-work deploy from $BASE ==="

# backend / stability
fetch "etc/tinyvless/config"                  "/etc/tinyvless/config"
fetch "etc/tinyvless/domains.sh"              "/etc/tinyvless/domains.sh"
fetch "etc/tinyvless/checkdomain.sh"          "/etc/tinyvless/checkdomain.sh"
fetch "etc/tinyvless/dns-watchdog.sh"         "/etc/tinyvless/dns-watchdog.sh"
fetch "etc/tinyvless/poisoned_domains.list"   "/etc/tinyvless/poisoned_domains.list"
fetch "etc/tinyvless/direct_domains.list"     "/etc/tinyvless/direct_domains.list"
fetch "etc/tinyvless/direct_domains_supplement.list" "/etc/tinyvless/direct_domains_supplement.list"
fetch "etc/tinyvless/tunnel_domains.list"   "/etc/tinyvless/tunnel_domains.list"
fetch "etc/tinyvless/tvroute.sh"              "/etc/tinyvless/tvroute.sh"
fetch "etc/tinyvless/apply-route.sh"          "/etc/tinyvless/apply-route.sh"
fetch "etc/tinyvless/ru_cidr_reload.sh"       "/etc/tinyvless/ru_cidr_reload.sh"
fetch "etc/tinyvless/ru_cidr_compact.nft"     "/etc/tinyvless/ru_cidr_compact.nft"
fetch "etc/tinyvless/ru_cidr.meta"            "/etc/tinyvless/ru_cidr.meta"
fetch "etc/tinyvless/api.sh"                  "/etc/tinyvless/api.sh"
fetch "etc/uci-defaults/99-tinyvless-system-tuning" "/etc/uci-defaults/99-tinyvless-system-tuning"
fetch "etc/dnsmasq.conf"                        "/etc/dnsmasq.conf"
fetch "etc/init.d/tinyvless"                  "/etc/init.d/tinyvless"
fetch "etc/init.d/tinyvless-dns"              "/etc/init.d/tinyvless-dns"
fetch "etc/init.d/tvled"                      "/etc/init.d/tvled"

# frontend
fetch "www/luci-static/resources/view/tinyvless/app4.js" "/www/luci-static/resources/view/tinyvless/app4.js"
fetch "www/luci-static/resources/view/tinyvless/main.js" "/www/luci-static/resources/view/tinyvless/main.js"
fetch "www/cgi-bin/tv"                          "/www/cgi-bin/tv"
fetch "www/tinyvless/index.html"                "/www/tinyvless/index.html"
fetch "usr/share/rpcd/acl.d/luci-app-tinyvless.json" "/usr/share/rpcd/acl.d/luci-app-tinyvless.json"

# stability binary (если собран)
BIN_TAG="tinyvless-stability-v2-20260708"
BIN_MD5="bin/$BIN_TAG.md5"
if [ -f "$ROOT/bin/$BIN_TAG" ]; then
	echo "=== binary $BIN_TAG ==="
	fetch_binary
fi
if [ -f "$ROOT/bin/tvled" ]; then
	echo "=== binary tvled ==="
	fetch_tvled
fi

echo "=== chmod + stability apply ==="
"$RSSH" "
chmod +x /etc/tinyvless/domains.sh /etc/tinyvless/checkdomain.sh /etc/tinyvless/dns-watchdog.sh /etc/tinyvless/api.sh /etc/tinyvless/apply-route.sh /etc/tinyvless/ru_cidr_reload.sh /etc/init.d/tinyvless /etc/init.d/tinyvless-dns /etc/init.d/tvled /www/cgi-bin/tv
[ -f /etc/uci-defaults/99-tinyvless-system-tuning ] && sh /etc/uci-defaults/99-tinyvless-system-tuning restart
uci set dhcp.@dnsmasq[0].cachesize=300
uci commit dhcp
if [ -f /tmp/tinyvless.new ]; then
	EXPECTED=\$(wget -qO- '$BASE/bin/$BIN_TAG.md5' 2>/dev/null | awk '{print \$1}')
	GOT=\$(md5sum /tmp/tinyvless.new | awk '{print \$1}')
	if [ -n \"\$EXPECTED\" ] && [ \"\$GOT\" = \"\$EXPECTED\" ]; then
		/etc/init.d/tinyvless stop 2>/dev/null
		chmod +x /tmp/tinyvless.new
		mv /tmp/tinyvless.new /usr/bin/tinyvless
		echo binary_ok md5=\$GOT
	else
		echo binary_md5_FAIL expected=\$EXPECTED got=\$GOT
		rm -f /tmp/tinyvless.new
	fi
fi
if [ -f /tmp/tvled.new ]; then
	chmod +x /tmp/tvled.new
	mv /tmp/tvled.new /usr/bin/tvled
	echo tvled_ok
fi
/etc/tinyvless/domains.sh
/etc/init.d/tinyvless restart
rm -f /tmp/.tv_route.lock /tmp/.tv_ru_ready
sh /etc/tinyvless/apply-route.sh selective
/etc/init.d/tinyvless-dns enable
rm -f /tmp/.tv_dnswd.lock
/etc/init.d/tinyvless-dns restart
/etc/init.d/tvled enable
/etc/init.d/tvled restart
/etc/init.d/rpcd restart >/dev/null 2>&1
echo nftset_lines=\$(grep -c '^nftset=' /etc/dnsmasq.conf)
echo cachesize=\$(uci get dhcp.@dnsmasq[0].cachesize)
pidof tinyvless && pidof dnsmasq && echo OK
" 120

echo "=== done — http://192.168.10.1/tinyvless/ ==="
