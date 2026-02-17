FROM oven/bun:1.3.9-alpine AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

# Production dependencies only (excludes svelte, vite, tailwindcss, etc.)
FROM oven/bun:1.3.9-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.3.9-alpine
WORKDIR /app
RUN apk add --no-cache su-exec && \
    addgroup -S app && adduser -S app -G app && \
    mkdir -p /data /archives
COPY --from=build --chown=app:app /app/build ./build
COPY --from=deps --chown=app:app /app/package.json ./
COPY --from=deps --chown=app:app /app/node_modules ./node_modules
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENV NODE_ENV=production
ENV DATA_DIR=/data
ENV ARCHIVE_DIR=/archives
ENV PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://0.0.0.0:3000/api/health || exit 1
ENTRYPOINT ["/entrypoint.sh"]
CMD ["bun", "build/index.js"]
