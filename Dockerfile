# syntax=docker/dockerfile:1
# Imagen de producción del API (NestJS) para Cloud Run. Contexto de build: este directorio (backend/).
#   docker build -t kikovo-api .
# Sin secretos: toda la configuración llega por variables de entorno en tiempo de ejecución
# (MONGODB_URI, JWT_*, FRONTEND_URL…). MongoDB es externo; no corre en este contenedor.

ARG NODE_IMAGE=node:24-bookworm-slim

# ─── 1. Build: dependencias completas + compilación (nest build) ─────────────
FROM ${NODE_IMAGE} AS build
WORKDIR /app
# mongodb-memory-server (solo tests) descargaría un binario de MongoDB en postinstall: no hace falta.
ENV MONGOMS_DISABLE_POSTINSTALL=1
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN npm run build

# ─── 2. Dependencias de producción (sin devDependencies) ─────────────────────
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ─── 3. Runtime: solo lo necesario para ejecutar ─────────────────────────────
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
# package.json es necesario en runtime: "type": "module" (dist/ es ESM).
COPY --chown=node:node package.json ./
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
USER node
# Documentativo: Cloud Run inyecta PORT (8080 por defecto); el API lee process.env.PORT (3000 si falta).
EXPOSE 8080
CMD ["node", "dist/main.js"]
