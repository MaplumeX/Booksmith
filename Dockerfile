FROM node:22-bookworm-slim

# Pinned so the image installs with the same pnpm that wrote pnpm-lock.yaml.
RUN npm i -g pnpm@12.21.0
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
CMD ["sh", "-c", "pnpm --filter @booksmith/server db:migrate && exec pnpm --filter @booksmith/server start"]
