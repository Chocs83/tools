#!/usr/bin/env python3
"""Claude Code 세션 트랜스크립트에서 사용자 질문/요청 원문을 뽑아
프로젝트별 · ISO 주 단위 마크다운 문서로 저장한다.

출력: ~/qa-log/<프로젝트명>/YYYY-Www.md
      한 파일 안에 [요약] → [메시지 원문] 순서로 함께 들어간다.

사용법:
    python3 ~/qa-log/generate_qa_log.py                 # 전체 프로젝트
    python3 ~/qa-log/generate_qa_log.py --project pyslam
    python3 ~/qa-log/generate_qa_log.py --list-todo     # 요약 미작성 파일만 출력

동작 규칙:
  - 이번 주(진행 중인 ISO 주)는 만들지 않는다. 주가 끝난 다음 주에 생성된다.
  - 이미 요약이 채워진 파일은 요약을 그대로 보존하고 원문 섹션만 갱신한다(멱등).
  - 요약이 비어 있으면 자리표시자(TODO)를 넣고 그 경로를 stdout에 'TODO<TAB>경로'로 알린다.
    → weekly_qa_log.sh 가 이 목록을 받아 claude 로 요약을 채운다.

주의: 세션 트랜스크립트(*.jsonl)는 그 세션을 돌린 머신에만 있다. 따라서 원문 재생성은
      트랜스크립트가 남아 있는 범위 안에서만 가능하다(오래된 세션은 정리되어 사라질 수 있음).
"""
import json, glob, datetime, collections, re, os, sys, argparse

HOME = os.path.expanduser("~")
OUT_ROOT = os.path.join(HOME, "qa-log")
PROJECTS_DIR = os.path.join(HOME, ".claude", "projects")
KST = datetime.timezone(datetime.timedelta(hours=9))
WD = ["월", "화", "수", "목", "금", "토", "일"]

SUM_BEGIN = "<!-- SUMMARY:BEGIN -->"
SUM_END = "<!-- SUMMARY:END -->"
RAW_BEGIN = "<!-- RAW:BEGIN -->"
TODO_MARK = "<!-- TODO: 요약 미작성 -->"

# 사용자 메시지가 아닌(시스템 주입·명령 출력·자동요약) 접두사
BAD = (
    "<local-command", "<command-name", "<command-message", "<command-args",
    "[Request interrupted", "<local-command-stdout", "Caveat:", "<system-reminder",
    "<task-notification", "This session is being continued",
    "Please continue the conversation from where", "[Image: source:",
)


def project_name(tdir):
    """트랜스크립트 폴더의 실제 작업 경로를 jsonl 안의 cwd 필드에서 읽어 이름을 정한다.

    폴더명(-home-chocs-project-ceiling-vision)만으로는 '/'와 '_'와 '-'를 구별할 수 없어
    (ceiling_vision → ceiling-vision) 역산이 불가능하다. cwd 가 유일한 정답.
    """
    cwd = None
    for fn in sorted(glob.glob(os.path.join(tdir, "*.jsonl"))):
        with open(fn, errors="replace") as f:
            for i, line in enumerate(f):
                if i > 50:
                    break
                m = re.search(r'"cwd":"([^"]+)"', line)
                if m:
                    cwd = m.group(1)
                    break
        if cwd:
            break
    if not cwd:  # 폴백: 폴더명 끝 토큰
        return os.path.basename(tdir).lstrip("-").split("-")[-1] or "unknown"
    cwd = cwd.rstrip("/")
    if cwd == HOME.rstrip("/"):
        return "home"
    return os.path.basename(cwd) or "root"


