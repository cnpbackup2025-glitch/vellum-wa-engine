FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

EXPOSE 3000

ENV PORT=3000
ENV CLOUDFLARE_BASE_URL=https://vellum0antigravity.pages.dev
ENV AUTO_REPLY_ENABLED=true

CMD ["node", "index.js"]
