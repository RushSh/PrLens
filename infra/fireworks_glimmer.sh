#!/usr/bin/env bash
# Muse Glimmer 30B (BF16) on one NVIDIA H200 141GB as a Fireworks on-demand deployment.
#
#   scripts/fireworks_glimmer.sh up       create the deployment (asks first; billed per GPU-second)
#   scripts/fireworks_glimmer.sh status   show it
#   scripts/fireworks_glimmer.sh down     delete it (stops all billing)
#
# Needs firectl >= 1.8.8 (brew tap fw-ai/firectl && brew install firectl; firectl signin)
# and FIREWORKS_API_KEY in .env. After `up`, put the printed line in .env:
#   FIREWORKS_GLIMMER_MODEL=accounts/<account>/deployments/<id>
#
# Cost guard: the deployment scales to zero after SCALE_TO_ZERO idle (default 15m), so a forgotten
# deployment stops costing money soon after the last request. Run `down` when you are done anyway.
set -euo pipefail

MODEL="accounts/fireworks/models/muse-glimmer-30b"
# The deployment in .env (FIREWORKS_GLIMMER_MODEL=accounts/<acct>/deployments/<id>) wins, so status/down
# act on the deployment PR Lens is actually using, even one created in the Fireworks console.
ENV_MODEL=$(grep -E '^FIREWORKS_GLIMMER_MODEL=' "$(dirname "$0")/../.env" 2>/dev/null | cut -d= -f2- | tr -d '"' || true)
ENV_ID=""
case "$ENV_MODEL" in */deployments/*) ENV_ID="${ENV_MODEL##*/}" ;; esac
DEPLOYMENT_ID="${FIREWORKS_DEPLOYMENT_ID:-${ENV_ID:-prlens-glimmer}}"
SCALE_TO_ZERO="${SCALE_TO_ZERO:-15m}"
PRICE_PER_HOUR="8.00"   # NVIDIA H200 141GB, 1 GPU, as quoted on Oct 27 2026; check your Fireworks console

cd "$(dirname "$0")/.."
command -v firectl >/dev/null || { echo "firectl not found: brew tap fw-ai/firectl && brew install firectl"; exit 1; }

case "${1:-}" in
  up)
    cat <<EOF
About to create a Fireworks on-demand deployment:
  model         $MODEL (BF16)
  GPU           1 x NVIDIA_H200_141GB, 1 replica max
  price         about \$$PRICE_PER_HOUR per hour while a replica is running (billed per GPU-second)
  idle stop     scales to zero after $SCALE_TO_ZERO without requests (first request after that waits for a cold start)
EOF
    read -r -p "Create it? Type 'yes' to continue: " ok
    [ "$ok" = "yes" ] || { echo "Cancelled."; exit 1; }
    firectl deployment create "$MODEL" \
      --deployment-id "$DEPLOYMENT_ID" \
      --deployment-shape default \
      --accelerator-type NVIDIA_H200_141GB \
      --accelerator-count 1 \
      --precision BF16 \
      --min-replica-count 0 \
      --max-replica-count 1 \
      --scale-up-window 30s \
      --scale-down-window 5m \
      --scale-to-zero-window "$SCALE_TO_ZERO" \
      --wait
    ACCOUNT=$(firectl deployment get "$DEPLOYMENT_ID" | awk -F'/' '/^Name:/ {print $2; exit}')
    echo
    if [ -n "$ACCOUNT" ]; then
      echo "Ready. Add this to .env:"
      echo "  FIREWORKS_GLIMMER_MODEL=accounts/${ACCOUNT}/deployments/${DEPLOYMENT_ID}"
    else
      echo "Ready. Add FIREWORKS_GLIMMER_MODEL=<the Name: value below> to .env:"
      firectl deployment get "$DEPLOYMENT_ID"
    fi
    echo "Then pick 'glimmer_fw' as a reviewer. Delete it when done: scripts/fireworks_glimmer.sh down"
    ;;
  status)
    echo "deployment: $DEPLOYMENT_ID"
    firectl deployment get "$DEPLOYMENT_ID"
    ;;
  down)
    echo "Deleting deployment $DEPLOYMENT_ID"
    firectl deployment delete "$DEPLOYMENT_ID"
    echo "Deleted. No further charges for this deployment."
    ;;
  *)
    sed -n '2,13p' "$0"; exit 1 ;;
esac
