# tools

작업용 유틸리티 모음. **SLAM 자체와 직접 관련이 없는 것들**만 여기 둔다 —
맵 빌더·로컬라이저·리플레이 하네스는 각 프로젝트 repo에 남는다.

| 폴더 | 내용 |
|---|---|
| [network/](network/) | 헤드리스 CM4의 Wi-Fi 설정, 부팅 시 IP 보고(웹훅), 신규 보드 셋업 |
| [qa-log/](qa-log/) | Claude Code 세션에서 내가 보낸 요청을 주 단위로 모으는 자동 리포트 |
| [ai-usage/](ai-usage/) | ccusage 일별 사용량을 WSL·Windows 여러 소스에서 모아 영구 CSV와 월별 HTML 리포트로 쌓는 타이머 (데이터는 `~/ai-usage/`, 여기엔 도구만) |
| [tmp_clean/](tmp_clean/) | `~/tmp/날짜/` 작업 폴더 정리: 볼 만한 것(png·md·문서·스크립트)과 링크된 파일만 남기고 지움, 기본은 목록만 |
| [claude-mods/](claude-mods/) | Claude Code mod — `workbench`: 우측 사이드바 작업대(사용량 / 작업 요약·진행 / 할일 / 오늘 결과물) |
| [snip/](snip/) | 영역 스크린샷 한 번에: 범위를 고르면 바로 `~/사진/Screenshots` 저장 + 클립보드 복사. GNOME 단축키 Super+Shift+S 용 (`ln -s $PWD/snip/snip ~/.local/bin/snip`) |

## Claude Code mod 설치

이 repo 자체가 Claude Code 플러그인 marketplace(`chocs-mods`)다. 다른 컴퓨터의 Claude Code 프롬프트에서:

```
/plugin install workbench --marketplace Chocs83/tools
```

`Add marketplace?` 에 `y`, 범위는 user 를 고른다. 업데이트는 `claude plugin update workbench@chocs-mods` 후 `/reload-plugins`.

- 패널이 자동으로 뜨려면 터미널 폭 144칸 이상, 아니면 `/wb` 로 연다. `/wb sum` 은 세션 전체 정밀 요약.
- 맨 위 **사용량**: 모델·effort, 오늘·이번 달 비용(세션이 쓰는 만큼 ccusage 갱신 사이에도 올라간다), 5H·7D·컨텍스트 막대. 색은 Claude Code 테마(`/theme`)를 따라간다.
- 사용량은 `npx ccusage@20.0.26` 으로 계산한다(Node 필요, 첫 실행 때 내려받음).
- 작업은 진행 중인 일 전반의 요약 + 지금 하는 것 + 최근 수행한 것(haiku 가 턴마다 갱신, `정밀` 은 세션 전체). 할일은 목표가 정해지면 단계별 항목으로 나눠 같이 갱신된다 — 항목 클릭으로 [ ]→[▶]→[x] 를 바꾸면 그 상태는 고정, `×` 로 지움, `/wb todo clear` 로 비움. 할일은 세션별로 따로 보관된다 (같은 세션을 resume 하면 돌아오고, 다른 세션에는 보이지 않는다).
- 오늘 결과물은 `~/tmp` 아래 오늘 수정된 파일, 클릭하면 `xdg-open` 으로 기본 앱에서 연다.

## 이 repo는 public이다

그래서 **자격증명이 들어가면 안 된다.** 두 가지가 특히 위험하다:

- **Google Chat 웹훅 URL** — 이것 자체가 bearer 자격증명이다. URL을 아는 사람은
  누구나 그 채널에 글을 쓸 수 있다. 기기의 `/etc/wifi_report.conf`(root, 0600)에만
  두고, 원격에는 **stdin으로만** 넘긴다. 명령줄 인자로 주면 `ps`에 노출되고 셸
  히스토리에 남는다.
- **생성된 QA 로그** — 작업 세션의 원문이라 호스트 주소와 sudo 비밀번호가 섞여
  들어간 적이 있다. `~/qa-log/<프로젝트>/` 에만 두고 여기엔 **도구만** 올린다.
  `.gitignore` 가 산출물을 막아두었다.

## 출처

`network/` 는 `ceiling_vision/tools/rig/` 에서, `qa-log/` 는 `~/qa-log/` 에서 옮겨왔다.
