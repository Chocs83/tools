#!/usr/bin/env bash
# Bring a fresh CM4 to the state we settled on: it tells us where it is.
#
#   ./setup_cm4.sh monolith@192.168.0.77
#   ./setup_cm4.sh monolith@10.0.0.5 --webhook 'https://chat.googleapis.com/v1/spaces/...'
#   ./setup_cm4.sh monolith@... --hostname robot-2 --add-wifi
#
# What it installs
#   /usr/local/bin/wifi_report.py               posts SSID + IP to Google Chat
#   /etc/NetworkManager/dispatcher.d/90-wifi-report   fires it on every change
#   /etc/wifi_report.conf                       the webhook, root-only 600
#   /usr/local/bin/wifi_add.sh                  add a network, priority made visible
#
# Why this exists.  A headless box on DHCP has no discoverable address, and every
# alternative we tried failed for a concrete reason:
#   - mDNS is link-local, so it answers only when the laptop is on the SAME
#     network -- useless the moment the box moves
#   - and the ISP hijacks unknown names, so monolith-isg.local resolved to a
#     public ad server rather than failing honestly
#   - a static IP works on exactly one router.  Ours had 192.168.0.77/22 pinned,
#     which meant that on any other network it associated fine and then could not
#     talk to anything, looking for all the world like "connected, no IP"
# An outbound webhook has none of those failure modes: it works from any network
# with a route, and it arrives on the phone.
#
# Idempotent -- safe to re-run.  It never changes which network the box is on.
set -euo pipefail

TARGET=""
WEBHOOK="${WIFI_REPORT_WEBHOOK:-}"
NEWHOST=""
ADD_WIFI=0
HERE=$(cd "$(dirname "$0")" && pwd)
# Kept outside the repo so it cannot be committed: the URL is a bearer
# credential, and anyone holding it can post into the space.
HOOK_CACHE="$HOME/.config/ceiling_vision/chat_webhook"

usage() {
  sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --webhook)  WEBHOOK=$2; shift 2 ;;
    --hostname) NEWHOST=$2; shift 2 ;;
    --add-wifi) ADD_WIFI=1; shift ;;
    -h|--help)  usage 0 ;;
    -*)         echo "unknown option: $1" >&2; usage 2 ;;
    *)          TARGET=$1; shift ;;
  esac
done
[ -n "$TARGET" ] || { echo "usage: $0 <user@host> [--webhook URL] [--hostname NAME] [--add-wifi]" >&2; exit 2; }

# ---- webhook ---------------------------------------------------------------
if [ -z "$WEBHOOK" ] && [ -r "$HOOK_CACHE" ]; then
  WEBHOOK=$(cat "$HOOK_CACHE")
  echo "== webhook: $HOOK_CACHE 에 저장된 값 사용"
fi
if [ -z "$WEBHOOK" ]; then
  cat <<'EOS'
== Google Chat 웹훅이 필요하다. 만드는 법:
     chat.google.com -> 스페이스 만들기(혼자여도 됨) -> 스페이스 이름 ▾
     -> 앱 및 통합 -> 웹훅 -> 웹훅 추가 -> 이름 입력 -> URL 복사
   메뉴에 '웹훅'이 없으면 Workspace 관리자가 막아둔 것이다.
EOS
  read -rp "웹훅 URL: " WEBHOOK
fi
case "$WEBHOOK" in
  https://chat.googleapis.com/*) : ;;
  *) echo "그건 Google Chat 웹훅 URL 처럼 보이지 않는다. 중단." >&2; exit 2 ;;
esac

echo "== 웹훅 확인 (여기서 한 번 쏴 본다)"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
       -H 'Content-Type: application/json; charset=UTF-8' \
       -d '{"text":"setup_cm4.sh: 웹훅 확인"}' "$WEBHOOK" || echo 000)
if [ "$code" != "200" ]; then
  echo "웹훅이 HTTP $code 를 반환했다. URL 을 다시 확인해라. 중단." >&2
  exit 1
fi
echo "   HTTP 200 -- 스페이스에 메시지가 보일 것이다"
mkdir -p "$(dirname "$HOOK_CACHE")"
umask 077; printf '%s\n' "$WEBHOOK" > "$HOOK_CACHE"

# ---- prerequisites on the target ------------------------------------------
echo "== 대상 점검: $TARGET"
ssh -o ConnectTimeout=10 "$TARGET" 'bash -s' <<'REMOTE'
set -euo pipefail
miss=0
for c in nmcli python3 curl; do
  command -v "$c" >/dev/null || { echo "   없음: $c"; miss=1; }
done
sudo -n true 2>/dev/null || { echo "   sudo 가 비번을 묻는다 -- 무인 설치가 막힌다"; miss=1; }
[ -d /etc/NetworkManager/dispatcher.d ] || { echo "   NetworkManager dispatcher 디렉터리 없음"; miss=1; }
echo "   $(hostname) / $(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME") / $(uname -m)"
exit $miss
REMOTE
echo "   OK"

