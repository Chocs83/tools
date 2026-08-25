# qa-log — 주간 작업 리포트

Claude Code 세션에서 **내가 보낸 요청**을 프로젝트별·주 단위로 모아 문서로 만든다.
무엇을 왜 요청했는지가 남으므로, 나중에 결정의 경위를 되짚을 때 쓴다.

| 파일 | 하는 일 |
|---|---|
| `generate_qa_log.py` | 세션 트랜스크립트에서 사용자 메시지를 뽑아 `~/qa-log/<프로젝트>/YYYY-Www.md` 생성 |
| `weekly_qa_log.sh` | 위를 돌리고, 요약이 비어 있는 주 문서를 claude 헤드리스로 채운다 |
| `qa-log.service` / `qa-log.timer` | systemd **user** 타이머. 매주 월요일 10:00 (KST) |

## 설치

```bash
cp qa-log.service qa-log.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now qa-log.timer
systemctl --user list-timers qa-log.timer     # 상태 확인
```

`ExecStart` 는 `~/qa-log/weekly_qa_log.sh` 를 가리키므로, 스크립트 두 개는
`~/qa-log/` 에 두고 이 repo를 원본으로 삼아 갱신한다.

`Persistent=true` 라서 월요일에 컴퓨터가 꺼져 있었어도 **다음 부팅 시점**에
밀린 주차까지 한 번에 생성된다. 진행 중인 이번 주는 일부러 제외한다 — 주가 끝나야
그 주의 기록이 완성되기 때문.

## 산출물은 여기 올라오지 않는다

생성된 `~/qa-log/<프로젝트>/*.md` 는 작업 세션의 **원문**이라 호스트 주소나
sudo 비밀번호가 섞여 들어간 적이 있다. 이 repo는 public이므로 `.gitignore` 로
산출물을 막아두었다. 올라오는 것은 **도구뿐**이다.
