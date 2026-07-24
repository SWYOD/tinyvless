---
name: tinyvless-qa
description: Deep functional and stability QA methodology for the tinyvless / MagnumOpusPlus router panel on the Cudy LT300 (OpenWrt, mipsel, 16MB flash / 58MB RAM). Use this whenever the user asks to test, verify, QA, or "check if everything still works" on the router or panel — after a firmware change, before a release, or just to audit current stability. Also use it whenever the user asks for a deep/thorough test that goes beyond reading state (i.e. they want settings actually changed and verified, real traffic measured, or panel blocks exercised end-to-end), not just a health check. Covers: mutation-testing every settings toggle via the real CGI path, real-traffic speedtest with CPU/RAM monitoring, cross-referencing UI-exposed fields against the shell scripts that are supposed to consume them (this is how dead/no-op settings get found), and producing a dashboard-style QA report as a Claude Artifact.
---

# tinyvless QA methodology

This captures how to actually test the tinyvless panel on a live router, not just read its state. The
router (Cudy LT300, OpenWrt 25.12.5, mipsel_24kc, single core @385MHz, 58MB RAM, 16MB flash) is resource-
constrained enough that "does it respond" is not the same question as "does it work" — several real
findings in this project only showed up by mutating a setting and checking the actual system-level effect,
not by reading a JSON response.

## Core loop: mutate → verify → revert

Every settings test follows the same five steps. Skipping straight to "call the API and check `{"ok":true}`"
is exactly what misses bugs — `{"ok":true}` only proves the script didn't crash, not that the setting does
anything (see the `TINYVLESS_NICE` finding below for a case where it lied).

1. **Capture baseline** — read the live value directly from the system (config file, `nft list`, running
   process, PID, whatever the setting is supposed to affect), not from the panel's cached display.
2. **Mutate via the real front-end-equivalent path** — call the actual CGI endpoint the browser would call
   (`curl 'http://127.0.0.1/cgi-bin/tv?a=exec&cmd=...&arg=...'` from on-router, or `.../tv?...` from the
   LAN side), not by editing config files directly. Editing files directly tests the shell script in
   isolation; going through the CGI path tests what the user actually experiences.
3. **Verify the real effect** — go one level below the API response and check the thing the setting is
   supposed to control: `nft list chain/set`, `grep`/`cat` the generated config, `ps`/`/proc/PID/stat` for
   a running process's actual attributes, a re-query of `state`/`clients`/etc.
4. **Revert immediately** to the exact original value.
5. **Re-verify the reversion** the same way you verified the mutation.

Never leave the router in a mutated state between tool calls — if a step fails partway, restore from
whatever backup you took in step 1 before moving on.

## Why cross-referencing UI ↔ shell code matters

The most valuable bug found this way (`TINYVLESS_NICE` in microtuning — editable field, "Apply" returns
`ok:true`, but `/etc/init.d/tinyvless` hardcodes `nice -n 10` and never reads the config value at all) was
not found by calling the API. It was found by:
1. Noticing the field exists in the UI (`grep` the `.js` view files for the config key).
2. Finding where the backing shell script is supposed to consume that key (`grep` `api.sh` /
   `microtun-apply.sh` / `init.d` scripts for the same key name).
3. If the consuming code doesn't actually reference it (or references a different hardcoded value),
   mutate the field for real and check the live process/system state — don't trust the `{"ok":true}`.

Whenever you add a new settings test, do this grep-both-sides check first. It's cheap and it's the only way
to catch a control that's wired up in the UI but not the backend (or vice versa).

## Endpoint inventory

Everything below is dispatched through `/etc/tinyvless/api.sh`'s `case` statement via
`http://127.0.0.1/cgi-bin/tv?a=exec&cmd=<action>&...`. Two separate CGI scripts exist outside that
dispatcher: `/www/cgi-bin/sms` and `/www/cgi-bin/backup` (plus LuCI's stock `cgi-io` for generic config
export, symlinked as `cgi-backup`/`cgi-download`/`cgi-upload`/`cgi-exec`).

`api.sh` actions (grep `^\t[a-z_]+\)` in the file to regenerate this list if the script changes):
`apply`, `autostart`, `checkdomain`, `checkreach`, `client_bypass`, `clients`, `dnsapply`, `domains`, `log`,
`microtun_apply`, `microtun_get`, `microtun_reset`, `mode`, `netinfo`, `poweroff`, `reboot`, `restart`,
`speedtest_dl_chunk`, `speedtest_ping`, `speedtest_ul_chunk`, `start`, `state`, `status`, `stop`,
`subscription_fetch`, `testlink`, `tuning` (sub-keys: `select_level`, `ru_set`, `udp_tunnel`).

For a full pass, work through every action at least once using the mutate→verify→revert loop where the
action changes state, or a simple call+response check where it's read-only. `tuning` bundles multiple
independent sub-settings — test each sub-key separately, they have different code paths (`ru_set`
synchronously calls `ru_cidr_reload.sh` before backgrounding `apply-route.sh`; the others only background).

