FROM node:20-slim AS deps

RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

FROM node:20-slim

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY . .

# Run as the unprivileged "node" user baked into the base image
USER node

EXPOSE 8080

CMD ["node", "server.js"]
