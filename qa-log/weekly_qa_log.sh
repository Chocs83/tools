#!/usr/bin/env bash
# 주간 QA 로그 생성기.
#   1) generate_qa_log.py 로 프로젝트별·주별 원문 섹션을 쓴다 (진행 중인 이번 주는 제외).
#   2) 요약이 비어 있는 주 문서는 claude 헤드리스로 요약을 채운다.
# 매주 월요일 systemd user timer(qa-log.timer)가 실행. 그 날 컴퓨터가 꺼져 있었으면
# Persistent=true 덕분에 다음 부팅 시점에 밀린 주차까지 한 번에 처리된다.
set -uo pipefail

ROOT="$HOME/qa-log"
STATE="$ROOT/.state"
LOG="$STATE/run.log"
CLAUDE="${CLAUDE_BIN:-$HOME/.local/bin/claude}"
MODEL="${QA_LOG_MODEL:-opus}"
mkdir -p "$STATE"

log() { printf '%s %s\n' "$(date '+%F %T')" "$*" | tee -a "$LOG"; }

log "=== 주간 QA 로그 생성 시작 ==="

# 1) 원문 생성 + 요약 미작성 목록 수집
# ( 프로세스 치환 뒤의 $? 는 mapfile 것이므로, 종료코드를 보려면 파일로 받아야 한다 )
OUT="$STATE/todo.txt"
if ! python3 "$ROOT/generate_qa_log.py" --list-todo >"$OUT" 2>>"$LOG"; then
  rc=$?
  log "[에러] generate_qa_log.py 실패 (rc=$rc). 중단."
  exit "$rc"
fi
mapfile -t TODOS < <(sed -n 's/^TODO\t//p' "$OUT")
log "원문 생성 완료. 요약 필요: ${#TODOS[@]}건"

if [ "${#TODOS[@]}" -eq 0 ]; then
  log "=== 완료 (요약할 주차 없음) ==="
  exit 0
fi

if [ ! -x "$CLAUDE" ]; then
  log "[경고] claude 실행 파일을 찾을 수 없음: $CLAUDE"
  log "       원문은 생성됐고 요약은 비어 있습니다. 다음 실행 때 다시 시도합니다."
  exit 0
fi

# 2) 주 문서별로 요약 채우기
fail=0
for f in "${TODOS[@]}"; do
  wk="$(basename "$f" .md)"
  proj="$(basename "$(dirname "$f")")"
  log "요약 작성 중: $proj/$wk"

  prompt="파일 $f 는 '$proj' 프로젝트의 $wk 주차 QA 로그다.
'## 2. 메시지 원문' 섹션에 그 주 동안 사용자가 Claude에게 보낸 메시지 원문이 시간순으로 들어 있다.

이 원문을 처음부터 끝까지 읽고, 파일 안의 <!-- SUMMARY:BEGIN --> 과 <!-- SUMMARY:END --> 사이 내용을
아래 형식의 한국어 요약으로 **교체**해라 (Edit 도구 사용). 마커 두 줄 자체는 지우지 말 것.

형식:
1) 첫 줄은 '> ' 로 시작하는 인용 한 문단 — 그 주가 어떤 주였는지 3~4문장 한 줄 요약.
   (이 줄이 색인 표에 그대로 실린다)
2) 그 다음 주제별로 '### 소제목' 섹션. 헤딩 레벨은 반드시 ### 를 쓸 것 (## 는 쓰지 말 것).
   각 섹션은 '- 무엇을:', '- 문제/질문:', '- 결론:' 같은 불릿으로,
   '무엇을 하려 했고 / 무엇이 막혔고 / 어떻게 결론났는지' 가 드러나게 써라.
3) 시간순 나열이 아니라 주제별로 묶어라. 파일명·경로·수치·장비명 같은 구체적 사실은 살려라.
4) 사용자가 실제로 물어본 것과 지시한 것 위주로. 추측으로 없는 사실을 만들지 말 것.

'## 2. 메시지 원문' 섹션은 절대 수정하지 마라. 다른 파일도 건드리지 마라.
작업이 끝나면 '완료: $wk' 한 줄만 출력해라."

  if "$CLAUDE" -p "$prompt" \
        --model "$MODEL" \
        --permission-mode acceptEdits \
        --allowedTools "Read Edit" \
        --add-dir "$ROOT" \
        >>"$LOG" 2>&1; then
    if grep -q "TODO: 요약 미작성" "$f"; then
      log "[경고] $proj/$wk — claude 는 끝났지만 요약이 채워지지 않음. 다음 실행 때 재시도."
      fail=$((fail+1))
    else
      log "요약 완료: $proj/$wk"
    fi
  else
    log "[경고] $proj/$wk 요약 실패. 다음 실행 때 재시도."
    fail=$((fail+1))
  fi
done

# 3) 색인의 한 줄 요약을 새로 쓴 요약으로 갱신
python3 "$ROOT/generate_qa_log.py" >>"$LOG" 2>&1

log "=== 완료 (요약 ${#TODOS[@]}건 중 실패 ${fail}건) ==="
