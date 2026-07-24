#!/bin/sh
# Агрегация ru_cidr.nft (8626) → ru_cidr_compact.nft (~2799 /18-блоков).
# 2026-07-11: понижено с /16 (1109 записей) до /18 (2799) — /18-блок в 4 раза уже /16, то есть
# в 4 раза меньше шанс, что чужой (не-RU) IP по ошибке попадёт в тот же блок что и RU-подсеть
# и уйдёт напрямую мимо туннеля. RAM на роутере сейчас с запасом (14.7МБ свободно) — можно
# позволить точность выше без риска. Сравнение уровней (реальные цифры, 2026-07-10):
#   без огрубления (natural merge): 8626 (0% выигрыша — оказалось, естественных пересечений почти нет)
#   /22: 7605  /20: 5305  /18: 2799 (выбрано)  /16: 1109 (было)
set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"
SRC="$ROOT/../../../firmware/ibwork/files/etc/tinyvless/ru_cidr.nft"
OUT="$ROOT/etc/tinyvless"
python3 - "$SRC" "$OUT" << 'PY'
import re, ipaddress, sys
src, out = sys.argv[1], sys.argv[2]
text = open(src).read()
m = re.search(r'elements\s*=\s*\{([^}]+)\}', text, re.S)
nets = []
for part in re.split(r',[\s\n]+', m.group(1).strip()):
    part = part.strip().rstrip(',')
    if not part:
        continue
    if '-' in part and '/' not in part:
        a, b = part.split('-', 1)
        nets.append(ipaddress.ip_network(f"{a.strip()}-{b.strip()}", strict=False))
    else:
        nets.append(ipaddress.ip_network(part, strict=False))
ROUND_TO = 18
super_n = {ipaddress.ip_network(f"{n.network_address}/{ROUND_TO}", strict=False) if n.prefixlen >= ROUND_TO else n for n in nets}
final = sorted(ipaddress.collapse_addresses(list(super_n)), key=lambda x: int(x.network_address))

def fmt(n):
    return str(n.network_address) if n.prefixlen == 32 else str(n)

lines = []
for i in range(0, len(final), 8):
    chunk = final[i:i + 8]
    lines.append('\t\t\t     ' + ', '.join(fmt(n) for n in chunk) + (',' if i + 8 < len(final) else ''))
body = '\n'.join(lines)
nft = f"""table ip tinyvless {{
\tset ru_cidr {{
\t\ttype ipv4_addr
\t\tflags interval
\t\tauto-merge
\t\telements = {{ {body}
\t\t}}
\t}}
}}
"""
open(f"{out}/ru_cidr_compact.nft", 'w').write(nft)
open(f"{out}/ru_cidr.meta", 'w').write(str(len(final)) + '\n')
print(f"compact: {len(final)} subnets")
PY
