# Stability bundle v9-cursor (2026-07-08)

## Сверка с памятью проекта — что НЕ трогаем

| Правило памяти | Наш bundle |
|---|---|
| RU_SET=1 (не 0) | ✅ сохранён |
| cachesize только через UCI | ✅ 250 через uci/deploy |
| nice -n 10 на tinyvless | ✅ init.d без изменений |
| single-Write writeFrame, sync.Pool | ✅ сохранены |
| dialSem 64 душил спидтесты | ✅ ставим **72**, не 64 |
| dnsmasq cachesize 300 = 0 OOM в 33-мин тесте | ⚠️ 250 — компромисс под марафон (не 100) |
| filter-aaaa | ❌ не используем (crash dnsmasq) |
| RU_SET=0 experiment | ❌ не повторяем |
| mega-nftset одной строкой | ❌ построчно + supplement |
| прошивка образа | ❌ только overlay + бинарник |

## Overlay (v9-work)

| Изменение | Файл |
|---|---|
| nftset `/4#` (IPv4 only) | `domains.sh` |
| supplement 9 доменов (VK, Yandex sub, Ozon) | `direct_domains_supplement.list` |
| watchdog flock singleton | `dns-watchdog.sh` |
| cachesize=250 | `uci-defaults`, deploy |
| poll /status 8с | `app4.js` |

## Бинарник tinyvless-stability

| Параметр | perf (было) | stability |
|---|---|---|
| dialSem | 96 | **72** |
| poolBufSize | 16K | **8K** |
| tlsSessionCache | 256 | **128** (64 сомнительно — один сервер) |
| SetMemoryLimit | 30M | **22M** |
| SetGCPercent | 50 | 50 |
| GODEBUG=asyncpreemptoff=1 | да | да |

Артефакт: `bin/tinyvless-stability-20260708` + `.md5` + `MANIFEST.txt`

Откат: `/usr/bin/tinyvless.perf.bak` (сохраняется при деплое)

## Деплой бинарника (память)

1. wget → `/usr/bin/tinyvless.new`
2. md5 сверка
3. `mv` атомарно, timeout ≥90с

## Ожидаемый эффект

- Меньше kernel OOM tinyvless на марафоне (Telegram/Instagram/YouTube)
- Всплеск соединений ждёт слот 8с вместо накопления 96×буфер
- Ozon direct (185.73.x вне ru_cidr)
- −~0.5МБ dnsmasq → headroom для tinyvless
