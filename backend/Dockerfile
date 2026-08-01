FROM node:20-alpine
WORKDIR /app

COPY backend/package.json ./
RUN npm install --omit=dev

COPY backend/server.js ./
COPY public /public

EXPOSE 3000
CMD ["node", "server.js"]