## Safety exclusions — do not mutate these without explicit fresh authorization

- **SMS deletion on real messages.** The inbox holds the user's actual texts/verification codes. Only test
  the error-handling path (bad index → `{"error":"bad idx"}`), never delete a real message.
- **`reboot` / `poweroff`.** Highly disruptive — `poweroff` ends the session and needs a physical
  power-cycle; `reboot` interrupts all other work. Only test these with explicit per-instance confirmation,
  never as part of a routine sweep.
- **Anything that would drop the SSH session mid-mutation** (e.g. changing `LAN_IF`, WiFi config, or the
  SSH-carrying interface) without a recovery plan.
- General project rule: never build/flash firmware based on this testing alone — a passing QA pass is not
  the same as user confirmation that a release is ready.

## Real-traffic testing (speedtest + CPU/RAM)

`speedtest_ping`/`speedtest_dl_chunk`/`speedtest_ul_chunk` accept `via=tunnel|direct`, a source `url`, a
`type` (`cf` for Cloudflare's `__down`/`__up` endpoints, otherwise generic), and a byte count. Read the
JSON body, not just curl's own timing — the endpoint already returns the *real* transfer time with
DNS/TCP/TLS handshake subtracted out (see the comments in `api.sh` around `speedtest_dl_chunk` for why).
`curl -w '%{size_download}'` on the outer request measures the JSON response size (~44 bytes), not the
actual payload — that's a mistake worth avoiding, made once already in this project.

`direct` mode can legitimately fail with `http:000` / 100% ping loss on domains the network censors at the
DPI/SNI level (confirmed: `speed.cloudflare.com` and `cloudflare.com` are blocked this way on this
connection, while `1.1.1.1` by bare IP and `ya.ru` work fine directly). That is not a bug — it is the
tunnel's entire reason to exist, and makes a great validation point in a report. Before treating a `direct`
failure as a defect, test at least one control host directly (something you know isn't blocked) to confirm
it's not a general WAN outage.

To watch CPU/RAM/stragglers during a real test burst, use `scripts/qa_speedtest.sh` (push it to `/tmp` on
the router — see "Getting scripts onto the router" below, `base64` is not available in busybox here) — it
backgrounds a 1s-interval `/proc/stat` + `free` sampler, runs the tunnel and direct sequences, then prints
the log so you can eyeball the CPU/mem delta across the test window and confirm no leftover child processes.

While testing, also check in the JS (`app4.js`) that the panel's own polling pauses during a speedtest
(`speedBusy` flag) and that the pause-clearing runs in a `.then()` after both success and failure paths —
otherwise a failed speedtest would wedge the panel's regular polling forever. Same idea for the Stop
button: confirm in code (`speedCancelled`) whether cancellation is instant or takes effect between chunks —
document whichever it is rather than assuming.

## Getting scripts onto the router

- SSH command execution: `./scripts/rssh.exp "<command>" [timeout_seconds]` from the project root — a
  password-driven expect wrapper, single command string, avoid embedding literal newlines (busybox `ash`
  chokes on compound `time { }` / multi-line `( ... )` blocks passed this way — keep it to one logical line
  with `;` separators, or push a real script file instead).
- Pushing a whole script: `busybox` on this router has **no `base64`/`openssl`/`uuencode`/`xxd`**, so you
  can't inline-encode a script into an SSH command. Use `scp -O` (legacy protocol — the router's dropbear
  sshd doesn't speak the SFTP subsystem macOS's modern `scp` defaults to) with the same password-expect
  pattern as `rssh.exp`. See `scripts/push_and_run.sh` for both pieces wired together.
- Same credential/host as the rest of this project's router work (`root@192.168.10.1`).

## Reporting

Deep-testing passes should extend the existing QA report, not replace it — the visual style (dashboard
memo, teal accent, dark/light token pairs, `.row`/`.pill`/`.finding` card system) was explicitly approved
by the user and should be reused, not redesigned each time. `references/report-style.css` has the current
token system and component classes lifted from the live report; start a new report from these tokens
before inventing new ones. Publish via the `Artifact` tool using the **same `file_path`** as any prior pass
in this project so the URL stays stable across updates — check recent conversation context or ask before
minting a new one.

Findings get one of three treatments in the report, matching the CSS already in
`references/report-style.css`:
- `.finding.crit` (red) — a real, confirmed defect (e.g. a UI control that doesn't do anything).
- `.finding` default (amber) — a risk or something worth monitoring, not yet a confirmed break (e.g. a
  slow call near a timeout ceiling, a memory delta that isn't conclusively a leak).
- `.finding.info` (accent/teal) — a notable, positive discovery that isn't a problem at all (e.g. the
  direct-mode Cloudflare block that validates why the tunnel matters).

Keep the summary strip honest: if a real defect was found, don't leave a plain green "no problems"
verdict — shift it to reflect what's actually true, the way the existing report does (still calm, still
accurate about nothing crashing, but not overstating cleanliness).
