# V10 MagnumOpus

Отдельная ветка overlay на базе v9-work.

## Новое

- **`/tinyvless/microtun/`** — микротюнинг (DNS, порты, nfqws, UDP, system, read-only binary limits)
- **Селективный UDP** — переключатель на главной + домены в микротюнинге
- **Клиенты LAN** — per-MAC bypass (без проксирования)
- **IPv6** — filter_aaaa в dnsmasq + disable на всех интерфейсах

## Сборка

```bash
./build-image-v10-magnumopus.sh
```

## Деплой на живой роутер

```bash
# с Mac, раздача v10-work на :8002
./deploy-to-router.sh 192.168.10.102 8002
```
