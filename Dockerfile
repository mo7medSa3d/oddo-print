# The immutable Docker Hub image is the production default. CI may use the
# officially published ECR Public mirror with the same digest when Hub is throttled.
ARG NODE_BASE_IMAGE=node:24.22.1-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53

FROM ${NODE_BASE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npx --yes npm@12.2.1 ci

FROM ${NODE_BASE_IMAGE} AS build
ARG YASEIR_DEPLOYMENT_ID=""
ENV YASEIR_DEPLOYMENT_ID=${YASEIR_DEPLOYMENT_ID}
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Next permits an app without static public assets; keep the runtime copy valid
# for both an empty asset directory and deployments that add public files.
RUN mkdir -p public && npm run build

# Reuse the lockfile-verified npm install from the deps stage instead of
# downloading/installing a second copy for the production runtime layer.
FROM deps AS runtime-deps
RUN npx --yes npm@12.2.1 prune --omit=dev && npm cache clean --force

FROM ${NODE_BASE_IMAGE} AS runtime
ARG YASEIR_DEPLOYMENT_ID=""
ENV YASEIR_DEPLOYMENT_ID=${YASEIR_DEPLOYMENT_ID}
WORKDIR /app
ENV NODE_ENV=production
ENV TZ=UTC
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

# Keep only production dependencies in the final image. `tsx` is an explicit
# runtime dependency because the custom HTTP/WebSocket server and migration
# command execute TypeScript directly.
COPY --from=runtime-deps /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/server.ts ./server.ts
COPY --from=build /app/src ./src
# Desktop-only Tauri/Vite sources and browser preview never execute inside Gateway.
# Keep shared src/lib and server code, but omit the separate Desktop application.
RUN rm -rf /app/src/desktop
COPY --from=build /app/contracts ./contracts
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/drizzle.config.ts ./drizzle.config.ts
COPY --from=build /app/next.config.ts ./next.config.ts
COPY --from=build /app/tsconfig.json ./tsconfig.json
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/package-lock.json ./package-lock.json

# Patch the inherited Alpine zlib advisory with an exact, signed package
# fetched at build time; never resolve a mutable repository version.
ADD --checksum=sha256:d3e30d012a3445222b0b4a28f1d4d97ce67387f8b48561921111696da174f0de https://dl-cdn.alpinelinux.org/alpine/v3.24/main/aarch64/zlib-1.4-r0.apk /os-security/aarch64/zlib-1.4-r0.apk
ADD --checksum=sha256:7b05bc778b8b25cd880835b40114182bd4d1581717504d0129c810c0a14291cb https://dl-cdn.alpinelinux.org/alpine/v3.24/main/x86_64/zlib-1.4-r0.apk /os-security/x86_64/zlib-1.4-r0.apk
RUN set -eu; \
    test "$(cat /etc/alpine-release)" = '3.24.3'; \
    apk_arch="$(apk --print-arch)"; \
    case "$apk_arch" in x86_64|aarch64) ;; *) exit 1 ;; esac; \
    apk add --no-network --no-cache "/os-security/${apk_arch}/zlib-1.4-r0.apk"; \
    apk info --exists 'zlib=1.4-r0'; \
    rm -rf /os-security

# The official Node image bundles npm (and bundled npm dependencies with
# outstanding upstream advisories). No package installation is needed after
# image assembly: run the TypeScript entry points via Node's tsx import hook
# and remove the entire global npm CLI from the FINAL image.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

# The separate administrator job keeps reversible privilege metadata in its
# own volume. Runtime Gateway never mounts that volume or administrator keys.
RUN mkdir -p /var/lib/yaseir-role-state \
    && chown node:node /var/lib/yaseir-role-state \
    && chmod 700 /var/lib/yaseir-role-state

USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=5 \
    CMD node -e "fetch('http://127.0.0.1:3000/api/health',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

EXPOSE 3000

# Migrations are a release/deployment concern and must run in a dedicated,
# ordered migration job before application rollout. Runtime replicas must not
# require schema-write privileges or race each other on startup.
CMD ["node", "--import", "tsx", "server.ts"]
