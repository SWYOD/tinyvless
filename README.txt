tinyvless — походный VLESS-роутер на Cudy LT300 v3.0 (OpenWrt 25.12.5, ramips/mt76x8, 16МБ flash, 58МБ RAM)

Структура проекта:
  src/tinyvless/   — исходники Go-клиента (VLESS+WS+TLS, REDIRECT/TPROXY inbound, LuCI status API)
  src/tvled/       — исходники LED-демона (3 задних индикатора сигнала LTE, AT+CSQ)
  firmware/ibwork/ — ImageBuilder + files/ (КАНОНИЧЕСКИЙ источник для прошивки — всё что попадает
                     в /etc, /usr, /www, /opt роутера лежит здесь; ib/build.sh собирает образ)
  releases/        — собранные прошивки (.bin + .manifest), пронумерованы по версиям v1..v8
  scripts/         — rssh.exp (SSH-обёртка с паролем для доступа к роутеру)
  reference/zapret/— скачанные upstream-артефакты remittor/zapret-openwrt (для справки/апдейта стратегий)
  archive/         — устаревшее (sing-box-эпоха, старые тестовые конфиги, дубликаты, ранние сборки
                     прошивки вне releases/) — сохранено на всякий случай, не используется

Сборка образа:
  cd firmware/ibwork
  docker run --rm -v "$(pwd)/ib:/ib:ro" -v "$(pwd)/files:/files:ro" -v "$(pwd)/out:/out" \
    debian:bookworm bash /ib/build.sh

Доступ к роутеру:
  ./scripts/rssh.exp "<команда>" [таймаут-сек]   (пароль зашит, root@192.168.10.1)

Текущее состояние и история решений — см. память проекта (cudy-lt300-vless-router.md).
