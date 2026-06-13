.PHONY: dev build preview clean docker docker-up docker-down install check typecheck \
	test coverage lint lint-fix format format-check audit dup deadcode cycles mutation \
	verify seed

install:
	bun install

dev:
	bun run dev

build:
	bun run build

preview: build
	bun run preview

check:
	bun run check

typecheck:
	bun run typecheck

test:
	bun test

coverage:
	bun run coverage:check

lint:
	bunx --bun biome check .

lint-fix:
	bunx --bun biome check --write .

format:
	bunx --bun biome format --write .

format-check:
	bun run format:check

audit:
	bun run audit

dup:
	bun run dup

deadcode:
	bun run deadcode

cycles:
	bun run cycles

# Mutation testing is an opt-in deeper pass (not part of `verify`).
mutation:
	bun run mutation

# Full gate suite: typecheck + check + lint + format + coverage + dup + deadcode + cycles + build + audit.
verify:
	bun run verify

clean:
	rm -rf build/ node_modules/ .svelte-kit/ data/

docker:
	docker build -t gh-migrate .

docker-up:
	docker compose up -d

docker-down:
	docker compose down

seed:
	bun run seed
