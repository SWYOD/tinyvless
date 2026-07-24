#!/bin/bash
# Push a local script to the router and run it, working around two router quirks:
#   1. busybox here has no base64/openssl/uuencode, so inline-encoding into an SSH
#      command line isn't possible.
#   2. macOS's modern scp defaults to the SFTP subsystem, which this router's dropbear
#      sshd doesn't speak ("subsystem request failed") — force the legacy protocol with -O.
#
# Usage: push_and_run.sh <local_script> [remote_path] [router_ip]
# Requires the same expect-driven password prompt as scripts/rssh.exp in the project root
# (edit ROUTER_PW below if it differs from that project's router).

set -euo pipefail

LOCAL_SCRIPT="$1"
REMOTE_PATH="${2:-/tmp/$(basename "$LOCAL_SCRIPT")}"
ROUTER_IP="${3:-192.168.10.1}"
ROUTER_PW="${ROUTER_PW:?set ROUTER_PW env var (e.g. source scripts/rssh.local.env) before running}"

SCP_EXP=$(mktemp)
trap 'rm -f "$SCP_EXP"' EXIT

cat > "$SCP_EXP" <<'EOF'
#!/usr/bin/expect -f
set pw [lindex $argv 0]
set src [lindex $argv 1]
set dst [lindex $argv 2]
set timeout 20
spawn scp -O -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null $src $dst
expect -re {[Pp]assword:}
send "$pw\r"
expect eof
catch wait result
exit [lindex $result 3]
EOF
chmod +x "$SCP_EXP"

"$SCP_EXP" "$ROUTER_PW" "$LOCAL_SCRIPT" "root@${ROUTER_IP}:${REMOTE_PATH}"

RUN_EXP=$(mktemp)
trap 'rm -f "$SCP_EXP" "$RUN_EXP"' EXIT
cat > "$RUN_EXP" <<'EOF'
#!/usr/bin/expect -f
set pw [lindex $argv 0]
set ip [lindex $argv 1]
set cmd [lindex $argv 2]
set timeout 90
spawn ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null root@$ip $cmd
expect -re {[Pp]assword:}
send "$pw\r"
expect eof
catch wait result
exit [lindex $result 3]
EOF
chmod +x "$RUN_EXP"

"$RUN_EXP" "$ROUTER_PW" "$ROUTER_IP" "chmod +x ${REMOTE_PATH} && sh ${REMOTE_PATH}"
