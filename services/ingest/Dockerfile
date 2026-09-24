# Participant-facing ingest service. Built from the repo root:
#   docker build -f services/ingest/Dockerfile .
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY apps/web/package.json apps/web/
COPY services/ingest/package.json services/ingest/
COPY runtime/package.json runtime/
RUN npm ci --omit=dev --no-audit --no-fund
COPY packages/core/src packages/core/src
COPY services/ingest/src services/ingest/src
USER node
EXPOSE 8080
CMD ["node", "services/ingest/src/server.js"]
