#!/usr/bin/env python3
"""Keep a permanent daily record of coding-agent CLI usage, across machines.

Two things make a plain `ccusage --since` insufficient.

  * It reports one machine.  Work done in Windows and work done in WSL live in
    separate session trees, so neither run sees the other's history: WSL starts
    13 July 2026, Windows reaches back to 22 December 2025 (and picks up Codex
    as well as Claude).
  * It recomputes from the session .jsonl files every time, so anything those
    files no longer cover simply disappears from the report.

So this does not "add yesterday".  It asks every configured source for the whole
table it can still see and MERGES the answers into a CSV that never drops a row.
Rows are keyed by (date, source), so two machines used on the same day add up
instead of overwriting each other.  Re-running is always safe and a missed day
repairs itself on the next run.

Note on cost: ccusage prices tokens at API rates.  On a Max subscription those
dollars are what the usage WOULD have cost, not what was paid.

    usage_snapshot.py [--data-dir ~/ai-usage] [--artifact PATH] [--print]
"""
import argparse
import csv
import json
import os
import shutil
import subprocess
import sys
from collections import defaultdict
from datetime import date, datetime

DAILY_COLS = ["date", "source", "cost_usd", "input", "output", "cache_create",
              "cache_read", "total_tokens", "agents", "models",
              "first_seen", "last_seen"]
MODEL_COLS = ["date", "source", "model", "cost_usd", "input", "output",
              "cache_create", "cache_read", "first_seen", "last_seen"]
DAILY_KEY = ["date", "source"]
MODEL_KEY = ["date", "source", "model"]


# ---------------------------------------------------------------- sources ---

def _parse(stdout):
    """ccusage's JSON, past any npm/npx notices printed before it."""
    i = stdout.find("{")
    if i < 0:
        return None
    try:
        return json.loads(stdout[i:]).get("daily", [])
    except json.JSONDecodeError:
        return None


def _run(cmd, cwd=None, env=None, timeout=900):
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, errors="replace",
                           cwd=cwd, env=env, timeout=timeout)
    except Exception as e:                                        # noqa: BLE001
        return None, str(e)
    if p.returncode != 0:
        return None, f"exit {p.returncode}"
    rows = _parse(p.stdout)
    if not rows:
        return None, "no usable JSON"
    return rows, None


def source_local():
    """This machine.  A real binary first, then npx without a network install."""
    attempts = []
    exe = shutil.which("ccusage")
    if exe and not exe.startswith("/mnt/"):        # a Windows shim is not runnable here
        attempts.append([exe, "daily", "--json"])
    if shutil.which("npx"):
        attempts.append(["npx", "--no-install", "ccusage", "daily", "--json"])
        attempts.append(["npx", "ccusage", "daily", "--json"])
    for cmd in attempts:
        rows, err = _run(cmd)
        if rows:
            return rows, f"via {' '.join(cmd[:2])}"
        print(f"    {' '.join(cmd[:2])}: {err}", file=sys.stderr)
    return None, "no working ccusage"


def source_windows():
    """The Windows install, run natively so it uses its OWN path discovery.

    Pointing CLAUDE_CONFIG_DIR at /mnt/c/.../.claude from here finds strictly
    less: 27 April onward and Claude only, against 22 December and Codex too
    when Windows resolves the paths itself.
    """
    cmd_exe = "/mnt/c/Windows/System32/cmd.exe"
    if not os.path.exists(cmd_exe):
        return None, "not a WSL host"
    rows, err = _run([cmd_exe, "/c", "ccusage daily --json"], cwd="/mnt/c")
    return (rows, "via cmd.exe") if rows else (None, err)



