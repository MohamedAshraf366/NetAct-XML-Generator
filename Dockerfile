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

# Jackcess helper used by /fill (src/lib/fill.ts spawns it once per fill job).
# Compile with a JDK, ship only the small class files plus a JRE in the runtime image.
FROM eclipse-temurin:17-jdk AS filljava
WORKDIR /fill
COPY tools/mdb-fill/MdbFill.java tools/mdb-fill/jackcess-5.0.4.jar ./
RUN mkdir -p classes && javac -cp jackcess-5.0.4.jar -d classes MdbFill.java

FROM eclipse-temurin:17-jre AS jre

FROM base AS run
ENV NODE_ENV=production
# Public deployments must never let a visitor read arbitrary server files.
ENV ALLOW_LOCAL_FILES=false
COPY --from=unrar /unrar /usr/local/bin/unrar
COPY --chown=node:node --from=build /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/.next ./.next
COPY --chown=node:node --from=build /app/public ./public
COPY --chown=node:node --from=build /app/package.json ./package.json
COPY --chown=node:node --from=build /app/next.config.mjs ./next.config.mjs
# /fill needs a Java 17 runtime, the compiled helper and its Jackcess jar.
COPY --from=jre /opt/java/openjdk /opt/java/openjdk
COPY --chown=node:node --from=filljava /fill/classes ./tools/mdb-fill/classes
COPY --chown=node:node tools/mdb-fill/jackcess-5.0.4.jar ./tools/mdb-fill/jackcess-5.0.4.jar
ENV JAVA_HOME=/opt/java/openjdk
ENV PATH="/opt/java/openjdk/bin:$PATH"
# The build stages run as root; the server itself does not.
USER node
EXPOSE 3000
# Bind to all interfaces so the platform's proxy can reach the server.
ENV HOSTNAME=0.0.0.0
CMD ["sh", "-c", "exec node --expose-gc node_modules/next/dist/bin/next start -H 0.0.0.0 -p ${PORT:-3000}"]
