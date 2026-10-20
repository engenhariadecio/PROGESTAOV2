# Node (sistema) + Python (treino da IA da câmera). O Railway usa este arquivo automaticamente.
# Sem o Python o sistema roda igual — só o botão "Treinar IA" avisa que o treino não está disponível.
FROM node:20-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip libgl1 libglib2.0-0 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

COPY python/requirements.txt python/requirements.txt
RUN pip3 install --no-cache-dir --break-system-packages -r python/requirements.txt

COPY . .
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]
