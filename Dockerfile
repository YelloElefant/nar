FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm i --omit=dev

COPY . .

ENV NODE_ENV=production

CMD ["node", "server.js"]