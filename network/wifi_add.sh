#!/usr/bin/env bash
# Add or update a wifi network on a headless box, with the priority made visible
# before and after.
#
#   sudo wifi_add.sh                 # interactive
#   ssh -t monolith@192.168.0.77 sudo wifi_add.sh
#
# Why interactive and why it prints the table twice: on a box with no screen the
# only thing standing between you and losing access is the priority order, and
# it is easy to get wrong.  We set an office network to 98 believing the hotspot
# was 99; it was 50, so the office won, the box moved to a network we could not
# reach, and it took an afternoon and a car trip to get it back.  So this script
# shows what is there, works out whether the new entry would take over, and
# makes you say yes to that specifically.
set -uo pipefail

[ "$(id -u)" -eq 0 ] || { echo "run with sudo" >&2; exit 1; }
command -v nmcli >/dev/null || { echo "nmcli not found -- this expects NetworkManager" >&2; exit 1; }

BOLD=$'\e[1m'; DIM=$'\e[2m'; RED=$'\e[31m'; GRN=$'\e[32m'; YEL=$'\e[33m'; OFF=$'\e[0m'

active_prio=-9999
active_name=""

show_table() {
  printf "\n%s%-22s %-24s %8s %5s %-7s %s%s\n" "$BOLD" \
         NAME SSID PRIORITY AUTO ACTIVE IPv4 "$OFF"
  # sort by priority descending: that is the order NetworkManager will try them
  while IFS= read -r line; do
    name=$line
    [ "$name" = "lo" ] && continue
    prio=$(nmcli -g connection.autoconnect-priority con show "$name" 2>/dev/null)
    auto=$(nmcli -g connection.autoconnect con show "$name" 2>/dev/null)
    ssid=$(nmcli -g 802-11-wireless.ssid con show "$name" 2>/dev/null)
    m=$(nmcli -g ipv4.method con show "$name" 2>/dev/null)
    addr=$(nmcli -g ipv4.addresses con show "$name" 2>/dev/null)
    dev=$(nmcli -g GENERAL.DEVICES con show "$name" 2>/dev/null)
    st=$(nmcli -g GENERAL.STATE con show "$name" 2>/dev/null)
    ip4="$m"
    [ "$m" = "manual" ] && ip4="static $addr"
    act=""
    if [ "$st" = "activated" ]; then
      act="${GRN}yes${OFF}"
      if [ -n "$ssid" ]; then
        active_prio=${prio:-0}
        active_name=$name
      fi
    fi
    col=""
    [ "$auto" = "no" ] && col=$DIM
    printf "%s%-22s %-24s %8s %5s %-7b %s%s\n" \
           "$col" "$name" "${ssid:--}" "${prio:-0}" "$auto" "${act:--}" "$ip4" "$OFF"
  done < <(nmcli -g NAME con show | sort -u \
           | while read -r n; do
               p=$(nmcli -g connection.autoconnect-priority con show "$n" 2>/dev/null)
               echo "${p:-0}|$n"
             done | sort -t'|' -k1 -rn | cut -d'|' -f2-)
  echo
  if [ -n "$active_name" ]; then
    echo "${DIM}현재 연결: $active_name (우선순위 $active_prio). " \
         "이보다 높은 값을 주면 그쪽으로 옮겨간다.${OFF}"
  fi
}

echo "${BOLD}== 현재 등록된 연결 (NetworkManager 가 시도하는 순서)${OFF}"
show_table

echo "${BOLD}== 주변 신호${OFF}"
nmcli dev wifi rescan >/dev/null 2>&1
sleep 2
nmcli -f SSID,SIGNAL,FREQ,SECURITY dev wifi list 2>/dev/null \
  | awk 'NR==1 || ($1!="--" && !seen[$1]++)' | head -12

# ---- SSID -----------------------------------------------------------------
echo
read -rp "추가할 SSID: " SSID
[ -n "$SSID" ] || { echo "SSID 없음, 중단" >&2; exit 1; }

EXISTING=$(nmcli -g NAME,802-11-wireless.ssid con show 2>/dev/null | true)
CONNAME=""
while IFS= read -r n; do
  [ -z "$n" ] && continue
  s=$(nmcli -g 802-11-wireless.ssid con show "$n" 2>/dev/null)
  if [ "$s" = "$SSID" ]; then CONNAME=$n; break; fi
done < <(nmcli -g NAME con show | sort -u)

if [ -n "$CONNAME" ]; then
  echo "${YEL}이미 '$CONNAME' 프로필이 SSID '$SSID' 를 갖고 있다 -> 새로 만들지 않고 수정한다.${OFF}"
else
  read -rp "프로필 이름 [$SSID]: " CONNAME
  CONNAME=${CONNAME:-$SSID}
fi

