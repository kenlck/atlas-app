FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN corepack enable && corepack prepare pnpm@10.33.4 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build
RUN pnpm exec esbuild scripts/migrate.ts --bundle --platform=node --format=esm --outfile=migrate.mjs --packages=bundle

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
COPY --from=build /app/.output ./.output
COPY --from=build /app/migrate.mjs ./migrate.mjs
COPY --from=build /app/drizzle ./drizzle
EXPOSE 3000
CMD ["node", ".output/server/index.mjs"]