def source_manual(data_dir):
    """Days recovered by hand, from a CSV the user maintains.

    Claude Code deletes conversation transcripts older than `cleanupPeriodDays`
    (default 30), so a month that has aged out cannot be recomputed by any tool.
    If the numbers survive somewhere else -- an old ccusage screenshot, a report
    shared with someone -- this is where they go back in.

    manual.csv columns: date, models, input, output, cache_create, cache_read,
    total_tokens, cost_usd, note.  Per-model costs are not asked for, because a
    screenshot rarely has them; such days show up under "분해 없음" in the model
    table rather than being silently attributed.
    """
    path = os.path.join(data_dir, "manual.csv")
    if not os.path.exists(path):
        return None, "no manual.csv"
    rows = []
    with open(path, encoding="utf-8-sig", newline="") as f:
        for r in csv.DictReader(f):
            if not (r.get("date") or "").strip():
                continue
            num = lambda k: int(float(r.get(k) or 0))
            rows.append({
                "period": r["date"].strip(),
                "totalCost": float(r.get("cost_usd") or 0),
                "inputTokens": num("input"), "outputTokens": num("output"),
                "cacheCreationTokens": num("cache_create"),
                "cacheReadTokens": num("cache_read"),
                "totalTokens": num("total_tokens"),
                "modelsUsed": (r.get("models") or "").split(),
                "metadata": {"agents": ["claude"]},
                "modelBreakdowns": [],
            })
    return (rows, f"from {os.path.basename(path)}") if rows else (None, "manual.csv empty")


SOURCES = [("wsl", source_local), ("windows", source_windows),
           ("manual", source_manual)]


# -------------------------------------------------------------------- csv ---

def read_csv(path, key):
    if not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8-sig", newline="") as f:
        rows = {}
        for r in csv.DictReader(f):
            # tolerate a CSV written before `source` existed
            r.setdefault("source", "wsl")
            rows[tuple(r.get(k, "") for k in key)] = r
        return rows


def write_csv(path, cols, rows, key):
    """UTF-8 with a BOM so Excel opens it without mangling the model names."""
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        for r in sorted(rows, key=lambda x: tuple(str(x.get(k, "")) for k in key)):
            w.writerow({c: r.get(c, "") for c in cols})
    os.replace(tmp, path)


def merge(old, new, today, refreshed_sources):
    """Union old and new; never drop a row a source can no longer see.

    Only rows belonging to a source that actually answered this run are eligible
    to be refreshed -- otherwise a source failing to run would look like every
    one of its days had gone quiet.
    """
    out = dict(old)
    added = updated = 0
    for k, row in new.items():
        prev = out.get(k)
        if prev is None:
            row["first_seen"] = row["last_seen"] = today
            out[k] = row
            added += 1
        else:
            changed = any(str(prev.get(c, "")) != str(row.get(c, ""))
                          for c in row if c not in ("first_seen", "last_seen"))
            row["first_seen"] = prev.get("first_seen", today)
            row["last_seen"] = today
            out[k] = row
            updated += changed
    stale = sum(1 for k, r in out.items()
                if r.get("source") in refreshed_sources and k not in new)
    return out, added, updated, stale


# ----------------------------------------------------------------- render ---

def by_date(daily):
    """Collapse the per-source rows into one row per calendar day."""
    agg = defaultdict(lambda: dict(cost=0.0, out=0, tok=0,
                                   agents=set(), models=set(), sources=set()))
    for r in daily.values():
        a = agg[r["date"]]
        a["cost"] += float(r["cost_usd"] or 0)
        a["out"] += int(r["output"] or 0)
        a["tok"] += int(r["total_tokens"] or 0)
        a["agents"].update(filter(None, (r.get("agents") or "").split()))
        a["models"].update(filter(None, (r.get("models") or "").split()))
        a["sources"].add(r.get("source", ""))
    return agg


def month_table(days):
    by = defaultdict(lambda: dict(days=0, cost=0.0, tok=0, out=0))
    for d, v in days.items():
        m = by[d[:7]]
        m["days"] += 1
        m["cost"] += v["cost"]
        m["tok"] += v["tok"]
        m["out"] += v["out"]
    return by


