# The immutable Docker Hub image is the production default. CI may use the
# officially published ECR Public mirror with the same digest when Hub is throttled.
ARG NODE_BASE_IMAGE=node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1

FROM ${NODE_BASE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

FROM ${NODE_BASE_IMAGE} AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Next permits an app without static public assets; keep the runtime copy valid
# for both an empty asset directory and deployments that add public files.
RUN mkdir -p public && npm run build

FROM ${NODE_BASE_IMAGE} AS runtime-deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

FROM ${NODE_BASE_IMAGE} AS runtime
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
COPY --from=build /app/contracts ./contracts
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/drizzle.config.ts ./drizzle.config.ts
COPY --from=build /app/next.config.ts ./next.config.ts
COPY --from=build /app/tsconfig.json ./tsconfig.json
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/package-lock.json ./package-lock.json

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=5 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/api/live || exit 1

# Migrations are a release/deployment concern and must run in a dedicated,
# ordered migration job before application rollout. Runtime replicas must not
# require schema-write privileges or race each other on startup.
CMD ["npm", "start"]
