# One container: API + SPA + outbox dispatcher + pg-boss workers.
FROM node:24-slim AS build
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter @aod/web build

FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
RUN corepack enable
COPY --chown=node:node . .
RUN pnpm install --prod --frozen-lockfile && chown -R node:node /app
COPY --from=build --chown=node:node /app/apps/web/dist ./apps/web/dist
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s CMD node -e "fetch('http://localhost:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# TypeScript runs directly on Node 24 (type stripping); no build step for the server.
CMD ["node", "apps/server/src/main.ts"]
