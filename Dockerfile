# Deploy target for hosts without a request-body size limit (Railway, Render, Fly.io, a VPS, ...).
# Using `next start` with the full dependency tree keeps the WASM/external packages
# (node-unrar-js, exceljs, mdb-reader) intact - no relying on outputFileTracing.
FROM node:22-slim AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# Native unrar (RARLAB 7.x) - multi-GB RARs are then streamed straight into the scanner
# instead of being unpacked in memory by the WASM fallback (which is size-capped).
FROM base AS unrar
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && curl -fL -o /tmp/rar.tgz https://www.rarlab.com/rar/rarlinux-x64-723.tar.gz \
 && tar -xzf /tmp/rar.tgz -C /tmp \
 && install -m 755 /tmp/rar/unrar /unrar

FROM base AS build
COPY package.json package-lock.json ./
RUN npm ci
# copy only the build inputs - edits to README/scripts/samples then don't invalidate the build layers
COPY tsconfig.json next.config.mjs postcss.config.mjs tailwind.config.ts ./
COPY src ./src
RUN mkdir -p public && npm run build \
 && rm -rf .next/cache \
 && npm prune --omit=dev

FROM base AS run
ENV NODE_ENV=production
COPY --from=unrar /unrar /usr/local/bin/unrar
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/next.config.mjs ./next.config.mjs
EXPOSE 3000
# Bind to all interfaces so the platform's proxy can reach the server.
ENV HOSTNAME=0.0.0.0
CMD ["sh", "-c", "exec node --expose-gc node_modules/next/dist/bin/next start -H 0.0.0.0 -p ${PORT:-3000}"]