def render_html(daily, models, path, data_dir, artifact=False):
    days = by_date(daily)
    order = sorted(days)
    months = month_table(days)

    per_model = defaultdict(float)
    per_source = defaultdict(lambda: dict(cost=0.0, days=0, lo="9999", hi="0000"))
    for r in models.values():
        per_model[r["model"]] += float(r["cost_usd"] or 0)
    for r in daily.values():
        s = per_source[r.get("source", "?")]
        s["cost"] += float(r["cost_usd"] or 0)
        s["days"] += 1
        s["lo"] = min(s["lo"], r["date"])
        s["hi"] = max(s["hi"], r["date"])

    total_cost = sum(v["cost"] for v in days.values())
    total_tok = sum(v["tok"] for v in days.values())
    peak = max((v["cost"] for v in days.values()), default=1) or 1
    esc = lambda s: (str(s).replace("&", "&amp;").replace("<", "&lt;")
                     .replace(">", "&gt;"))

    day_rows = "\n".join(
        f'<tr><td class="d">{d}</td>'
        f'<td class="n">${days[d]["cost"]:,.2f}</td>'
        f'<td class="bar"><span style="width:'
        f'{max(1.0, 100 * days[d]["cost"] / peak):.1f}%"></span></td>'
        f'<td class="n">{days[d]["out"]:,}</td>'
        f'<td class="n">{days[d]["tok"]:,}</td>'
        f'<td class="m">{esc(" ".join(sorted(days[d]["models"])))}</td></tr>'
        for d in reversed(order))

    mo_rows = "\n".join(
        f'<tr><td class="d">{k}</td><td class="n">{v["days"]}</td>'
        f'<td class="n big">${v["cost"]:,.2f}</td>'
        f'<td class="n">${v["cost"] / max(v["days"], 1):,.2f}</td>'
        f'<td class="n">{v["out"]:,}</td><td class="n">{v["tok"]:,}</td></tr>'
        for k, v in sorted(months.items(), reverse=True))

    unsplit = total_cost - sum(per_model.values())
    md = sorted(per_model.items(), key=lambda x: -x[1])
    if unsplit > 0.005:
        md.append(("분해 없음 (수기 복원분)", unsplit))
    md_rows = "\n".join(
        f'<tr><td class="d">{esc(k)}</td><td class="n">${v:,.2f}</td>'
        f'<td class="n">{100 * v / max(total_cost, 1e-9):.1f}%</td></tr>'
        for k, v in md)

    src_rows = "\n".join(
        f'<tr><td class="d">{esc(k)}</td><td class="n">{v["days"]}</td>'
        f'<td class="n">${v["cost"]:,.2f}</td>'
        f'<td class="d">{v["lo"]} – {v["hi"]}</td></tr>'
        for k, v in sorted(per_source.items(), key=lambda x: -x[1]["cost"]))

    body = BODY.format(
        generated=datetime.now().strftime("%Y-%m-%d %H:%M"),
        n_days=len(order),
        span=f"{order[0]} – {order[-1]}" if order else "-",
        total_cost=f"{total_cost:,.2f}", total_tok=f"{total_tok:,}",
        this_month=f"{months.get(date.today().strftime('%Y-%m'), {}).get('cost', 0):,.2f}",
        mo_rows=mo_rows, md_rows=md_rows, src_rows=src_rows, day_rows=day_rows,
        data_dir=esc(data_dir))

    if artifact:
        html = HEAD + body                # the Artifact host supplies the skeleton
    else:
        html = ('<!doctype html>\n<html lang="ko"><head><meta charset="utf-8">\n'
                '<meta name="viewport" content="width=device-width,initial-scale=1">\n'
                + HEAD + '</head><body>\n' + body + '</body></html>\n')
    with open(path, "w", encoding="utf-8") as f:
        f.write(html)


