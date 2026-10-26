# syntax=docker/dockerfile:1
FROM node:24-alpine

WORKDIR /app

# apenas a dependência de runtime (ws)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY . .

ENV PORT=8787 \
    HOST=0.0.0.0 \
    DB_PATH=/data/apuracao.db \
    POLL_INTERVAL_MS=20000 \
    MARKET_INTERVAL_MS=60000

VOLUME ["/data"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server/index.js"]
