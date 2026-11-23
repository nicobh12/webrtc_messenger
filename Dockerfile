FROM node:18-alpine

WORKDIR /app

# Se copian primero los manifiestos para aprovechar la caché de capas de Docker.
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY server.js ./

# Puerto interno del servidor de señalización (documental; se publica con Compose).
EXPOSE 3000

CMD ["node", "server.js"]
