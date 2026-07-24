# tinyvless v9-work — рабочая копия overlay

> **Важно:** канонические файлы в `firmware/ibwork/files/` **не трогаем**.
> Вся доработка идёт здесь. После подтверждения юзером — перенос в `files/`.

## Ключевой фикс (2026-07-08)

**Проблема «работал только ya.ru»:** на роутере была **одна mega-строка** `nftset=/dom1/dom2/.../ip#` (46 доменов).
dnsmasq при резолве одного «плохого» домена спамит `Name has no usable address` → сет `direct_domains` не заполняется →
весь RU-трафик (кроме случайных попаданий) идёт в туннель → OOM tinyvless.

**Фикс в `domains.sh`:** `build_nftset()` — **построчно** (`nftset=/domain/ip#...` на каждый домен).

**Magnum Opus (промпт v9):** `RU_SET=1`, `cachesize=300` через UCI, DoH smart (https-dns-proxy OFF при пустом poisoned),
`2ip.ru` **НЕ** в direct (speedtest через туннель).

## Стабильность

| Изменение | Зачем |
|---|---|
| `build_nftset` построчно | убрать dnsmasq nftset spam |
| `RU_SET=1` | RU через ru_cidr, не только 47 доменов |
| `cachesize=300` (UCI) | подтверждено 33-мин тестом, 0 OOM |
| `sync_doh_proxy` OFF в smart | −1–2.5 МБ RAM когда poisoned пуст |
| `init.d/tinyvless` nice -n 10 | WiFi nl80211 не конкурирует с туннелем |
| poll /status 8с (было 3с) | меньше нагрузка при открытой панели |
| deploy: apply-route, не restart | не рвём :1082 на 25с |

Подробнее: [STABILITY.md](./STABILITY.md)

## Деплой

```bash
# Терминал 1
cd ~/cudy-lt300-build/firmware/ibwork/v9-work
python3 -m http.server 8000

# Терминал 2 (IP Mac в LAN роутера)
./deploy-to-router.sh 192.168.10.102
```

**Не деплоить пока юзер активно тестирует трафиком** — параллельная нагрузка = OOM.

## Проверка после деплоя

```bash
~/cudy-lt300-build/scripts/rssh.exp "grep -c '^nftset=' /etc/dnsmasq.conf; grep RU_SET /etc/tinyvless/config | tail -1"
# Ожидаем: ~46 nftset строк, RU_SET=1

~/cudy-lt300-build/scripts/rssh.exp "nslookup google.com 127.0.0.1; curl -s --max-time 5 http://127.0.0.1:19999/status"
```
