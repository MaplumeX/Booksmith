FROM node:22-bookworm-slim

RUN corepack enable
WORKDIR /app

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY apps/web/package.json apps/web/
COPY apps/server/package.json apps/server/
COPY packages/core/package.json packages/core/
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm --filter @booksmith/web build

ENV NODE_ENV=production
ENV WEB_DIST=/app/apps/web/dist
EXPOSE 8787
CMD ["pnpm", "--filter", "@booksmith/server", "start"]
