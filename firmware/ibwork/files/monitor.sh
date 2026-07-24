#!/bin/sh
rm -f /tmp/monitor.log
for i in $(seq 1 24); do
  echo "[$((i*10))s] tv=$(pidof tinyvless|wc -w) run=$(wget -q -O - -T2 http://127.0.0.1:19999/status 2>/dev/null|grep -o running.:true) av=$(free|awk 'NR==2{print $7}')k oom=$(dmesg 2>/dev/null|grep -c 'Out of memory')" >> /tmp/monitor.log
  sleep 10
done
echo "MONITOR_DONE" >> /tmp/monitor.log
