#!/bin/sh
# Агрегация ru_cidr.nft (8626) → ru_cidr_compact.nft (~1109 /16-блоков).
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
super16 = {ipaddress.ip_network(f"{n.network_address}/16", strict=False) if n.prefixlen >= 16 else n for n in nets}
final = sorted(ipaddress.collapse_addresses(list(super16)), key=lambda x: int(x.network_address))

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
