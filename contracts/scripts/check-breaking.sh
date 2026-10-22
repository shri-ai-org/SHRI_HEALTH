#!/usr/bin/env bash
# Breaking-change check (CONTRACT_GOVERNANCE §4): compares this branch's bundled contract with the one on the base
# branch. Fails on any breaking change. In CI, the job may pass anyway when the PR carries the
# "breaking-change-approved" label applied by Vimal (checked through the GitHub API by the CI job, TOOLCHAIN §6).
#   BASE_REF  git ref to compare against (default: origin/main)
set -euo pipefail
cd "$(dirname "$0")/.."

BASE_REF="${BASE_REF:-origin/main}"
BIN=".tools/oasdiff-1.33.0/oasdiff"
[ -x "$BIN" ] || bash scripts/install-oasdiff.sh

npm run -s bundle
BASE_FILE="$(mktemp --suffix=.yaml)"
trap 'rm -f "$BASE_FILE"' EXIT
if ! git show "${BASE_REF}:contracts/openapi/dist/shri-health.bundled.yaml" > "$BASE_FILE" 2>/dev/null; then
  echo "No bundled contract on ${BASE_REF} yet, so there is nothing to compare against."
  exit 0
fi
echo "Comparing ${BASE_REF} → working tree"
"$BIN" breaking "$BASE_FILE" openapi/dist/shri-health.bundled.yaml --fail-on ERR
echo "No breaking changes."