def get_text(d):
    if d.get("type") != "user":
        return None
    # isMeta: 슬래시 명령/스킬 확장, 플러그인 셋업, 이미지 에코, 자동 continue 프롬프트,
    #         명령 caveat 등 시스템이 주입한 user 엔트리 → 사용자가 직접 친 게 아님
    if d.get("isMeta") or d.get("isSidechain") or d.get("isCompactSummary"):
        return None
    m = d.get("message", {})
    if not isinstance(m, dict):
        return None
    c = m.get("content")
    if isinstance(c, str):
        txt = c
    elif isinstance(c, list):
        txt = " ".join(
            b.get("text", "") for b in c
            if isinstance(b, dict) and b.get("type") == "text"
        )
    else:
        return None
    txt = txt.strip()
    if not txt or txt.startswith(BAD):
        return None
    if txt.startswith("<") and "command" in txt[:40]:
        return None
    if re.fullmatch(r"\[Image[^\]]*\]", txt):  # 순수 이미지 경로 에코
        return None
    first = txt.splitlines()[0].strip()
    if re.fullmatch(r"/[a-zA-Z][\w:-]*(\s.*)?", first) and len(txt) < 40 and "\n" not in txt:
        return None  # /compact, /model 등 슬래시 명령
    return txt


def collect(tdir):
    """트랜스크립트 폴더 → [(datetime, 본문)] 시간순, 세션 포크 중복 제거."""
    seen, entries = set(), []
    for fn in sorted(glob.glob(os.path.join(tdir, "*.jsonl"))):
        with open(fn, errors="replace") as f:
            for line in f:
                try:
                    d = json.loads(line)
                except Exception:
                    continue
                txt = get_text(d)
                ts = d.get("timestamp")
                if not txt or not ts:
                    continue
                try:
                    dt = datetime.datetime.fromisoformat(
                        ts.replace("Z", "+00:00")).astimezone(KST)
                except Exception:
                    continue
                key = (dt.strftime("%Y-%m-%d %H:%M"), txt)
                if key in seen:
                    continue
                seen.add(key)
                entries.append((dt, txt))
    entries.sort(key=lambda x: x[0])
    return entries


def existing_count(path):
    """기존 주 문서에 기록된 메시지 건수. 없으면 -1."""
    if not os.path.exists(path):
        return -1
    body = open(path, errors="replace").read()
    m = re.search(r"사용자 메시지 \*\*(\d+)건", body) or re.search(r"메시지 (\d+)건", body)
    return int(m.group(1)) if m else -1


def read_existing_summary(path):
    """기존 파일의 요약 블록을 꺼낸다. 없거나 TODO 자리표시자면 None."""
    if not os.path.exists(path):
        return None
    body = open(path, errors="replace").read()
    i, j = body.find(SUM_BEGIN), body.find(SUM_END)
    if i < 0 or j < 0 or j < i:
        return None
    inner = body[i + len(SUM_BEGIN):j].strip()
    if not inner or TODO_MARK in inner:
        return None
    return inner


def oneliner(summary):
    """요약 블록의 첫 '>' 인용 줄 = 한 줄 요약 (색인 표에 사용)."""
    if not summary:
        return ""
    for line in summary.splitlines():
        s = line.strip()
        if s.startswith(">"):
            return s.lstrip("> ").strip()
    for line in summary.splitlines():
        s = line.strip()
        if s and not s.startswith("#") and not s.startswith("<!--"):
            return s
    return ""


def render(proj, monday, msgs, summary):
    sunday = monday + datetime.timedelta(days=6)
    iso = monday.isocalendar()
    L = [
        f"# {proj} QA 로그 — {iso[0]}-W{iso[1]:02d} ({monday} ~ {sunday}, KST)", "",
        f"작업 경로 기준 프로젝트: **{proj}** · 사용자 메시지 **{len(msgs)}건**", "",
        "---", "",
        "## 1. 요약", "",
        SUM_BEGIN,
    ]
    if summary:
        L.append(summary)
    else:
        L += [TODO_MARK, "",
              "_이 주의 요약이 아직 작성되지 않았습니다. "
              "`~/qa-log/weekly_qa_log.sh` 실행 시 자동으로 채워집니다._"]
    L += [SUM_END, "", "---", "",
          "## 2. 메시지 원문", "",
          "> 시간순 자동 추출. 시스템 주입(`isMeta`)·명령 출력·슬래시 명령·"
          "자동요약·세션 포크 중복은 제외.", "",
          RAW_BEGIN, ""]

    curday = None
    for dt, txt in msgs:
        day = dt.date()
        if day != curday:
            curday = day
            L += [f"### {day} ({WD[day.weekday()]})", ""]
        t = dt.strftime("%H:%M")
        body = txt.strip()
        if "\n" in body:
            head, *rest = body.split("\n")
            L.append(f"- **{t}** — {head}")
            for r in rest:
                L.append(f"  {r}" if r.strip() else "")
        else:
            L.append(f"- **{t}** — {body}")
    L.append("")
    return "\n".join(L)


