FROM node:22-alpine
# yt-dlp for music indexing
RUN apk add --no-cache python3 py3-pip ffmpeg && pip3 install --break-system-packages --quiet yt-dlp
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
# Recordings persist via a volume mounted at /app/recordings
RUN mkdir -p recordings
EXPOSE 3000
CMD ["node", "server.js"]
