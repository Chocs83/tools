# tools

작업용 유틸리티 모음. **SLAM 자체와 직접 관련이 없는 것들**만 여기 둔다 —
맵 빌더·로컬라이저·리플레이 하네스는 각 프로젝트 repo에 남는다.

| 폴더 | 내용 |
|---|---|
| [network/](network/) | 헤드리스 CM4의 Wi-Fi 설정, 부팅 시 IP 보고(웹훅), 신규 보드 셋업 |
| [qa-log/](qa-log/) | Claude Code 세션에서 내가 보낸 요청을 주 단위로 모으는 자동 리포트 |
| [ai-usage/](ai-usage/) | ccusage 일별 사용량을 WSL·Windows 여러 소스에서 모아 영구 CSV와 월별 HTML 리포트로 쌓는 타이머 (데이터는 `~/ai-usage/`, 여기엔 도구만) |
| [tmp_clean/](tmp_clean/) | `~/tmp/날짜/` 작업 폴더 정리: 볼 만한 것(png·md·문서·스크립트)과 링크된 파일만 남기고 지움, 기본은 목록만 |
| [claude-mods/](claude-mods/) | Claude Code mod — `workbench`: 우측 사이드바 작업대(클로드·택시 미터 / 작업 요약·진행 / 장치 / 오늘 결과물) |

## Claude Code mod 설치

이 repo 자체가 Claude Code 플러그인 marketplace(`chocs-mods`)다. 다른 컴퓨터의 Claude Code 프롬프트에서:

```
/plugin install workbench --marketplace Chocs83/tools
```

`Add marketplace?` 에 `y`, 범위는 user 를 고른다. 업데이트는 `claude plugin update workbench@chocs-mods` 후 `/reload-plugins`.

- 패널이 자동으로 뜨려면 터미널 폭 144칸 이상, 아니면 `/wb` 로 연다. `/wb sum` 은 세션 전체 정밀 요약.
- 맨 위 **클로드·택시**: 오늘 사용량을 원화 미터로(1$=1,400원 고정), 모델·effort·tok/s, context·5H·7D 막대, 빈차/주행/할증/복합/지불 상태. 택시는 출력 속도에 맞춰 달린다. 화려한 게 싫으면 `/wb text` (또는 미터 오른쪽 위 `텍스트`)로 평범한 표로 바꾼다 — `/wb gui` 로 복귀, 선택은 저장된다.
- 사용량은 `npx ccusage@20.0.26` 으로 계산한다(Node 필요, 첫 실행 때 내려받음).
- 장치는 ssh/scp 로 접속했던 `user@IP` 를 키 인증(BatchMode)으로 확인한다 — 비밀번호 접속 장치는 "ping만 응답"으로 보인다.
- 오늘 결과물은 `~/tmp` 아래 오늘 수정된 파일, 클릭하면 Windows(WSL) `explorer.exe` 로 연다.

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
