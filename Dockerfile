FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
# Recordings persist via a volume mounted at /app/recordings
RUN mkdir -p recordings
EXPOSE 3000
CMD ["node", "server.js"]
