#!/bin/bash
# The closed loop, step 2: Muse Code suggests a fix for the regions PR Lens flagged (after `prlens suggest prepare`).
#
#   cd ~/Desktop/Repos/BugCensus
#   bash data/agent_study/run_suggest.sh                    # every prepared PR not done yet, 3 at a time
#   bash data/agent_study/run_suggest.sh boltons__89bb0a8b96
#
# Same rules as run_muse.sh: a copy under ~/muse_suggest (outside this repository), web tools off, approvals off,
# sandbox ON. Each workspace has two commits (baseline, the agent's change); Muse Code sees the flagged regions with
# their Muse Spark notes and questions, never the bug label or the later fix. Results land in
# data/agent_study/suggest/: <task>.diff (the suggestion alone), <task>.combined.diff (agent change + suggestion,
# against the baseline), <task>.events.jsonl, <task>.meta.json.
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$ROOT/data/work/suggest"
OUT="$ROOT/data/agent_study/suggest"
RUN="$HOME/muse_suggest"
JOBS="${JOBS:-3}"
STEPS="${STEPS:-150}"
LIMIT="${LIMIT:-600}"    # seconds per task
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
  ( cd "$RUN/$name/repo" && git add -A >/dev/null 2>&1 && git diff --cached HEAD > "$OUT/$name.diff.tmp" \
      && git diff --cached HEAD~1 > "$OUT/$name.combined.diff" )
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
echo "all done: $(ls "$OUT"/*.combined.diff 2>/dev/null | wc -l | tr -d ' ') of $(ls "$SRC" | wc -l | tr -d ' ') have a suggestion"
