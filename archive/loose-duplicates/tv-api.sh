#!/bin/sh
# бэкенд для LuCI-морды tinyvless
case "$1" in
	status) wget -q -O - -T 3 'http://127.0.0.1:19999/status' 2>/dev/null ;;
	apply)  setsid /etc/init.d/tinyvless restart >/dev/null 2>&1 </dev/null & echo '{"ok":true}' ;;
	*)      echo '{"error":"unknown"}' ;;
esac