HEAD = """<title>AI CLI 사용량</title>
<style>
:root{--bg:#F7F8FA;--card:#fff;--ink:#151B23;--ink2:#414D5B;--mut:#6E7B89;
      --line:#DFE5EC;--ac:#1D6FA5;--bar:#9DC7E4}
@media(prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#0E131A;
      --card:#171F29;--ink:#E7ECF2;--ink2:#BCC7D3;--mut:#8C99A8;--line:#28323E;
      --ac:#63AEE0;--bar:#2E5D7D}}
:root[data-theme="dark"]{--bg:#0E131A;--card:#171F29;--ink:#E7ECF2;--ink2:#BCC7D3;
      --mut:#8C99A8;--line:#28323E;--ac:#63AEE0;--bar:#2E5D7D}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
 font:15px/1.6 system-ui,-apple-system,"Segoe UI","Noto Sans KR",sans-serif}
.wrap{max-width:1060px;margin:0 auto;padding:40px 24px 80px}
h1{font-size:30px;margin:0 0 6px;letter-spacing:-.02em}
.sub{color:var(--mut);font-size:14px;margin:0 0 30px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:14px;margin-bottom:34px}
.c{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px 18px}
.c .k{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--mut);margin-bottom:6px}
.c .v{font-size:26px;font-weight:650;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.c .u{font-size:12px;color:var(--mut);margin-top:2px}
h2{font-size:17px;margin:32px 0 12px;font-weight:650}
.scroll{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:10px}
table{border-collapse:collapse;width:100%;min-width:560px;font-size:13.5px;
 font-variant-numeric:tabular-nums}
th,td{padding:8px 14px;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap}
th{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--mut);
 font-weight:600;position:sticky;top:0;background:var(--card)}
td.d,th:first-child{text-align:left;font-variant-numeric:normal}
td.m{text-align:left;color:var(--mut);font-size:12px;white-space:normal}
td.big{font-weight:650;color:var(--ac)}
tr:last-child td{border-bottom:0}
td.bar{width:120px;padding:8px 10px}
td.bar span{display:block;height:8px;border-radius:2px;background:var(--bar)}
.tall{max-height:520px;overflow-y:auto}
.note{color:var(--mut);font-size:13px;margin:8px 0 0;max-width:70ch}
footer{margin-top:38px;padding-top:16px;border-top:1px solid var(--line);
 color:var(--mut);font-size:12.5px}
footer p{margin:0 0 6px}
code{background:var(--bg);padding:.1em .4em;border-radius:3px}
</style>
"""

BODY = """<div class="wrap">
<h1>AI CLI 사용량</h1>
<p class="sub">{generated} 갱신 · 기록 {n_days}일 ({span})</p>

<div class="cards">
  <div class="c"><div class="k">이번 달</div><div class="v">${this_month}</div><div class="u">누적</div></div>
  <div class="c"><div class="k">전체</div><div class="v">${total_cost}</div><div class="u">API 환산</div></div>
  <div class="c"><div class="k">토큰</div><div class="v">{total_tok}</div><div class="u">전체 합</div></div>
  <div class="c"><div class="k">기록일</div><div class="v">{n_days}</div><div class="u">사용한 날</div></div>
</div>

<h2>월별</h2>
<div class="scroll"><table>
<thead><tr><th>월</th><th>사용일</th><th>비용</th><th>일평균</th><th>출력 토큰</th><th>전체 토큰</th></tr></thead>
<tbody>{mo_rows}</tbody></table></div>

<h2>모델별</h2>
<div class="scroll"><table>
<thead><tr><th>모델</th><th>비용</th><th>비중</th></tr></thead>
<tbody>{md_rows}</tbody></table></div>

<h2>수집 경로별</h2>
<div class="scroll"><table>
<thead><tr><th>소스</th><th>기록일</th><th>비용</th><th>범위</th></tr></thead>
<tbody>{src_rows}</tbody></table></div>
<p class="note">Windows와 WSL은 세션 파일이 서로 분리돼 있어 같은 날짜라도 합산된다.
같은 세션을 두 소스가 동시에 보는 경우는 없다.</p>

<h2>일별</h2>
<div class="scroll tall"><table>
<thead><tr><th>날짜</th><th>비용</th><th></th><th>출력 토큰</th><th>전체 토큰</th><th>모델</th></tr></thead>
<tbody>{day_rows}</tbody></table></div>

<footer>
<p>원본: <code>{data_dir}/daily.csv</code> · <code>daily_models.csv</code> — Excel에서 바로 열림.</p>
<p>비용은 ccusage의 API 요금 환산값이다. Max 구독 기간은 실제 결제액이 아니라 <em>API로 썼다면</em> 들었을 금액.</p>
<p>ccusage가 더 못 보는 날짜도 CSV에는 남는다. 한 번 기록된 날은 사라지지 않음.</p>
</footer>
</div>
"""


