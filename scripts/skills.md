# Диагностические скиллы — Cudy LT300 tinyvless

Переиспользуемые одностроч ные команды через `scripts/rssh.exp '<cmd>' [timeout]`. Каждая
даёт максимум сигнала за один SSH round-trip — не собирать эти данные вручную по кускам.

Вызов из корня проекта:
```
/Users/ilyatrubnikov/cudy-lt300-build/scripts/rssh.exp '<SKILL-команда>' <timeout>
```

---

## snapshot
Общее здоровье системы: uptime, память, признаки OOM/краша в логе, живость ключевых процессов.
```sh
echo "up=$(cut -d. -f1 /proc/uptime)s load=$(cut -d' ' -f1 /proc/loadavg)"; free -m; echo "---oom/crash (последние)---"; logread 2>/dev/null | grep -iE 'out of memory|invoked oom|crash' | tail -6; echo "---procs---"; echo "tv=$(pidof tinyvless|wc -w) dnsmasq=$(pidof dnsmasq|wc -w) hostapd=$(pidof hostapd|wc -w) hdp=$(pidof https-dns-proxy|wc -w) tvled=$(pidof tvled|wc -w) nfqws=$(pidof nfqws||echo none)"
```

## dns-check
DNS отвечает корректно (не завис, не отравлен)?
```sh
for d in google.com instagram.com yandex.ru im.vk.com; do echo "=== $d ==="; nslookup $d 127.0.0.1 2>&1 | grep -E '^Name|^Address' | grep -v ':53'; done
```

## nft-state
Цепочки на месте, нет мусора от zapret.
```sh
nft list ruleset 2>/dev/null | grep -E 'table|chain |redirect|tproxy|out_doh|zapret' | head -40
```

## wifi-state
AP жива, не disabled, есть клиенты.
```sh
iwinfo 2>/dev/null | grep -E 'ESSID|Signal|Mode|Bitrate'; echo "---uci---"; uci show wireless 2>/dev/null | grep -E 'ssid|disabled|encryption'
```

## dhcp-state
DHCP выдаёт аренды (частая причина WiFi-дропов — dnsmasq тоже DHCP-сервер).
```sh
cat /tmp/dhcp.leases 2>/dev/null; echo "---logread dhcp---"; logread 2>/dev/null | grep -i dhcp | tail -15
```

## doh-verify
DoH-резолвер жив и слушает, туннель для него настроен.
```sh
netstat -ln 2>/dev/null | grep :5053; echo "---hdp pid---"; pidof https-dns-proxy
```

## overlay-audit
Что реально отличается от заводского /rom (не полагаться на память — смотреть факт).
```sh
diff -rq /rom/etc /etc 2>/dev/null | grep -v 'Only in /rom' | head -30
```

## ram-pressure
Детальная память, когда snapshot показал тревогу.
```sh
cat /proc/meminfo | grep -E 'MemFree|Buffers|Cached|MemTotal|SwapTotal'
```

## tunnel-health
Туннель жив, слушает, статус-API отвечает.
```sh
pidof tinyvless; netstat -ln 2>/dev/null | grep -E ':1082|:1083'; wget -q -O - -T3 http://127.0.0.1:19999/status 2>&1
```

---

## Правила использования
- Каждый скилл — ОДИН вызов rssh.exp, не дробить на несколько SSH-сессий ради одного скилла.
- `pidof`, никогда `pgrep -f` (ложно матчит собственный shell — грабли этой сессии).
- Таймаут rssh.exp: 20-25с для одиночных скиллов, 30с если skill содержит несколько for-циклов (dns-check).
- Если вывод пустой при первой попытке — НЕ считать провалом сразу: SSH-сессия в этой среде периодически отдаёт пустой результат при живом роутере (подтверждено пингом). Один повтор — это ещё диагностика, не лишняя трата.