# ---- push -----------------------------------------------------------------
echo "== 파일 복사"
scp -q "$HERE/wifi_report.py" "$HERE/wifi_add.sh" "$TARGET:/tmp/"

echo "== 웹훅 기록 (/etc/wifi_report.conf, root only)"
# stdin 으로 넘긴다: 인자로 주면 원격 프로세스 목록과 쉘 히스토리에 남는다
printf 'WEBHOOK=%s\n' "$WEBHOOK" \
  | ssh "$TARGET" 'sudo tee /etc/wifi_report.conf >/dev/null && sudo chmod 600 /etc/wifi_report.conf'

NEWHOST_Q=$(printf '%q' "$NEWHOST")
ssh "$TARGET" "NEWHOST=$NEWHOST_Q bash -s" <<'REMOTE'
set -euo pipefail
sudo install -m 755 /tmp/wifi_report.py /usr/local/bin/wifi_report.py
sudo install -m 755 /tmp/wifi_add.sh    /usr/local/bin/wifi_add.sh
rm -f /tmp/wifi_report.py /tmp/wifi_add.sh

if [ -n "${NEWHOST:-}" ] && [ "$NEWHOST" != "$(hostname)" ]; then
  echo "== 호스트명 -> $NEWHOST (챗 메시지에서 어느 기기인지 구분하려면 필요)"
  sudo hostnamectl set-hostname "$NEWHOST"
  sudo sed -i "s/^127.0.1.1.*/127.0.1.1\t$NEWHOST/" /etc/hosts || true
fi

# dispatcher 훅이지 systemd oneshot 이 아니다: 우리가 알고 싶은 사건은 "연결이
# 올라왔다" 이고, 그건 dispatcher 가 부팅 포함해서 매번 알려준다. oneshot 은
# 부팅 때 한 번 쏘고 이후 재접속을 다 놓친다.
sudo tee /etc/NetworkManager/dispatcher.d/90-wifi-report >/dev/null <<'HOOK'
#!/bin/bash
# $1 = interface, $2 = action
# 백그라운드로 떼어낸다: dispatcher 는 훅을 직렬로 돌리고 느린 건 죽이는데,
# DNS 가 자리잡는 동안 전송이 몇 초 걸릴 수 있다.
case "$2" in
  up)
    case "$1" in
      wl*|eth*)
        ( sleep 5; /usr/local/bin/wifi_report.py --tag "$2 on $1" ) \
          >>/var/log/wifi_report.log 2>&1 &
        ;;
    esac
    ;;
esac
exit 0
HOOK
sudo chmod 755 /etc/NetworkManager/dispatcher.d/90-wifi-report
sudo systemctl enable --now NetworkManager-dispatcher.service >/dev/null 2>&1 || true
sudo touch /var/log/wifi_report.log

# 로그가 무한히 자라지 않게
sudo tee /etc/logrotate.d/wifi_report >/dev/null <<'ROT'
/var/log/wifi_report.log {
    monthly
    rotate 3
    missingok
    notifempty
    copytruncate
}
ROT
REMOTE

# ---- verify ---------------------------------------------------------------
echo "== 검증 1/2: 훅을 NetworkManager 가 부르는 방식 그대로 실행"
ssh "$TARGET" 'sudo /etc/NetworkManager/dispatcher.d/90-wifi-report wlan0 up; sleep 12; sudo tail -2 /var/log/wifi_report.log'

echo "== 검증 2/2: 현재 상태"
ssh "$TARGET" 'sudo /usr/local/bin/wifi_report.py --dry-run; echo; echo "-- 우선순위 (높은 순) --"; nmcli -g NAME con show | sort -u | while read -r n; do [ "$n" = lo ] && continue; p=$(nmcli -g connection.autoconnect-priority con show "$n"); a=$(nmcli -g connection.autoconnect con show "$n"); s=$(nmcli -g 802-11-wireless.ssid con show "$n"); printf "%s|%-22s ssid=%-22s auto=%-4s prio=%s\n" "${p:-0}" "$n" "${s:--}" "$a" "${p:-0}"; done | sort -t"|" -k1 -rn | cut -d"|" -f2-'

if [ "$ADD_WIFI" -eq 1 ]; then
  echo
  echo "== 와이파이 추가 (대화형)"
  ssh -t "$TARGET" 'sudo /usr/local/bin/wifi_add.sh'
fi

cat <<EOS

== 완료.
   이제 이 기기는 접속이 바뀔 때마다 구글 챗으로 SSID/IP/ssh 명령을 알려준다.
   와이파이를 더 추가하려면:   ssh -t $TARGET sudo wifi_add.sh
   로그:                        ssh $TARGET sudo tail -f /var/log/wifi_report.log
EOS
