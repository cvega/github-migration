.PHONY: dev build preview clean docker docker-up docker-down install check seed lint lint-fix format

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

lint:
	bunx --bun biome check .

lint-fix:
	bunx --bun biome check --write .

format:
	bunx --bun biome format --write .

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
