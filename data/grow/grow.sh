#!/bin/bash
# Grow the evaluation set: mine new bug fixes, then confirm each by running its tests (no model calls, no cost).
# Run on the Mac, from the BugCensus folder, with the project's venv active; one language per terminal window:
#
#   bash data/grow/grow.sh python
#   bash data/grow/grow.sh typescript
#   bash data/grow/grow.sh csharp      # needs the .NET 8 and 10 SDKs (dotnet on PATH)
#
# Safe to stop and re-run: mining is skipped once its file exists, and validation resumes where it stopped.
# Progress: one line per candidate (CONFIRMED / rejected / SKIP). Expect a few hours per language.
set -u
cd "$(dirname "$0")/../.."
lang="${1:?usage: grow.sh python|typescript|csharp}"
PER_REPO="${PER_REPO:-15}"
export PYTHONPATH=src
PY="${PY:-python}"
case "$lang" in
  python)     repos=data/repos/python_v2.txt;     copies=data/work/validate_mac ;;
  typescript) repos=data/repos/typescript_v2.txt; copies=data/work/validate_mac ;;
  csharp)     repos=data/repos/csharp_v2.txt;     copies=data/work/validate_mac
              export NUGET_PACKAGES="${NUGET_PACKAGES:-$PWD/data/work/caches/nuget}" ;;
  *) echo "language must be python, typescript or csharp"; exit 1 ;;
esac
cand=data/candidates_${lang}_v2.jsonl
sample=data/candidates_${lang}_v2_sample.jsonl
out=data/bugs_${lang}_v2.jsonl

if [ ! -s "$cand" ]; then
  echo "== mining $lang repositories (fixes since 2025-06-01)"
  "$PY" -m prlens mine --repos "$repos" --language "$lang" --since 2025-06-01 --out "$cand" --workdir data/raw || exit 1
fi
if [ ! -s "$sample" ]; then
  "$PY" -m prlens sample --candidates "$cand" --per-repo "$PER_REPO" --out "$sample" || exit 1
fi
echo "== validating $(wc -l < "$sample" | tr -d ' ') $lang candidates -> $out"
"$PY" -m prlens validate --candidates "$sample" --repos "$repos" --workdir data/raw --copies "$copies" --out "$out"
echo "== done: $(grep -c . "$out" 2>/dev/null || echo 0) confirmed bugs in $out"
