FROM node:22-alpine
# yt-dlp for music indexing
RUN apk add --no-cache python3 py3-pip ffmpeg deno && pip3 install --break-system-packages --quiet yt-dlp
# warm deno cache for the yt-dlp EJS challenge solver
RUN yt-dlp --remote-components ejs:github --simulate "https://www.youtube.com/watch?v=jNQXAC9IVRw" > /dev/null 2>&1 || true
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
# Recordings persist via a volume mounted at /app/recordings
RUN mkdir -p recordings
EXPOSE 3000
CMD ["node", "server.js"]
