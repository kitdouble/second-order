# Trial data ingest service for Cloud Run.
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
USER node
EXPOSE 8080
CMD ["node", "src/server.js"]
