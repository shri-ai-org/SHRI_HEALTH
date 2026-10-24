#!/usr/bin/env bash
# Breaking-change check (CONTRACT_GOVERNANCE §4): compares this branch's bundled contract with the one on the base
# branch. In CI, a breaking change may pass when the PR carries the "breaking-change-approved" label applied by Vimal
# after the latest commit (checked through the GitHub API by the CI job, TOOLCHAIN §6). A tool or setup failure is
# never a breaking change, so the label cannot override it.
# openapi/oasdiff-severity.txt lowers checks that CONTRACT_GOVERNANCE §4 calls governed, not blocked (adding an enum
# value to a response) to WARN, so they are listed but do not fail the check. The file takes no comments: one
# "check-id LEVEL" per line.
#   BASE_REF  git ref to compare against (default: origin/main)
#
# Exit codes:
#   0  no breaking change (or no bundled contract on the base branch yet)
#   3  a real breaking change, listed above the message
#   2  a tool or setup failure: oasdiff could not be installed or failed, the bundle could not be built,
#      or BASE_REF does not exist
set -euo pipefail
cd "$(dirname "$0")/.."

BASE_REF="${BASE_REF:-origin/main}"
VERSION=1.33.0
BIN=".tools/oasdiff-${VERSION}/oasdiff"

fail() {
  echo "check-breaking: $1. This is a tool or setup failure, not a breaking change." >&2
  exit 2
}

[ -x "$BIN" ] || bash scripts/install-oasdiff.sh || fail "could not install oasdiff ${VERSION}"
[ -x "$BIN" ] || fail "oasdiff ${VERSION} is missing after install"

npm run -s bundle || fail "could not bundle the contract"

git rev-parse --verify --quiet "${BASE_REF}^{commit}" >/dev/null \
  || fail "base ref ${BASE_REF} not found (in CI, check out with fetch-depth: 0)"

BASE_FILE="$(mktemp --suffix=.yaml)"
trap 'rm -f "$BASE_FILE"' EXIT
if ! git cat-file -e "${BASE_REF}:contracts/openapi/dist/shri-health.bundled.yaml" 2>/dev/null; then
  echo "No bundled contract on ${BASE_REF} yet, so there is nothing to compare against."
  exit 0
fi
git show "${BASE_REF}:contracts/openapi/dist/shri-health.bundled.yaml" > "$BASE_FILE" \
  || fail "could not read the bundle from ${BASE_REF}"

echo "Comparing ${BASE_REF} → working tree"
# oasdiff exits 0 when nothing reaches ERR level, 1 when it finds breaking changes, and 100 or more on its own errors.
set +e
"$BIN" breaking "$BASE_FILE" openapi/dist/shri-health.bundled.yaml --fail-on ERR --severity-levels openapi/oasdiff-severity.txt
rc=$?
set -e
case "$rc" in
  0) echo "No breaking changes." ;;
  1) echo "Breaking changes found (listed above)." >&2; exit 3 ;;
  *) fail "oasdiff exited with code ${rc}" ;;
esac
