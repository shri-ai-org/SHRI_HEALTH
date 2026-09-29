#!/usr/bin/env bash
# Visits every routed screen in headless Chrome and asserts it rendered.
#
# A rendered screen carries `data-screen-id` on its root, so finding it in the
# DOM proves the component mounted rather than falling through to the router's
# fallback. It used to grep the footer spec line, which the calm screens do not
# print — an assertion resting on visible copy breaks when the copy changes.
#
# `?e2e=1` is a DEV-only hook in `src/main.tsx`: --dump-dom cannot type into the
# sign-in form, so without it every route redirects to /login. It is compiled
# out of production builds.
#
# The one expected miss is S-18-01: ARC-12 command walls strip the shell
# entirely ("Z5 only, no Z1, no Z2") and render their own frame.
#
# Usage:  npm run dev   # in another terminal
#         ./scripts/walk-routes.sh
set -u
BASE="${1:-http://localhost:5180}"
CHROME="${CHROME:-google-chrome}"

# Sensible params so every screen lands on real sample data.
route_for() {
  case "$1" in
    /patient/*)          echo "${1/:id/ICH-0044051}" ;;
    /stroke/case/*)      echo "${1/:id/0141}" ;;
    /radiology/study/*)  echo "${1/:id/ST-9914}" ;;
    /results/:id)        echo "/results/R-88410" ;;
    /tele/session/*)     echo "${1/:id/E-118430}" ;;
    /ip/encounter/*)     echo "${1/:id/E-118366}" ;;
    *)                   echo "${1/:id/E-118402}" ;;
  esac
}

mapfile -t rows < <(
  node --input-type=module -e "
    import { readFileSync } from 'fs';
    const src = readFileSync('src/atlas/registry.ts', 'utf8');
    for (const m of src.matchAll(/id: '(S-\d\d-\d\d)',[\s\S]*?route: (null|'([^']+)')/g)) {
      if (m[3]) console.log(m[1] + ' ' + m[3]);
    }
  "
)

pass=0; fail=0
for row in "${rows[@]}"; do
  id="${row%% *}"; pattern="${row##* }"
  route="$(route_for "$pattern")"
  # Routes with their own query string need & rather than ?.
  case "$route" in *\?*) sep='&' ;; *) sep='?' ;; esac
  dom="$(timeout 40 "$CHROME" --headless --disable-gpu --no-sandbox \
          --virtual-time-budget=4500 --dump-dom "${BASE}${route}${sep}e2e=1" 2>/dev/null)"
  if grep -q "data-screen-id=\"$id\"" <<< "$dom" && ! grep -qE 'has no component|No screen at this address' <<< "$dom"; then
    pass=$((pass + 1))
  else
    printf 'FAIL  %-9s %s\n' "$id" "$route"
    fail=$((fail + 1))
  fi
done

printf -- '---- %d passed, %d failed ----\n' "$pass" "$fail"
[ "$fail" -le 1 ] || exit 1
