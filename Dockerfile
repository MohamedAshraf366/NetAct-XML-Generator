# Deploy target for hosts without a request-body size limit (Railway, Render, Fly.io, a VPS, ...).
# Using `next start` with the full dependency tree keeps the WASM/external packages
# (node-unrar-js, exceljs, mdb-reader) intact - no relying on outputFileTracing.
FROM node:22-slim AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS build
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN mkdir -p public && npm run build

FROM base AS run
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/next.config.mjs ./next.config.mjs
EXPOSE 3000
# Bind to all interfaces so the platform's proxy can reach the server.
ENV HOSTNAME=0.0.0.0
CMD ["npm", "start"]
