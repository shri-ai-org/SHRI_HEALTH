# The test server's edge with the screens (infra/deploy): the frontend built from the deployed
# commit, served by the same pinned Nginx as before. Build context: frontend/ (compose).
#
# The build runs as CI's does (.github/workflows/frontend.yml): Node 24 LTS, `npm ci` from the
# lockfile with no install scripts (frontend/.npmrc), then `npm run build`. Only tracked sources
# are copied, never a local node_modules.

FROM node:24.22.0-slim@sha256:91acba91b842bec0bf7ea6f5e09c644c7ccad72c4996ed9616d861d1c7cd60d4 AS build
WORKDIR /web
COPY package.json package-lock.json .npmrc ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY index.html vite.config.ts eslint.config.js playwright.config.ts tsconfig.json \
     tsconfig.app.json tsconfig.node.json ./
COPY src ./src
COPY public ./public
COPY dev ./dev
COPY e2e ./e2e
RUN npm run build

FROM nginx:1.27-alpine@sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10
COPY --from=build /web/dist /srv/shri-web
