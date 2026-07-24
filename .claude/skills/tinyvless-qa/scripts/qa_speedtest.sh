#!/bin/sh
MON=/tmp/qa_mon.log
: > "$MON"
( while true; do
    ts=$(date +%s)
    cpu=$(sed -n '1p' /proc/stat)
    mem=$(free | sed -n '2p')
    echo "$ts CPU:$cpu MEM:$mem" >> "$MON"
    sleep 1
  done ) &
MONPID=$!

echo '=== TUNNEL (cloudflare) ==='
curl -s 'http://127.0.0.1/cgi-bin/tv?a=exec&cmd=speedtest_ping&m=tunnel&arg=https%3A%2F%2Fspeed.cloudflare.com&t=cf'
echo
curl -s 'http://127.0.0.1/cgi-bin/tv?a=exec&cmd=speedtest_dl_chunk&m=tunnel&arg=https%3A%2F%2Fspeed.cloudflare.com&t=cf&v=2000000'
echo
curl -s 'http://127.0.0.1/cgi-bin/tv?a=exec&cmd=speedtest_ul_chunk&m=tunnel&arg=https%3A%2F%2Fspeed.cloudflare.com&t=cf&v=1000000'
echo

echo '=== DIRECT (cloudflare) ==='
curl -s 'http://127.0.0.1/cgi-bin/tv?a=exec&cmd=speedtest_ping&m=direct&arg=https%3A%2F%2Fspeed.cloudflare.com&t=cf'
echo
curl -s 'http://127.0.0.1/cgi-bin/tv?a=exec&cmd=speedtest_dl_chunk&m=direct&arg=https%3A%2F%2Fspeed.cloudflare.com&t=cf&v=2000000'
echo
curl -s 'http://127.0.0.1/cgi-bin/tv?a=exec&cmd=speedtest_ul_chunk&m=direct&arg=https%3A%2F%2Fspeed.cloudflare.com&t=cf&v=1000000'
echo

kill "$MONPID" 2>/dev/null
wait "$MONPID" 2>/dev/null

echo '=== MONITOR LOG ==='
cat "$MON"
rm -f "$MON"
