# The test server's edge with the screens (infra/deploy): the frontend built from the deployed
# commit, served by the same pinned Nginx as before. Build context: frontend/ (compose).
#
# The build runs as CI's does (.github/workflows/frontend.yml): Node 24 LTS, `npm ci` from the
# lockfile with no install scripts (frontend/.npmrc), then `npm run build`. Only tracked sources
# are copied, never a local node_modules.

FROM node:24.22.0-slim@sha256:91acba91b842bec0bf7ea6f5e09c644c7ccad72c4996ed9616d861d1c7cd60d4 AS build
# The two screen apps (#243): the front office at the base path's root, the doctors' portal under
# clinician/. SHRI_BASE_PATH is "" for a host of its own (dep.shri-ai.org) or "/dep" under a
# shared host's path (deploy.sh, README "Two ways to serve it"); each app reads its own base
# setting (front-office: BASE_PATH, doctors-portal: PORTAL_BASE), so no app file changes.
ARG SHRI_BASE_PATH=""
WORKDIR /web
COPY package.json package-lock.json .npmrc tsconfig.json tsconfig.app.json tsconfig.node.json ./
# The apps import the shared session code (src/api) and the dev proxy's types (dev/).
COPY shared ./shared
COPY src ./src
COPY dev ./dev
COPY front-office ./front-office
COPY doctors-portal ./doctors-portal
RUN rm -rf front-office/node_modules doctors-portal/node_modules \
 && npm ci --ignore-scripts --no-audit --no-fund
RUN BASE_PATH="${SHRI_BASE_PATH}/" npm run build -w front-office \
 && PORTAL_BASE="${SHRI_BASE_PATH}/clinician/" npm run build -w doctors-portal

FROM nginx:1.27-alpine@sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10
COPY --from=build /web/front-office/dist /srv/shri-web/front-office
COPY --from=build /web/doctors-portal/dist /srv/shri-web/clinician
