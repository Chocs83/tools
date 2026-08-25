#!/usr/bin/env python3
"""Tell a Google Chat space which wifi this headless box joined, and at what IP.

The box has no screen.  On the office wifi it takes a DHCP address nobody can
predict, and a static lease is not ours to set there -- so after every network
change the address is unknown until it announces itself.

mDNS was tried first and is not good enough here:
  - it is link-local, so it only answers when the laptop is on the SAME network;
    the moment the CM4 moved to the office wifi and the laptop stayed on the
    phone hotspot, the name stopped resolving
  - the ISP hijacks unknown names, so `monolith-isg.local` resolved to a public
    ad server (218.38.137.28) instead of failing honestly

A webhook POST has neither problem: it goes outbound to the internet, so it
works from any network that has a route, and it arrives somewhere the phone can
read.

Install with setup_cm4.sh in this directory.  Driven by a NetworkManager
dispatcher hook, so it fires on boot and on every reconnect -- a systemd oneshot
ordered after network-online.target reports once and misses every later change.

    wifi_report.py            # post the current state
    wifi_report.py --dry-run  # print what would be posted, send nothing
    wifi_report.py --test     # post a "test" message now
"""
import argparse
import json
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request

CONF = "/etc/wifi_report.conf"          # one line: WEBHOOK=https://chat.googleapis.com/...
TIMEOUT = 12
RETRIES = 6                              # DNS/route often are not up yet on the
RETRY_WAIT = 5                           # first dispatcher call after a change


def sh(cmd):
    try:
        return subprocess.run(cmd, shell=True, capture_output=True, text=True,
                              timeout=10).stdout.strip()
    except Exception:                                            # noqa: BLE001
        return ""


def webhook():
    """Read the URL from a root-only file.

    Deliberately NOT in this script or in git: it is a bearer credential -- any
    holder can post into the space.
    """
    env = os.environ.get("WIFI_REPORT_WEBHOOK", "").strip()
    if env:
        return env
    try:
        for line in open(CONF):
            line = line.strip()
            if line.startswith("WEBHOOK="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    except OSError:
        pass
    return ""


def state():
    """What we know about the current connection."""
    ssid = ""
    for line in sh("nmcli -t -f ACTIVE,SSID,SIGNAL,FREQ dev wifi").splitlines():
        if line.startswith("yes:"):
            p = line.split(":")
            ssid = p[1] if len(p) > 1 else ""
            sig = p[2] if len(p) > 2 else "?"
            freq = p[3] if len(p) > 3 else "?"
            break
    else:
        sig = freq = "?"
    prof = ""
    for line in sh("nmcli -t -f NAME,DEVICE,STATE con show --active").splitlines():
        f = line.split(":")
        if len(f) > 1 and f[1].startswith("wl"):
            prof = f[0]
            break
    ips = [a for a in sh("hostname -I").split() if ":" not in a]
    gw = sh("ip route | awk '/^default/{print $3; exit}'")
    return dict(host=socket.gethostname(), ssid=ssid, signal=sig, freq=freq,
                profile=prof, ips=ips, gw=gw,
                boot=sh("uptime -s"), now=time.strftime("%Y-%m-%d %H:%M:%S"))


def message(s, tag=""):
    ip = s["ips"][0] if s["ips"] else "(no IPv4)"
    head = f"*{s['host']}*{' — ' + tag if tag else ''}"
    return (f"{head}\n"
            f"wifi: `{s['ssid'] or '(none)'}`  ({s['signal']}%, {s['freq']})\n"
            f"ip: `{ip}`   gw: `{s['gw'] or '?'}`\n"
            f"ssh: `ssh {os.environ.get('SUDO_USER') or 'monolith'}@{ip}`\n"
            f"profile: {s['profile'] or '?'}   booted {s['boot']}   ({s['now']})")


def post(url, text):
    body = json.dumps({"text": text}).encode()
    req = urllib.request.Request(url, data=body, method="POST",
                                 headers={"Content-Type": "application/json; charset=UTF-8"})
    last = ""
    for i in range(RETRIES):
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                return True, f"HTTP {r.status}"
        except urllib.error.HTTPError as e:
            # 4xx will not fix itself by waiting -- a bad or revoked webhook
            return False, f"HTTP {e.code}: {e.read()[:200].decode(errors='replace')}"
        except Exception as e:                                    # noqa: BLE001
            last = str(e)
            if i < RETRIES - 1:
                time.sleep(RETRY_WAIT)
    return False, f"gave up after {RETRIES} tries: {last}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--test", action="store_true")
    ap.add_argument("--tag", default="")
    args = ap.parse_args()

    s = state()
    tag = args.tag or ("test" if args.test else "")
    text = message(s, tag)

    if args.dry_run:
        print(text)
        print(f"\nwebhook: {'set' if webhook() else 'NOT SET -- see ' + CONF}")
        return 0

    if not s["ips"] and not args.test:
        print("no IPv4 yet, nothing worth reporting")
        return 1

    url = webhook()
    if not url:
        print(f"no webhook configured. Put one line in {CONF}:\n"
              f'  WEBHOOK=https://chat.googleapis.com/v1/spaces/.../messages?key=...&token=...',
              file=sys.stderr)
        return 2

    ok, info = post(url, text)
    print(("sent: " if ok else "FAILED: ") + info)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
