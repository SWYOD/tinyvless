#!/bin/sh
# led-refresh.sh — одноразовое обновление 3 задних сигнальных LED (кнопка "Обновить
# светодиоды" в панели). Демон tvled не трогаем — AT-порт общий через flock в atcmd,
# это просто внеочередной опрос сигнала прямо сейчас, не дожидаясь следующего цикла tvled.
# Пороги повторяют csqToLEDs() в src/tvled/main.go (rssi<10/<20/>=20 из 0-31 ~= pct 32%/64%).
ni=$(atcmd net-info-json 2>/dev/null)
pct=$(printf '%s' "$ni" | jsonfilter -e '@.signal_pct' 2>/dev/null)
case "$pct" in ''|*[!0-9]*) pct=0 ;; esac

n=0
if [ "$pct" -ge 65 ] 2>/dev/null; then n=3
elif [ "$pct" -ge 33 ] 2>/dev/null; then n=2
elif [ "$pct" -gt 0 ] 2>/dev/null; then n=1
fi

i=1
for p in /sys/class/leds/white:signal1/brightness /sys/class/leds/white:signal2/brightness /sys/class/leds/white:signal3/brightness; do
	if [ "$i" -le "$n" ]; then echo 1 > "$p" 2>/dev/null; else echo 0 > "$p" 2>/dev/null; fi
	i=$((i + 1))
done
echo "{\"ok\":true,\"signal_pct\":${pct}}"
