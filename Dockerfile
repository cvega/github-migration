FROM oven/bun:1.4.0-alpine@sha256:07235578f79ef8c6f97d94aee7938e76f5cdba5f21ae5dbfdd3d3d38058437eb AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

# Production dependencies only (excludes svelte, vite, tailwindcss, etc.)
FROM oven/bun:1.4.0-alpine@sha256:07235578f79ef8c6f97d94aee7938e76f5cdba5f21ae5dbfdd3d3d38058437eb AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.4.0-alpine@sha256:07235578f79ef8c6f97d94aee7938e76f5cdba5f21ae5dbfdd3d3d38058437eb
WORKDIR /app
# Patch OS packages before installing runtime tools so the shipped image carries
# Alpine's latest security fixes and clears the release vulnerability gate.
RUN apk upgrade --no-cache && \
	apk add --no-cache docker-cli sqlite su-exec && \
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
	CMD wget -qO- http://127.0.0.1:3000/api/ready || exit 1
ENTRYPOINT ["/entrypoint.sh"]
CMD ["bun", "build/index.js"]