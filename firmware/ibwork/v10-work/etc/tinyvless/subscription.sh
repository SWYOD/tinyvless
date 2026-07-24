#!/bin/sh
# Парсинг VLESS-подписок (base64/plain). Оставляет только WS+TLS (tinyvless LT300).
set -eu

json_esc() {
	printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

url_ok() {
	case "$1" in
		http://*|https://*) return 0 ;;
		*) return 1 ;;
	esac
}

link_name() {
	_l="$1"
	frag="${_l#*#}"
	if [ "$frag" != "$_l" ] && [ -n "$frag" ]; then
		printf '%b' "$(printf '%s' "$frag" | sed 's/+/ /g; s/%\([0-9a-fA-F][0-9a-fA-F]\)/\\x\1/g')" | head -c 120
		return
	fi
	host=$(printf '%s' "$_l" | sed -n 's#^vless://[^@]*@\([^:/?#]*\).*#\1#p')
	[ -n "$host" ] && printf '%s' "$host" || printf 'VLESS'
}

link_supported() {
	_l="$1"
	echo "$_l" | grep -qi '^vless://' || return 1
	q=$(printf '%s' "$_l" | sed -n 's#^[^?]*?\([^#]*\).*#\1#p')
	type=$(printf '%s' "$q" | tr '&' '\n' | sed -n 's/^type=\([^&]*\).*/\1/ip' | head -1)
	sec=$(printf '%s' "$q" | tr '&' '\n' | sed -n 's/^security=\([^&]*\).*/\1/ip' | head -1)
	[ "${type:-tcp}" = "ws" ] || return 1
	[ "${sec:-none}" = "tls" ] || return 1
	echo "$q" | grep -qi 'reality\|xtls\|vision' && return 1
	return 0
}

sub_title() {
	_u="$1"
	base=$(printf '%s' "$_u" | sed 's#/$##')
	host=$(printf '%s' "$base" | sed -n 's#^[a-zA-Z]*://\([^/?#]*\).*#\1#p')
	path=$(printf '%s' "$base" | sed -n 's#^[a-zA-Z]*://[^/?#]*/\([^/?#]*\).*#\1#p')
	if [ -n "$path" ] && [ "$path" != "$host" ]; then
		printf '%s / %s' "$host" "$path"
	elif [ -n "$host" ]; then
		printf '%s' "$host"
	else
		printf 'Подписка'
	fi
}

split_vless_lines() {
	_f="$1"
	_tmp="${_f}.split"
	sed 's/vless:/\n&/g' "$_f" | tr '\r' '\n' | grep '^vless://' >"$_tmp" && mv "$_tmp" "$_f"
}

fetch_sub() {
	url="$1"
	tmp=$(mktemp)
	lines=$(mktemp)
	errtmp=$(mktemp)
	trap 'rm -f "$tmp" "$lines" "$errtmp"' EXIT INT HUP
	# 20с curl + 15с wget-фолбэк (не 45+45=90с, как было) — при реально недоступном хосте
	# пользователь раньше упирался почти в 2 минуты ожидания ради невнятной ошибки. wget тут
	# страховка на случай самого curl, а не второй полноценный таймаут той же длины.
	if ! curl -fsSL --max-time 20 -A 'tinyvless/1.0' "$url" >"$tmp" 2>"$errtmp"; then
		curl_err=$(tail -1 "$errtmp" 2>/dev/null)
		if ! wget -q -T 15 -O "$tmp" "$url" 2>/dev/null; then
			reason="сервер не отвечает"
			case "$curl_err" in
				*'Could not resolve host'*) reason="не удалось определить адрес сервера (DNS)" ;;
				*'Connection timed out'*|*'Timeout was reached'*|*'Connection timeout'*) reason="сервер не отвечает (таймаут соединения)" ;;
				*'Connection refused'*) reason="сервер отклонил соединение" ;;
				*'SSL'*|*'certificate'*) reason="проблема с TLS-сертификатом сервера" ;;
			esac
			echo "{\"ok\":false,\"error\":\"не удалось загрузить подписку: $(json_esc "$reason")\"}"
			exit 0
		fi
	fi
	raw=$(cat "$tmp")
	if echo "$raw" | grep -q 'vless://'; then
		printf '%s' "$raw" | tr '\r' '\n' >"$lines"
	else
		b64=$(printf '%s' "$raw" | tr -d '\r\n \t')
		if command -v base64 >/dev/null 2>&1; then
			printf '%s' "$b64" | base64 -d >"$lines" 2>/dev/null || : >"$lines"
		else
			printf '%s\n' "$b64" | awk '
BEGIN {
	split("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/", b, "")
	for (i = 1; i <= 64; i++) B[b[i]] = i - 1
}
function dec(s, o, i, a, b, c, d, n) {
	gsub(/[\r\n \t=]/, "", s); n = length(s); o = ""
	for (i = 1; i <= n; i += 4) {
		a = B[substr(s, i, 1)]; b = B[substr(s, i + 1, 1)]
		c = B[substr(s, i + 2, 1)]; d = B[substr(s, i + 3, 1)]
		o = o sprintf("%c", a * 4 + int(b / 16))
		if (i + 2 <= n) o = o sprintf("%c", (b % 16) * 16 + int(c / 4))
		if (i + 3 <= n && substr(s, i + 3, 1) != "") o = o sprintf("%c", (c % 4) * 64 + d)
	}
	return o
}
{ print dec($0) }' >"$lines" 2>/dev/null || : >"$lines"
		fi
		split_vless_lines "$lines"
	fi
	total=0
	skipped=0
	first=1
	title=$(sub_title "$url")
	printf '{'
	printf '"ok":true,'
	printf '"name":"%s",' "$(json_esc "$title")"
	printf '"url":"%s",' "$(json_esc "$url")"
	printf '"profiles":['
	while IFS= read -r line; do
		line=$(printf '%s' "$line" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
		[ -z "$line" ] && continue
		case "$line" in vless://*) ;; *) continue ;; esac
		total=$((total + 1))
		if ! link_supported "$line"; then
			skipped=$((skipped + 1))
			continue
		fi
		nm=$(link_name "$line")
		[ "$first" -eq 0 ] && printf ','
		first=0
		printf '{"name":"%s","link":"%s"}' "$(json_esc "$nm")" "$(json_esc "$line")"
	done <"$lines"
	printf '],'
	printf '"total":%s,' "$total"
	printf '"skipped":%s' "$skipped"
	printf '}'
}

case "${1:-}" in
	fetch)
		[ -n "${2:-}" ] || { echo '{"ok":false,"error":"no url"}'; exit 0; }
		url_ok "$2" || { echo '{"ok":false,"error":"нужен http(s) URL"}'; exit 0; }
		fetch_sub "$2"
		;;
	*)
		echo '{"ok":false,"error":"usage: subscription.sh fetch URL"}'
		;;
esac
