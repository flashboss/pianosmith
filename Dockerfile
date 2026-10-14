# PianoSmith production image for remote hosts (Railway, Fly, a VPS, etc.).
#
# Local `npm run dev` expects yt-dlp and ffmpeg on the machine. On a cloud host
# those tools are usually missing, so this Dockerfile installs them, builds the
# Vite app, and runs the Node server that serves the UI and `/api/link`.
#
# Use this file as the build source on the remote platform (e.g. Railway
# Dockerfile builder). Do not use GitHub Pages for this role — Pages is static
# only and cannot run yt-dlp.
#
# Optional: if YouTube blocks the host IP, set YTDLP_COOKIES (Netscape cookies.txt
# contents) or YTDLP_COOKIES_FILE (path inside the container).
#
# The platform should inject PORT; the app listens on 0.0.0.0.

FROM node:24-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    python3-pip \
    ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN pip3 install --no-cache-dir --break-system-packages -U yt-dlp

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
