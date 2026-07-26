#!/bin/sh
# led-blink-shutdown.sh — попеременное мигание переднего LED (белый/красный) как визуальное
# подтверждение начала выключения/перезагрузки. Запускается в фоне из api.sh poweroff/reboot,
# отдельного завершения не требует — процесс убьётся вместе со всей системой при реальном
# halt/reboot. Целые секунды — busybox sleep на этой прошивке дробные не понимает.
W=/sys/class/leds/white:status/brightness
R=/sys/class/leds/red:status/brightness
while true; do
	echo 1 > "$W" 2>/dev/null; echo 0 > "$R" 2>/dev/null
	sleep 1
	echo 0 > "$W" 2>/dev/null; echo 1 > "$R" 2>/dev/null
	sleep 1
done
