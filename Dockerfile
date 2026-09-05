FROM node:20-slim AS deps

RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

FROM node:20-slim

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080
ENV DB_PATH=/app/data/blossom.db

RUN apt-get update && apt-get install -y --no-install-recommends gosu \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /app/data \
  && chown node:node /app/data

COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY . .
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 8080

ENTRYPOINT ["docker-entrypoint.sh"]
