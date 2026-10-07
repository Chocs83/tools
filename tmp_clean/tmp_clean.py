#!/usr/bin/env python3
"""~/tmp 날짜 폴더 정리: 볼 만한 것(png, md, py ...)만 남기고 나머지를 지운다.

  python3 ~/project/tools/tmp_clean/tmp_clean.py 260901              # 2026-09-01 폴더 하나 (목록만, 안 지움)
  python3 ~/project/tools/tmp_clean/tmp_clean.py 260901 260930       # 2026-09-01 ~ 09-30 폴더 전부
  python3 ~/project/tools/tmp_clean/tmp_clean.py 260901 260930 --apply   # 실제로 지운다

남기는 것
  - 확장자 KEEP_EXT (png jpg md py sh html + 문서 docx pdf pptx xlsx)
  - ~/tmp/prune_keep.txt 에 적은 glob 패턴 (한 줄에 하나, ~/tmp 기준 상대경로, # 주석)
    예) 2026-09-22/vecto/pose_log.csv
  - ~/project, ~/videos 의 심볼릭 링크가 가리키는 파일 (배포맵, orbslam3 runs 등) — 자동
  - 영상 원본 (h264 mp4)

지우기 전에 목록을 ~/tmp/<오늘>/cleanup/prune_<인자>.txt 로 남긴다.
"""
import argparse, collections, datetime, glob, os, re, sys

T = os.path.expanduser("~/tmp")
KEEP_EXT = {".png", ".jpg", ".md", ".py", ".sh", ".html",
            ".docx", ".pdf", ".pptx", ".xlsx"}  # 문서는 남긴다
NEVER_EXT = {".h264", ".mp4"}  # 영상 원본은 이 도구로 지우지 않는다
KEEP_LIST = os.path.join(T, "prune_keep.txt")
LINK_ROOTS = [os.path.expanduser(p) for p in ("~/project", "~/videos")]
WARN_EXT = {".pkl", ".osa", ".bin", ".dbow3", ".yaml", ".json"}  # 지우기 전에 눈으로 볼 것


def parse_day(s):
    try:
        return datetime.datetime.strptime(s, "%y%m%d").date()
    except ValueError:
        sys.exit(f"날짜는 260901 형식이어야 한다: {s}")


def day_dirs(d0, d1):
    """~/tmp 의 날짜 폴더 중 범위 안의 것. 2026-09-18 과 20260918 두 이름 형식 모두."""
    out = []
    for name in sorted(os.listdir(T)):
        p = os.path.join(T, name)
        if not os.path.isdir(p) or os.path.islink(p):
            continue
        m = re.fullmatch(r"(\d{4})-?(\d{2})-?(\d{2})", name)
        if not m:
            continue
        d = datetime.date(*map(int, m.groups()))
        if d0 <= d <= d1:
            out.append(p)
    return out


def keep_patterns():
    keep = set()
    if os.path.exists(KEEP_LIST):
        for ln in open(KEEP_LIST):
            ln = ln.split("#", 1)[0].strip()
            if ln:
                keep.update(os.path.realpath(p) for p in glob.glob(os.path.join(T, ln), recursive=True))
    return keep


def linked_targets():
    """~/project, ~/videos 에서 ~/tmp 안을 가리키는 심볼릭 링크의 대상."""
    keep = set()
    for root in LINK_ROOTS:
        for r, ds, fs in os.walk(root):
            ds[:] = [d for d in ds if d not in (".git", "node_modules", "__pycache__")]
            for f in fs + ds:
                p = os.path.join(r, f)
                if os.path.islink(p):
                    tgt = os.path.realpath(p)
                    if tgt.startswith(T + os.sep):
                        keep.add(tgt)
    return keep


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("start", help="시작일 260901")
    ap.add_argument("end", nargs="?", help="끝일 260930 (생략하면 시작일 하루)")
    ap.add_argument("--apply", action="store_true", help="실제로 지운다 (없으면 목록만)")
    a = ap.parse_args()
    d0 = parse_day(a.start)
    d1 = parse_day(a.end) if a.end else d0
    if d1 < d0:
        sys.exit("끝일이 시작일보다 앞이다")
    if d1 >= datetime.date.today():
        sys.exit("오늘 폴더는 정리 대상에서 뺀다 (작업 중)")

    dirs = day_dirs(d0, d1)
    if not dirs:
        sys.exit(f"{d0} ~ {d1} 에 해당하는 폴더가 없다")
    keep_pat = keep_patterns()
    keep_link = linked_targets()

    dele, kept, why = [], collections.Counter(), collections.Counter()
    for d in dirs:
        for r, _, fs in os.walk(d):
            for f in fs:
                p = os.path.join(r, f)
                e = os.path.splitext(f)[1].lower()
                rp = os.path.realpath(p)
                if e in KEEP_EXT:
                    kept[e] += 1
                elif e in NEVER_EXT:
                    why["영상"] += 1
                elif rp in keep_pat:
                    why["prune_keep.txt"] += 1
                elif rp in keep_link:
                    why["링크 대상"] += 1
                else:
                    dele.append(p)

    size = lambda p: os.lstat(p).st_size
    by_n, by_sz = collections.Counter(), collections.Counter()
    for p in dele:
        e = os.path.splitext(p)[1].lower() or "(없음)"
        by_n[e] += 1
        by_sz[e] += size(p)
    tot = sum(by_sz.values())

    print(f"대상 폴더 {len(dirs)}개: {os.path.basename(dirs[0])} ~ {os.path.basename(dirs[-1])}")
    print(f"지울 것  {len(dele)}개  {tot / 1e6:.1f} MB")
    for e, n in by_sz.most_common(12):
        print(f"   {e:<14} {by_n[e]:6d}개 {n / 1e6:9.1f} MB")
    print("남길 것  " + ", ".join(f"{k} {v}" for k, v in kept.most_common()))
    for k, v in why.items():
        print(f"   + {k} {v}개")
    warn = [p for p in dele if os.path.splitext(p)[1].lower() in WARN_EXT and not os.path.islink(p)]
    if warn:
        warn.sort(key=size, reverse=True)
        print(f"\n확인 필요 (맵/어휘/config {len(warn)}개, 큰 것부터 10개) — 남기려면 prune_keep.txt 에 추가")
        for p in warn[:10]:
            print(f"   {size(p) / 1e6:8.1f} MB  {p.replace(T, '~/tmp')}")

    tag = a.start + (f"_{a.end}" if a.end else "")
    outd = os.path.join(T, datetime.date.today().isoformat(), "cleanup")
    os.makedirs(outd, exist_ok=True)
    lst = os.path.join(outd, f"prune_{tag}.txt")
    open(lst, "w").write("\n".join(dele) + ("\n" if dele else ""))
    print(f"\n목록: {lst.replace(T, '~/tmp')}")

    if not a.apply:
        print("목록만 만들었다. 지우려면 --apply")
        return
    # 안전검사: 남겨야 할 확장자나 범위 밖 경로가 섞였으면 중단
    bad = [p for p in dele if os.path.splitext(p)[1].lower() in KEEP_EXT | NEVER_EXT
           or not any(p.startswith(d + os.sep) for d in dirs)]
    if bad:
        sys.exit(f"안전검사 실패 {len(bad)}개, 아무것도 지우지 않았다: {bad[:3]}")
    for p in dele:
        os.remove(p)  # 심볼릭 링크면 링크만 지운다
    for d in dirs:
        for r, ds, fs in os.walk(d, topdown=False):
            if r != d and not os.listdir(r):
                os.rmdir(r)
    print(f"삭제 완료 {len(dele)}개, {tot / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
