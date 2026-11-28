# Imagen única de ZenithAgent: gateway, worker, API (que también sirve el panel) y migraciones.
# Cada servicio de docker-compose.prod.yml la usa con su propio comando.
#
# El código corre en TypeScript con tsx (sin paso de compilación); el panel sí se compila con Vite.

# ---------------------------------------------------------------- dependencias y panel
FROM node:22-bookworm-slim AS build
WORKDIR /app

# Primero los package.json: si no cambian, Docker reutiliza la capa de npm ci.
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/gateway/package.json apps/gateway/
COPY apps/panel/package.json apps/panel/
COPY apps/simulator/package.json apps/simulator/
COPY apps/worker/package.json apps/worker/
COPY packages/brain/package.json packages/brain/
COPY packages/catalog/package.json packages/catalog/
COPY packages/channel-meta/package.json packages/channel-meta/
COPY packages/channel-whatsapp/package.json packages/channel-whatsapp/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build:panel \
 && npm prune --omit=dev --no-audit --no-fund \
 && rm -rf apps/simulator apps/*/test packages/*/test

# ---------------------------------------------------------------- ejecución
FROM node:22-bookworm-slim
# ffmpeg: notas de voz y cuadros de video (worker). tini: señales y procesos hijos bien cerrados.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app /app
USER node
ENTRYPOINT ["/usr/bin/tini", "--"]
# Por defecto, la API; docker-compose.prod.yml define el comando de cada servicio.
CMD ["node", "--import", "tsx", "apps/api/src/index.ts"]
