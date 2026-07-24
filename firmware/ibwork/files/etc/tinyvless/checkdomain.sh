#!/bin/sh
# checkdomain.sh <домен> — резолвит домен ЧЕРЕЗ ОСНОВНОЙ РЕЗОЛВЕР и ЧЕРЕЗ DoH параллельно,
# сравнивает. Если основной вернул подозрительный адрес (loopback/0.0.0.0/приватный), а DoH дал
# настоящий IP — считаем домен травленным. Печатает JSON на stdout (для api.sh/морды).
DOMAIN="$1"
[ -n "$DOMAIN" ] || { echo '{"error":"no domain"}'; exit 1; }

CONF=/etc/tinyvless/config
DNS_PRIMARY=77.88.8.8
[ -f "$CONF" ] && . "$CONF" 2>/dev/null

PRIMARY_IP=$(nslookup "$DOMAIN" "$DNS_PRIMARY" 2>/dev/null | grep '^Address' | grep -v ':53' | tail -1 | sed 's/.* //')

# DoH напрямую (не через dnsmasq — чтобы сравнение было независимым от текущего DOH_MODE).
# Идёт через out_doh NAT-редирект в туннель (Yota блокирует 1.1.1.1 напрямую) — тот же путь,
# что и у https-dns-proxy.
DOH_RESP=$(curl -sk -m 6 "https://1.1.1.1/dns-query?name=$DOMAIN&type=A" -H "accept: application/dns-json" 2>/dev/null)
DOH_IP=$(echo "$DOH_RESP" | grep -oE '"data":"[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+"' | head -1 | sed 's/"data":"//;s/"//')

# ВАЖНО: разные-но-оба-публичные IP от разных резолверов — НОРМА (anycast/CDN/балансировка,
# видели это на VK — 6 разных легитимных адресов). Травля — это именно loopback/приватный/пустой
# ответ у основного резолвера при том, что DoH даёт настоящий публичный IP. НЕ флагать просто
# за расхождение адресов.
POISONED=0
case "$PRIMARY_IP" in
	""|127.*|0.0.0.0|10.*|192.168.*|169.254.*)
		[ -n "$DOH_IP" ] && POISONED=1
		;;
esac

echo "{\"domain\":\"$DOMAIN\",\"primary\":\"${PRIMARY_IP:-null}\",\"doh\":\"${DOH_IP:-null}\",\"poisoned\":$POISONED}"
