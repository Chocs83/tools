# AI CLI 사용량 기록

`ccusage`가 보여주는 일별 사용량을 **여러 머신에서 모아 영구 CSV로 쌓고**, 매일 아침
자동 갱신하고, 월별 표로 볼 수 있는 HTML 리포트를 만든다.

## 왜 필요한가

**한 번의 `ccusage`는 한 머신만 본다.** Windows에서 한 작업과 WSL에서 한 작업은 세션 트리가
완전히 분리돼 있어서 서로를 못 본다:

| 소스 | 범위 | 에이전트 |
|---|---|---|
| WSL | 2026-07-13 ~ | claude |
| Windows | 2025-12-22 ~ 2026-07-22 | claude + **codex** |

WSL에서 `ccusage`만 돌리면 **작년 12월부터 올해 6월까지가 통째로 안 보인다.**

**그리고 `ccusage`는 매번 세션 `.jsonl`에서 다시 계산한다.** 세션 파일이 없어진 기간은
보고서에서 그냥 사라진다.

그래서 이 도구는 "어제 것을 추가"하지 않는다. **모든 소스에게 각자 볼 수 있는 전체 표를 묻고,
행을 절대 잃지 않는 CSV에 병합**한다. 행 키가 `(날짜, 소스)`라서 같은 날 두 머신을 썼으면
덮어쓰지 않고 **합산**된다. 몇 번을 다시 돌려도 안전하고, 하루 걸렀으면 다음 실행이 메운다.

## 소스

| 이름 | 실행 방식 |
|---|---|
| `wsl` | 로컬 `ccusage` → `npx --no-install ccusage` → `npx ccusage` 순으로 시도 |
| `windows` | `cmd.exe /c ccusage` — **Windows가 스스로 경로를 찾게 한다** |

`windows`를 네이티브로 돌리는 게 중요하다. WSL에서 `CLAUDE_CONFIG_DIR`로
`/mnt/c/.../.claude`를 가리키면 **더 적게 찾는다** — 4월 27일부터, Claude만.
Windows가 직접 해석하면 2025년 12월부터, Codex까지 나온다.

## 데이터

리포지터리 밖 `~/ai-usage/`에 쌓인다:

| 파일 | 내용 |
|---|---|
| `daily.csv` | 날짜 × 소스별 비용·토큰·에이전트·모델. **UTF-8 BOM이라 Excel에서 바로 열림** |
| `daily_models.csv` | 날짜 × 소스 × 모델 분해 |
| `report.html` | 월별 / 모델별 / 소스별 / 일별 표. 브라우저로 열면 됨 |
| `.state/run.log` | 실행 기록 |

`first_seen` / `last_seen` 열이 있어서, 어떤 소스가 더 이상 보고하지 않는 날짜는
**값이 얼어붙은 게 눈에 보인다.** 소스가 아예 응답을 못 하면 그 소스의 행은 손대지 않는다 —
실행 실패가 "그 날들이 사라졌다"로 보이면 안 되니까.

## 비용의 의미

ccusage는 토큰을 **API 요금으로 환산**한다. Max 구독으로 쓴 기간의 금액은
실제 결제액이 아니라 *API로 썼다면* 들었을 비용이다.

## 설치

```bash
cp ai-usage.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now ai-usage.timer
```

확인 / 수동 실행:

```bash
systemctl --user list-timers ai-usage.timer
./daily_usage.sh --print                 # 월별 표를 터미널에 출력
./daily_usage.sh --only wsl              # 한 소스만
./daily_usage.sh --artifact /tmp/u.html  # 아티팩트용 페이지도 생성
```

## 한계

`ccusage`는 **CLI 세션 파일만** 읽는다. Claude 데스크톱 앱이나 웹에서 쓴 건 세션 파일을
남기지 않아 어떤 방법으로도 집계되지 않는다. 세션 파일이 삭제된 기간도 마찬가지다 —
예를 들어 2026년 4월 기록은 4/27~30 나흘뿐이고, 그 이전은 남아 있지 않다.

## 주의

`~/ai-usage/`의 내용물은 **개인 사용량·비용 데이터**다. 이 리포지터리는 공개이므로
데이터는 절대 여기에 두지 말 것 — 도구만 여기, 데이터는 홈 디렉터리에.
