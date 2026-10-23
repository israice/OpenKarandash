FROM node:22-bookworm

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    libdbus-1-3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpango-1.0-0 \
    libcairo2 \
    git \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g opencode-ai

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 3001

ENV NO_RELOAD=1 \
    HOST_DEPS=0 \
    HERMES_STACK=0

CMD ["node", "server.js"]