# ---- password -------------------------------------------------------------
read -rsp "비밀번호 (빈 값이면 열린 망 / 기존 유지): " PSK; echo
if [ -n "$PSK" ] && [ ${#PSK} -lt 8 ]; then
  echo "${RED}WPA2 비밀번호는 8자 이상이어야 한다. 중단.${OFF}" >&2
  exit 1
fi

# ---- priority -------------------------------------------------------------
echo
echo "${DIM}참고: 값이 클수록 먼저 시도된다. 현재 연결은 $active_prio 다.${OFF}"
read -rp "우선순위 (정수): " PRIO
case "$PRIO" in
  ''|*[!0-9-]*) echo "${RED}정수를 넣어라. 중단.${OFF}" >&2; exit 1 ;;
esac

# ---- ipv4 -----------------------------------------------------------------
echo
echo "${DIM}고정 IP는 그 공유기에서만 유효하다. 다른 망에 그 프로필로 붙으면 연결은 되지만"
echo "주소가 안 맞아 통신이 안 된다 -- 실제로 겪었다. 확실할 때만 static 을 골라라.${OFF}"
read -rp "IPv4 [dhcp/static] (기본 dhcp): " IPMODE
IPMODE=${IPMODE:-dhcp}
IPADDR=""; IPGW=""; IPDNS=""
if [ "$IPMODE" = "static" ]; then
  read -rp "  주소/prefix (예 192.168.0.77/24): " IPADDR
  read -rp "  게이트웨이 (예 192.168.0.1): " IPGW
  read -rp "  DNS (기본 8.8.8.8): " IPDNS
  IPDNS=${IPDNS:-8.8.8.8}
  [ -n "$IPADDR" ] && [ -n "$IPGW" ] || { echo "${RED}주소와 게이트웨이 필요. 중단.${OFF}" >&2; exit 1; }
fi

# ---- the warning that matters --------------------------------------------
TAKES_OVER=0
if [ -n "$active_name" ] && [ "$CONNAME" != "$active_name" ] && [ "$PRIO" -gt "$active_prio" ]; then
  TAKES_OVER=1
fi

echo
echo "${BOLD}== 적용할 내용${OFF}"
echo "  프로필   : $CONNAME $([ -n "$EXISTING" ] && echo)"
echo "  SSID     : $SSID"
echo "  우선순위 : $PRIO"
echo "  IPv4     : $IPMODE${IPADDR:+ $IPADDR gw $IPGW}"
if [ "$TAKES_OVER" -eq 1 ]; then
  echo
  echo "${RED}${BOLD}주의: $PRIO > $active_prio ('$active_name') 이므로,"
  echo "이 망이 잡히는 순간 현재 연결을 버리고 그쪽으로 옮겨간다."
  echo "지금 SSH로 들어와 있다면 이 세션이 끊기고, 새 주소는 구글 챗 알림으로 와야 한다.${OFF}"
  if [ ! -x /usr/local/bin/wifi_report.py ]; then
    echo "${RED}그런데 wifi_report.py 가 설치돼 있지 않다 -- 알림이 오지 않는다."
    echo "setup_cm4.sh 를 먼저 돌리는 편이 안전하다.${OFF}"
  fi
fi
echo
read -rp "진행할까? [y/N] " OK
[ "$OK" = "y" ] || [ "$OK" = "Y" ] || { echo "취소."; exit 0; }

# ---- apply ----------------------------------------------------------------
# 새로 만들 때는 autoconnect 를 끈 상태로 만들고 마지막에 켠다. 중간 상태에서
# NetworkManager 가 먼저 물어가 세션을 끊는 일을 막는다.
if nmcli -g NAME con show | grep -qxF "$CONNAME"; then
  nmcli con mod "$CONNAME" 802-11-wireless.ssid "$SSID" \
        connection.autoconnect-priority "$PRIO" || exit 1
else
  nmcli con add type wifi con-name "$CONNAME" ifname wlan0 ssid "$SSID" \
        connection.autoconnect no \
        connection.autoconnect-priority "$PRIO" || exit 1
fi

if [ -n "$PSK" ]; then
  nmcli con mod "$CONNAME" wifi-sec.key-mgmt wpa-psk wifi-sec.psk "$PSK" || exit 1
fi

if [ "$IPMODE" = "static" ]; then
  nmcli con mod "$CONNAME" ipv4.method manual ipv4.addresses "$IPADDR" \
        ipv4.gateway "$IPGW" ipv4.dns "$IPDNS" || exit 1
else
  nmcli con mod "$CONNAME" ipv4.method auto ipv4.addresses "" ipv4.gateway "" || exit 1
fi

nmcli con mod "$CONNAME" connection.autoconnect yes || exit 1
echo "${GRN}적용됨.${OFF}"

active_prio=-9999; active_name=""
echo "${BOLD}== 적용 후${OFF}"
show_table

if [ "$TAKES_OVER" -eq 1 ]; then
  echo "${YEL}이 망이 보이면 자동으로 옮겨간다. 지금 바로 옮기려면:${OFF}"
  echo "  sudo nmcli con up '$CONNAME'"
fi
