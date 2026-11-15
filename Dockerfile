# PianoSmith production image for Google Cloud Run (or Fly, a VPS, etc.).
#
# Builds the Vite app and runs the Node server (UI + /api/link + /api/search).
# Shared music links resolve through Internet Archive (no yt-dlp, no cookies).
#
# The platform should inject PORT; the app listens on 0.0.0.0.

FROM node:24-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
COPY scripts/copy-model.mjs ./scripts/copy-model.mjs
RUN npm ci

COPY . .
RUN npm run build \
 && npm prune --omit=dev

ENV NODE_ENV=production
EXPOSE 8080

CMD ["npm", "start"]
