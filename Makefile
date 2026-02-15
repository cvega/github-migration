.PHONY: dev build preview clean docker docker-up docker-down install check seed

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
