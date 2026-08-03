#!/usr/bin/env bash
#
# Deploy apps/web to Railway and report the deployment's REAL outcome.
#
# `railway up --ci` uploads the build context, then streams build logs and exits
# on what the stream tells it. When the stream drops — which it does
# intermittently in CI ("Failed to stream build logs: Failed to retrieve build
# log") — the CLI exits 1 while the build carries on server-side. Trusting that
# exit code alone produces a false red on a deploy that actually succeeded, and
# worse, a green-looking rerun that races the first build.
#
# So: run the CLI, and if it exits non-zero, resolve the deployment it created
# and poll the Railway API for the real terminal state. Only a genuine
# FAILED/CRASHED (or a timeout) fails this script.
#
# Requires: RAILWAY_TOKEN (environment-scoped project token), RAILWAY_SERVICE_ID.
set -euo pipefail

: "${RAILWAY_TOKEN:?RAILWAY_TOKEN is required}"
: "${RAILWAY_SERVICE_ID:?RAILWAY_SERVICE_ID is required}"

POLL_INTERVAL="${POLL_INTERVAL:-15}"
POLL_ATTEMPTS="${POLL_ATTEMPTS:-80}" # 80 x 15s = 20 min
LOG=$(mktemp)

deployment_status() {
  curl -sS -X POST https://backboard.railway.com/graphql/v2 \
    -H "Project-Access-Token: ${RAILWAY_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{\"query\":\"query { deployment(id: \\\"$1\\\") { status } }\"}" |
    python3 -c 'import sys,json
try:
    print(json.load(sys.stdin)["data"]["deployment"]["status"])
except Exception:
    print("UNKNOWN")'
}

echo "==> railway up --ci --service ${RAILWAY_SERVICE_ID}"
if railway up --ci --service "${RAILWAY_SERVICE_ID}" 2>&1 | tee "${LOG}"; then
  echo "==> CLI reported success"
  exit 0
fi

echo "::warning title=Railway CLI exited non-zero::Resolving the deployment's real state via the API before failing."

# The CLI prints a build-logs URL containing `?id=<uuid>` before it streams.
DEPLOYMENT_ID=$(grep -oE 'id=[0-9a-fA-F-]{36}' "${LOG}" | head -1 | cut -d= -f2 || true)

if [ -z "${DEPLOYMENT_ID}" ]; then
  echo "::error title=Railway deploy failed::The CLI failed before creating a deployment, so there is nothing to poll. Treating as a real failure."
  exit 1
fi

echo "==> polling deployment ${DEPLOYMENT_ID}"
for i in $(seq 1 "${POLL_ATTEMPTS}"); do
  STATUS=$(deployment_status "${DEPLOYMENT_ID}")
  echo "    [${i}/${POLL_ATTEMPTS}] ${STATUS}"
  case "${STATUS}" in
    SUCCESS)
      echo "::notice title=Railway deploy succeeded::The CLI exit code was a dropped log stream, not a build failure."
      exit 0
      ;;
    FAILED | CRASHED | REMOVED)
      echo "::error title=Railway deploy failed::Deployment ${DEPLOYMENT_ID} ended in ${STATUS}."
      exit 1
      ;;
  esac
  sleep "${POLL_INTERVAL}"
done

echo "::error title=Railway deploy timed out::Deployment ${DEPLOYMENT_ID} did not reach a terminal state within $((POLL_INTERVAL * POLL_ATTEMPTS))s."
exit 1
