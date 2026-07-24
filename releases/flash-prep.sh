#!/bin/sh
/etc/init.d/tinyvless stop
sleep 2
rm -f /tmp/fw.bin
wget -q -O /tmp/fw.bin "http://192.168.10.102:8001/lt300-tinyvless-v8-doh-20260707.bin"
{
  echo "size=$(wc -c </tmp/fw.bin)"
  echo "sha=$(sha256sum /tmp/fw.bin | cut -d' ' -f1)"
  echo "exp=66189937c13759a88b8e6be07267cd8f1ecd9a6446af17a5e07ada1776aabe73"
  echo "DONE"
} > /tmp/flashstatus.txt 2>&1
