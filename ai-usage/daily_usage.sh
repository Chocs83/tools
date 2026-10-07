#!/usr/bin/env bash
# Daily usage snapshot.  Run by ai-usage.timer, or by hand any time -- merging is
# idempotent, so re-running never double-counts and a missed day repairs itself.
#
# ccusage lives under nvm, which a systemd user unit does not have on PATH, so
# the newest nvm node is resolved here rather than hard-coded to one version.
set -uo pipefail

ROOT="$HOME/project/tools/ai-usage"
DATA="${AI_USAGE_DIR:-$HOME/ai-usage}"
LOG="$DATA/.state/run.log"
mkdir -p "$DATA/.state"

for d in $(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | sort -V); do
  [ -x "$d/npx" ] && PATH="$d:$PATH"
done
export PATH

{
  echo "=== $(date '+%F %T') ==="
  python3 "$ROOT/usage_snapshot.py" --data-dir "$DATA" "$@"
  echo "rc=$?"
} 2>&1 | tee -a "$LOG"

# keep the log from growing without bound
if [ "$(wc -l < "$LOG" 2>/dev/null || echo 0)" -gt 2000 ]; then
  tail -800 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi
