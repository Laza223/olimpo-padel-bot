# Bot de ventas de Olimpo Padel. Node 24 corre el TypeScript directo: no hay paso de compilación.
FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app

# ffmpeg (con ffprobe): pasa los audios del cliente a mp3 antes de transcribirlos.
# chromium: arma el PDF del presupuesto del CRM (lo que hacía Electron en el creador). fonts-inter: la letra del PDF aunque Google Fonts no responda.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg chromium fonts-inter fonts-liberation \
    && rm -rf /var/lib/apt/lists/*
ENV CHROMIUM_PATH=/usr/bin/chromium

# Solo las dependencias de producción (openai, yaml), con las versiones exactas del lockfile.
RUN npm install -g pnpm@12.4.2 --no-fund --no-audit
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile

# Lo único que el bot necesita para andar: el código, la política y las fotos.
COPY src ./src
COPY policy ./policy
COPY assets ./assets

# Sin root. La base (data/bot.sqlite) vive en un volumen: ver docker-compose.yml.
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "src/main.ts"]
