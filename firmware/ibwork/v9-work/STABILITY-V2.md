# Stability v2 — анализ и артефакты (2026-07-08)

> Отдельный документ для сравнения профилей. Бинарники и md5 — в `bin/` и `releases/bin/`.

## Зачем v2

После stability v1 (`dialSem=72`, `pool=8K`):
- ✅ Telegram, Ozon, Google, VK — марафон без OOM **tinyvless**
- ⚠️ YouTube MacBook 10–20 мин → подтормаживание → **ребут роутера** (kernel OOM)
- ⚠️ `active=72/72` — все слоты dialSem заняты (googlevideo параллельные потоки)
- ⚠️ Ранее: `cachesize=250` убил **dnsmasq**; вернули **300**

## Сравнение профилей

| Параметр | perf (v5) | stability v1 | **stability v2** |
|---|---|---|---|
| dialSem | 96 | 72 | **64** |
| poolBufSize | 16K | 8K | **4K** |
| tlsSessionCache | 256 | 128 | 128 |
| SetMemoryLimit | 30M | 22M | **18M** |
| dnsmasq cachesize (UCI) | 300 | 300 | 300 |
| dns-forward-max | 100 | 100 | **50** |
| nice -n 10 | да | да | да |
| RU_SET | 1 | 1 | 1 |
| supplement nftset /4# | — | 9 доменов | 9 доменов |

## Теоретический потолок RAM (burst)

Грубая оценка пика буферов туннеля:
- perf: 96 × 16K ≈ 1.5M только copy pool (теор. max)
- v1: 72 × 8K ≈ 576K
- **v2: 64 × 4K ≈ 256K**

+ Go heap, TLS, ru_cidr 2.4M, dnsmasq 2–8M, OpenWrt ~15M → **58M total**.

## Что НЕ меняли (память проекта)

- ❌ RU_SET=0 — ломает RU routing
- ❌ cachesize < 300 — OOM dnsmasq
- ❌ filter-aaaa — crash dnsmasq
- ❌ zapret — RAM+CPU
- ❌ прошивка образа — feedback-no-build

## Артефакты

```
firmware/ibwork/v9-work/bin/tinyvless-stability-v2-20260708
firmware/ibwork/v9-work/bin/tinyvless-stability-v2-20260708.md5
firmware/ibwork/v9-work/bin/MANIFEST-v2.txt

releases/bin/tinyvless-stability-v2-20260708*   ← архивная копия

# v1 сохранён:
firmware/ibwork/v9-work/bin/tinyvless-stability-20260708*
releases/bin/tinyvless-stability-20260708*
```

## Откат на роутере

```bash
# v1 stability
cp /usr/bin/tinyvless.stability-v1.bak /usr/bin/tinyvless
/etc/init.d/tinyvless restart

# perf (до stability)
cp /usr/bin/tinyvless.perf.bak /usr/bin/tinyvless
/etc/init.d/tinyvless restart
```

При деплое v2: текущий бинарник сохраняется в `/usr/bin/tinyvless.stability-v1.bak`.

## Ожидаемый trade-off

| | v1 | v2 |
|---|---|---|
| YouTube марафон Mac | ребут | **цель: без ребута** |
| 2ip upload | ~7↑ | возможно 5–6↑ |
| Burst (Instagram reels) | быстрее | чуть медленнее, стабильнее |
| Telegram long session | ✅ | ✅ (цель) |

## Деплой v2 (2026-07-08)

**Overlay flash 89% full (732K free)** — wget напрямую в `/usr/bin/tinyvless.new` падает с `No space left on device`.

Паттерн установки:
```bash
/etc/init.d/tinyvless stop
wget -O /tmp/tinyvless.new http://MAC:8000/bin/tinyvless-stability-v2-20260708
md5sum /tmp/tinyvless.new   # ожидаем bb26d8816bfb6d5c2d5a9c1882dcb3ba
mv /tmp/tinyvless.new /usr/bin/tinyvless   # in-place replace
/etc/init.d/tinyvless start
```

На роутере **нет** `tinyvless.stability-v1.bak` — overlay не влезает. v1 сохранён на Mac в `bin/` и `releases/bin/`.

**Установлено:** md5 `bb26d8816bfb6d5c2d5a9c1882dcb3ba`, `dns-forward-max=50`, tunnel `running:true`.

1. **5 мин YouTube 480p** с Mac — без панели `/tinyvless`
2. **15 мин YouTube** — главный критерий (v1 → ребут)
3. Telegram параллельно — refresh если завис
4. `logread | grep OOM` после теста
5. `/status` → `active` не должен стоять 64/64 постоянно

## История инцидентов (контекст)

| Время | Событие |
|---|---|
| 10:36, 10:44 | OOM tinyvless — до stability v1 |
| 11:17 | OOM dnsmasq (cachesize=250) → YouTube/IG |
| ~12:00 | YouTube Mac марафон → **ребут** — motivator v2 |
