FROM oven/bun:1.4.4-alpine@sha256:4cf82f5686b196504fe119db3fcd9185b191f82ece82c40680e597228ec6070a AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build
RUN bun build src/bin/profile-analyzer.ts --target=bun --outfile=build/profile-analyzer.js

# Production dependencies only (excludes svelte, vite, tailwindcss, etc.)
FROM oven/bun:1.4.4-alpine@sha256:4cf82f5686b196504fe119db3fcd9185b191f82ece82c40680e597228ec6070a AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.4.4-alpine@sha256:4cf82f5686b196504fe119db3fcd9185b191f82ece82c40680e597228ec6070a AS dashboard
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
ENV ORIGIN=http://localhost:3000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
	CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/api/ready" || exit 1
ENTRYPOINT ["/entrypoint.sh"]
CMD ["bun", "build/index.js"]

FROM oven/bun:1.4.4-alpine@sha256:4cf82f5686b196504fe119db3fcd9185b191f82ece82c40680e597228ec6070a AS profile-analyzer
WORKDIR /app
RUN apk upgrade --no-cache && \
	apk add --no-cache \
		git=2.54.1-r0 \
		git-lfs=3.7.1-r2 \
		git-sizer=1.5.0-r41 \
		sqlite=3.53.4-r0 \
		su-exec=0.3-r0 && \
	addgroup -S app && adduser -S app -G app && \
	mkdir -p /data /analysis
COPY --from=build --chown=app:app /app/build/profile-analyzer.js ./build/profile-analyzer.js
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENV NODE_ENV=production
ENV DATA_DIR=/data
ENV ANALYSIS_DIR=/analysis
ENV ANALYSIS_HEALTH_PORT=3001
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
	CMD ["bun", "-e", "const response = await fetch('http://127.0.0.1:' + process.env.ANALYSIS_HEALTH_PORT + '/health'); console.log(await response.text()); process.exit(response.ok ? 0 : 1)"]
ENTRYPOINT ["/entrypoint.sh"]
CMD ["bun", "build/profile-analyzer.js"]

# Exercise the production image workflow.