# ------------------------------------------------------------------- main ---

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", default=os.path.expanduser("~/ai-usage"))
    ap.add_argument("--only", metavar="SOURCE", action="append",
                    help="restrict to these sources (repeatable)")
    ap.add_argument("--no-html", action="store_true")
    ap.add_argument("--artifact", metavar="PATH",
                    help="also write a body-only page for publishing as an Artifact")
    ap.add_argument("--print", dest="show", action="store_true",
                    help="print the monthly table to stdout")
    a = ap.parse_args()

    os.makedirs(a.data_dir, exist_ok=True)
    today = date.today().isoformat()
    d_csv = os.path.join(a.data_dir, "daily.csv")
    m_csv = os.path.join(a.data_dir, "daily_models.csv")
    print(f"[{datetime.now():%F %T}] snapshot -> {a.data_dir}")

    new_d, new_m, ok = {}, {}, set()
    for name, fn in SOURCES:
        if a.only and name not in a.only:
            continue
        rows, note = (fn(a.data_dir) if name == "manual" else fn())
        if not rows:
            print(f"  {name}: unavailable ({note})", file=sys.stderr)
            continue
        ok.add(name)
        print(f"  {name}: {len(rows)} days {note}")
        for r in rows:
            d = r["period"]
            new_d[(d, name)] = {
                "date": d, "source": name,
                "cost_usd": f"{r.get('totalCost', 0):.4f}",
                "input": r.get("inputTokens", 0),
                "output": r.get("outputTokens", 0),
                "cache_create": r.get("cacheCreationTokens", 0),
                "cache_read": r.get("cacheReadTokens", 0),
                "total_tokens": r.get("totalTokens", 0),
                "agents": " ".join(sorted((r.get("metadata") or {}).get("agents", []) or [])),
                "models": " ".join(sorted(r.get("modelsUsed", []) or [])),
            }
            for b in r.get("modelBreakdowns", []) or []:
                new_m[(d, name, b.get("modelName", "?"))] = {
                    "date": d, "source": name, "model": b.get("modelName", "?"),
                    "cost_usd": f"{b.get('cost', 0):.4f}",
                    "input": b.get("inputTokens", 0),
                    "output": b.get("outputTokens", 0),
                    "cache_create": b.get("cacheCreationTokens", 0),
                    "cache_read": b.get("cacheReadTokens", 0),
                }

    if not ok:
        print("  no source answered; leaving the CSV untouched", file=sys.stderr)
    else:
        for path, cols, new, key, label in (
                (d_csv, DAILY_COLS, new_d, DAILY_KEY, "daily"),
                (m_csv, MODEL_COLS, new_m, MODEL_KEY, "models")):
            old = read_csv(path, key)
            merged, added, updated, stale = merge(old, new, today, ok)
            write_csv(path, cols, merged.values(), key)
            print(f"  {label}: {len(merged)} rows  (+{added} new, {updated} refreshed"
                  + (f", {stale} no longer reported" if stale else "") + ")")

    daily = read_csv(d_csv, DAILY_KEY)
    models = read_csv(m_csv, MODEL_KEY)
    if not daily:
        print("  nothing recorded yet", file=sys.stderr)
        return 0

    if not a.no_html:
        html = os.path.join(a.data_dir, "report.html")
        render_html(daily, models, html, a.data_dir)
        print(f"  report -> {html}")
    if a.artifact:
        render_html(daily, models, a.artifact, a.data_dir, artifact=True)
        print(f"  artifact page -> {a.artifact}")

    if a.show:
        days = by_date(daily)
        print(f"\n{'월':<9}{'일':>4}{'비용':>12}{'일평균':>10}")
        tot = 0.0
        for k, v in sorted(month_table(days).items()):
            tot += v["cost"]
            print(f"{k:<9}{v['days']:>4}{v['cost']:>11,.2f}"
                  f"{v['cost'] / max(v['days'], 1):>10,.2f}")
        print(f"{'합계':<9}{len(days):>4}{tot:>11,.2f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
