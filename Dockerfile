# The scanner needs a real browser, so the image is Playwright's own, which
# ships a Chromium matched to the client library. Installing a browser into a
# slim base at build time is the usual way this breaks: the versions drift and
# the failure appears at runtime as "executable doesn't exist", on the judge's
# first click rather than in CI.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

WORKDIR /app
ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NODE_OPTIONS=--max-old-space-size=384

# Manifests first, so a dependency layer is reused when only source changes.
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/
RUN npm ci --omit=dev --ignore-scripts

COPY packages/core ./packages/core
COPY apps/api ./apps/api

# The API reads the recordings from packages/core/data at startup.
EXPOSE 8791
ENV PORT=8791 HOST=0.0.0.0
USER pwuser
CMD ["node", "apps/api/src/server.js"]
