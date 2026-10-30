#!/bin/bash
# Run the Muse Code agent on every agent-study task, unattended, on the Mac where `muse` is signed in.
#
#   cd ~/Desktop/Repos/BugCensus
#   bash data/agent_study/run_muse.sh                 # every task not done yet, 3 at a time
#   JOBS=1 bash data/agent_study/run_muse.sh          # one at a time
#   bash data/agent_study/run_muse.sh zod__b63db248ab # just one task
#
# Each task runs in a copy of its snapshot under ~/muse_agent_study (outside this repository, so the agent cannot
# read the clones in data/raw), with web tools off (it cannot look up the real commit), approvals off and the
# sandbox ON. Results land in data/agent_study/results/: <task>.diff (the agent's change against the baseline),
# <task>.events.jsonl (the session), <task>.meta.json. Safe to re-run: finished tasks are skipped.
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$ROOT/data/work/agent_study"
OUT="$ROOT/data/agent_study/results"
RUN="$HOME/muse_agent_study"
JOBS="${JOBS:-3}"
STEPS="${STEPS:-150}"
mkdir -p "$OUT" "$RUN"
command -v muse >/dev/null || { echo "muse is not on PATH"; exit 1; }
muse --version > "$OUT/muse_version.txt" 2>&1

one() {
  name="$1"
  [ -f "$OUT/$name.diff" ] && { echo "skip (done): $name"; return; }
  rm -rf "$RUN/$name" && cp -R "$SRC/$name" "$RUN/$name"
  start=$(date +%s); echo "start $name  $(date +%H:%M:%S)"
  ( cd "$RUN/$name/repo" && muse exec --prompt-file ../prompt.txt --workspace . \
      --approval-mode never --disable-web-tools --disable-request-user-input --no-foreign-personal-context \
      --max-model-steps "$STEPS" --json > ../events.jsonl 2> ../stderr.txt )
  rc=$?
  ( cd "$RUN/$name/repo" && git add -A >/dev/null 2>&1 && git diff --cached > "$OUT/$name.diff.tmp" )
  cp "$RUN/$name/events.jsonl" "$OUT/$name.events.jsonl" 2>/dev/null
  tail -c 4000 "$RUN/$name/stderr.txt" > "$OUT/$name.stderr.txt" 2>/dev/null
  lines=$(grep -c '^[+-][^+-]' "$OUT/$name.diff.tmp" || true)
  printf '{"task":"%s","exit_code":%s,"seconds":%s,"changed_lines":%s,"steps_cap":%s}\n' \
    "$name" "$rc" "$(( $(date +%s) - start ))" "${lines:-0}" "$STEPS" > "$OUT/$name.meta.json"
  mv "$OUT/$name.diff.tmp" "$OUT/$name.diff"
  echo "done  $name  exit $rc, ${lines:-0} changed lines, $(( $(date +%s) - start ))s"
}
export -f one; export OUT SRC RUN STEPS

if [ $# -gt 0 ]; then for n in "$@"; do one "$n"; done; exit; fi
ls "$SRC" | xargs -P "$JOBS" -I{} bash -c 'one "$@"' _ {}
echo "all done: $(ls "$OUT"/*.diff 2>/dev/null | wc -l | tr -d ' ') of $(ls "$SRC" | wc -l | tr -d ' ') tasks have a result"