def scan_weeks(pdir):
    """프로젝트 폴더의 모든 주 문서를 스캔 → [(파일명, 메시지수, 한줄요약)] 오름차순.

    트랜스크립트가 정리되어 재생성 불가능한 과거 주차도 색인에서 사라지지 않게 하려고
    '방금 생성한 목록'이 아니라 '디스크에 있는 것'을 기준으로 삼는다.
    """
    rows = []
    for path in sorted(glob.glob(os.path.join(pdir, "[0-9][0-9][0-9][0-9]-W[0-9][0-9].md"))):
        body = open(path, errors="replace").read()
        m = re.search(r"사용자 메시지 \*\*?(\d+)", body) or re.search(r"메시지 (\d+)건", body)
        n = int(m.group(1)) if m else 0
        i, j = body.find(SUM_BEGIN), body.find(SUM_END)
        inner = body[i + len(SUM_BEGIN):j].strip() if (i >= 0 and j > i) else ""
        if TODO_MARK in inner:
            inner = ""
        rows.append((os.path.basename(path), n, oneliner(inner)))
    return rows


def write_project_index(proj, pdir, rows):
    """rows: [(weekfile, n, oneline)] 오름차순"""
    L = [
        f"# {proj} — QA 로그 색인", "",
        "Claude Code 작업 중 사용자가 보낸 질문/요청을 **ISO 주 단위**로 정리한 기록. "
        "타임스탬프는 KST.", "",
        "각 주 문서는 `요약` → `메시지 원문` 순서로 한 파일에 담겨 있다.", "",
        "- 자동 생성: 매주 월요일 (systemd user timer `qa-log.timer`, "
        "그 날 컴퓨터가 꺼져 있었으면 다음 부팅 시 밀린 주차까지 생성)",
        "- 수동 실행: `~/qa-log/weekly_qa_log.sh`", "",
        "| 주차 | 문서 | 메시지 | 한 줄 요약 |",
        "|---|---|---|---|",
    ]
    for fname, n, one in rows:
        L.append(f"| {fname[:-3]} | [열기]({fname}) | {n} | {one or '_(요약 대기)_'} |")
    L.append("")
    with open(os.path.join(pdir, "README.md"), "w") as f:
        f.write("\n".join(L))


def write_root_index(projects):
    """projects: [(proj, week_count, msg_count, latest_week)]"""
    L = [
        "# QA 로그", "",
        "Claude Code로 작업하면서 내가 보낸 질문/요청을 프로젝트별 · 주 단위로 모아둔 곳.", "",
        "```",
        "~/qa-log/<프로젝트명>/YYYY-Www.md   ← 요약 + 메시지 원문 (한 파일)",
        "```", "",
        "| 프로젝트 | 주차 수 | 메시지 | 최근 주차 |",
        "|---|---|---|---|",
    ]
    for proj, wc, mc, latest in projects:
        L.append(f"| [{proj}]({proj}/README.md) | {wc} | {mc} | {latest} |")
    L += [
        "",
        "## 자동화",
        "",
        "- 매주 월요일 10:00 (KST) 에 systemd user timer `qa-log.timer` 가 실행.",
        "- `Persistent=true` → 월요일에 컴퓨터가 꺼져 있었으면 **다음 부팅 시점**에 "
        "밀린 주차까지 한 번에 생성.",
        "- 상태 확인: `systemctl --user list-timers qa-log.timer`",
        "- 수동 실행: `~/qa-log/weekly_qa_log.sh`  (로그: `~/qa-log/.state/run.log`)",
        "",
        "## 동작",
        "",
        "1. `generate_qa_log.py` 가 `~/.claude/projects/*/ *.jsonl` 에서 내 메시지만 뽑아",
        "   프로젝트별 · ISO 주 단위로 원문 섹션을 쓴다. **진행 중인 이번 주는 건너뛴다.**",
        "2. 요약이 비어 있는 주 문서는 `weekly_qa_log.sh` 가 `claude -p` 로 채운다.",
        "3. 이미 채워진 요약은 그대로 보존되고 원문만 갱신된다(여러 번 돌려도 안전).",
        "",
    ]
    with open(os.path.join(OUT_ROOT, "README.md"), "w") as f:
        f.write("\n".join(L))


def main():
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument("--project", help="프로젝트 이름 하나만 처리")
    ap.add_argument("--list-todo", action="store_true",
                    help="요약 미작성 파일 경로만 출력(생성도 함께 수행)")
    ap.add_argument("--transcript-dir", help="트랜스크립트 폴더 직접 지정")
    args = ap.parse_args()

    if args.transcript_dir:
        tdirs = [os.path.expanduser(args.transcript_dir)]
    else:
        if not os.path.isdir(PROJECTS_DIR):
            print(f"[에러] 트랜스크립트 루트가 없습니다: {PROJECTS_DIR}", file=sys.stderr)
            sys.exit(1)
        tdirs = [d for d in sorted(glob.glob(os.path.join(PROJECTS_DIR, "*")))
                 if os.path.isdir(d) and glob.glob(os.path.join(d, "*.jsonl"))]
    if not tdirs:
        print(f"[에러] 세션 트랜스크립트를 찾지 못했습니다: {PROJECTS_DIR}", file=sys.stderr)
        sys.exit(1)

    this_monday = (datetime.datetime.now(KST).date()
                   - datetime.timedelta(days=datetime.datetime.now(KST).date().weekday()))

    # 같은 프로젝트 이름을 가진 폴더가 여러 개일 수 있으므로 이름 기준으로 합친다
    by_proj = collections.defaultdict(list)
    for tdir in tdirs:
        by_proj[project_name(tdir)] += collect(tdir)

    todos, index_rows, skipped = [], [], []
    for proj in sorted(by_proj):
        if args.project and proj != args.project:
            continue
        entries = sorted(set(by_proj[proj]), key=lambda x: x[0])
        weeks = collections.defaultdict(list)
        for dt, txt in entries:
            monday = dt.date() - datetime.timedelta(days=dt.weekday())
            if monday >= this_monday:      # 진행 중인 이번 주는 제외
                continue
            weeks[monday].append((dt, txt))
        if not weeks:
            continue

        pdir = os.path.join(OUT_ROOT, proj)
        os.makedirs(pdir, exist_ok=True)
        for monday in sorted(weeks):
            iso = monday.isocalendar()
            fname = f"{iso[0]}-W{iso[1]:02d}.md"
            path = os.path.join(pdir, fname)
            summary = read_existing_summary(path)
            # 세션 트랜스크립트는 주기적으로 정리되어 사라진다. 그 상태로 원문 섹션을
            # 다시 쓰면 과거 주차의 원문이 줄어들거나 비어버린다 → 건수가 줄면 건너뛴다.
            prev_n = existing_count(path)
            if prev_n > len(weeks[monday]):
                skipped.append((path, prev_n, len(weeks[monday])))
            else:
                with open(path, "w") as f:
                    f.write(render(proj, monday, weeks[monday], summary))
            if not summary:
                todos.append(path)
        rows = scan_weeks(pdir)
        if not rows:
            continue
        write_project_index(proj, pdir, rows)
        index_rows.append((proj, len(rows), sum(n for _, n, _ in rows), rows[-1][0][:-3]))

    if index_rows and not args.project:
        write_root_index(index_rows)
    elif index_rows:  # 단일 프로젝트 실행이면 기존 루트 색인을 지우지 않는다
        pass

    if args.list_todo:
        for p in todos:
            print(f"TODO\t{p}")
        return

    for proj, wc, mc, latest in index_rows:
        print(f"{proj}: {wc}주 / {mc}건 (최근 {latest})")
    for path, prev_n, now_n in skipped:
        print(f"  보존 {os.path.relpath(path, OUT_ROOT)}: 기존 {prev_n}건 > 추출 {now_n}건 "
              f"→ 트랜스크립트가 정리된 것으로 보고 원문을 덮어쓰지 않음")
    print(f"요약 미작성: {len(todos)}건")
    for p in todos:
        print(f"  TODO {p}")


if __name__ == "__main__":
    main()
