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
# <task>.events.jsonl (the session), <task>.meta.json. Safe to re-run: finished tasks are skipped, and a task
# stopped with Ctrl-C is not saved. Run it in its own terminal window and let it finish.
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$ROOT/data/work/agent_study"
OUT="$ROOT/data/agent_study/results"
RUN="$HOME/muse_agent_study"
JOBS="${JOBS:-3}"
STEPS="${STEPS:-150}"
LIMIT="${LIMIT:-900}"    # seconds per task
mkdir -p "$OUT" "$RUN"
command -v muse >/dev/null || { echo "muse is not on PATH"; exit 1; }
muse --version > "$OUT/muse_version.txt" 2>&1

one() {
  name="$1"
  [ -f "$OUT/$name.diff" ] && { echo "skip (done): $name"; return; }
  rm -rf "$RUN/$name" && cp -R "$SRC/$name" "$RUN/$name"
  start=$(date +%s); echo "start $name  $(date +%H:%M:%S)"
  ( cd "$RUN/$name/repo" && exec muse exec --prompt-file ../prompt.txt --workspace . \
      --approval-mode never --disable-web-tools --disable-request-user-input --no-foreign-personal-context \
      --max-model-steps "$STEPS" --json > ../events.jsonl 2> ../stderr.txt ) &
  pid=$!
  # a progress line every 30 s, and a time limit per task
  while kill -0 "$pid" 2>/dev/null; do
    sleep 30
    kill -0 "$pid" 2>/dev/null || break
    el=$(( $(date +%s) - start ))
    calls=$(grep -c '"tool.result"' "$RUN/$name/events.jsonl" 2>/dev/null || echo 0)
    files=$(cd "$RUN/$name/repo" && git status --porcelain 2>/dev/null | wc -l | tr -d ' ')
    echo "  $name: $((el / 60))m$((el % 60))s, $calls tool calls, $files files changed"
    if [ "$el" -ge "$LIMIT" ]; then echo "  $name: time limit (${LIMIT}s) reached, stopping it"; kill "$pid" 2>/dev/null; sleep 2; kill -9 "$pid" 2>/dev/null; fi
  done
  wait "$pid"; rc=$?
  cp "$RUN/$name/events.jsonl" "$OUT/$name.events.jsonl" 2>/dev/null
  tail -c 4000 "$RUN/$name/stderr.txt" > "$OUT/$name.stderr.txt" 2>/dev/null
  if [ "$rc" -eq 130 ] || [ "$rc" -eq 143 ] && [ "$(( $(date +%s) - start ))" -lt "$LIMIT" ]; then
    echo "stopped $name (interrupted; not saved, it will run again next time)"; return 130
  fi
  ( cd "$RUN/$name/repo" && git add -A >/dev/null 2>&1 && git diff --cached > "$OUT/$name.diff.tmp" )
  lines=$(grep -c '^[+-][^+-]' "$OUT/$name.diff.tmp" || true)
  printf '{"task":"%s","exit_code":%s,"seconds":%s,"changed_lines":%s,"steps_cap":%s}\n' \
    "$name" "$rc" "$(( $(date +%s) - start ))" "${lines:-0}" "$STEPS" > "$OUT/$name.meta.json"
  # the time limit counts as a finished attempt (the agent ran out of time), recorded by its exit code
  mv "$OUT/$name.diff.tmp" "$OUT/$name.diff"
  echo "done  $name  exit $rc, ${lines:-0} changed lines, $(( $(date +%s) - start ))s"
}
export -f one; export OUT SRC RUN STEPS LIMIT

trap 'echo "interrupted: finished tasks are kept; run again to continue"; kill 0; exit 130' INT TERM
if [ $# -gt 0 ]; then for n in "$@"; do one "$n" || exit 130; done; exit; fi
ls "$SRC" | xargs -P "$JOBS" -I{} bash -c 'one "$@"' _ {}
echo "all done: $(ls "$OUT"/*.diff 2>/dev/null | wc -l | tr -d ' ') of $(ls "$SRC" | wc -l | tr -d ' ') tasks have a result"
