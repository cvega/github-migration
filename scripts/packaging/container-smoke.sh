#!/bin/sh
set -eu

image="${1:?usage: container-smoke.sh IMAGE [ANALYZER_IMAGE]}"
analyzer_image="${2:-}"
container=""

cleanup() {
	if [ -n "$container" ]; then
		docker rm --force "$container" >/dev/null 2>&1 || true
	fi
}
trap cleanup EXIT INT TERM

container="$(docker run --detach --rm \
	--network none \
	--env GH_MIGRATE_ALLOW_UNAUTHENTICATED=false \
	--env GH_MIGRATE_USER=smoke-admin \
	--env GH_MIGRATE_PASS=smoke-test-password-not-for-deployment \
	"$image")"

attempt=0
ready=false
while [ "$attempt" -lt 30 ]; do
	state="$(docker inspect --format '{{.State.Status}}' "$container")"
	if docker exec "$container" wget -qO- http://127.0.0.1:3000/api/ready >/dev/null 2>&1; then
		ready=true
		break
	fi
	if [ "$state" = exited ] || [ "$state" = dead ]; then
		docker logs "$container"
		echo "Container failed smoke test (state=$state)" >&2
		exit 1
	fi
	attempt=$((attempt + 1))
	sleep 1
done

if [ "$ready" != true ]; then
	docker logs "$container"
	echo "Container did not become healthy within 30 seconds" >&2
	exit 1
fi

docker exec -i "$container" bun - <<'HTTP_SMOKE'
import assert from "node:assert/strict";

const origin = process.env.ORIGIN;
assert.ok(origin, "The dashboard image must configure a default public origin");
const request = (path, options = {}) =>
	fetch(new URL(path, origin), { redirect: "manual", ...options });

const loginPage = await request("/login");
assert.equal(loginPage.status, 200);
const html = await loginPage.text();
const immutablePath = html.match(/(?:\.\/|\/)(_app\/immutable\/[^"'\s]+)/)?.[1];
assert.ok(immutablePath, "The login page must reference immutable assets");
const immutable = await request(`/${immutablePath}`);
assert.equal(immutable.status, 200);
assert.equal(immutable.headers.get("cache-control"), "public,max-age=31536000,immutable");
const favicon = await request("/favicon.png");
assert.equal(favicon.status, 200);
assert.equal(favicon.headers.get("cache-control"), "public,max-age=604800");

assert.equal((await request("/api/migrate")).status, 401);
const login = await request("/login", {
	method: "POST",
	headers: { origin, accept: "text/html" },
	body: new URLSearchParams({
		username: process.env.GH_MIGRATE_USER,
		password: process.env.GH_MIGRATE_PASS,
	}),
});
assert.equal(login.status, 302, "Same-origin production login must succeed");
const cookies = login.headers.getSetCookie();
assert.ok(cookies.some((cookie) => /httponly/i.test(cookie)));
const cookie = cookies.map((value) => value.split(";")[0]).join("; ");
assert.equal((await request("/api/migrate", { headers: { cookie } })).status, 200);
assert.equal((await request("/missing-static-asset.png", { headers: { cookie } })).status, 404);
const missingMigration = await request("/migrate/smoke-missing-migration", {
	headers: { cookie, accept: "text/html" },
});
assert.equal(missingMigration.status, 404);
assert.match(await missingMigration.text(), /Migration not found/);

const post = (requestOrigin) => request("/api/migrate", {
	method: "POST",
	headers: { cookie, origin: requestOrigin, "content-type": "application/json" },
	body: "{}",
});
assert.equal((await post(origin)).status, 400, "Same-origin JSON must reach schema validation");
assert.equal((await post("https://untrusted.example")).status, 403);
assert.equal((await request("/login", {
	method: "POST",
	headers: { origin: "https://untrusted.example", accept: "text/html" },
	body: new URLSearchParams({ username: "smoke-admin", password: "invalid" }),
})).status, 403, "Cross-origin forms must remain forbidden");
console.log("Production login and JSON API origin checks passed");
HTTP_SMOKE

docker exec -i "$container" sh <<'SQLITE_SMOKE'
	set -eu
	sqlite3 /data/gh-migrate.db ".backup /tmp/backup.db"
	test "$(sqlite3 /tmp/backup.db "PRAGMA integrity_check;")" = ok
	test -z "$(sqlite3 /tmp/backup.db "PRAGMA foreign_key_check;")"
	test "$(sqlite3 /tmp/backup.db "SELECT COUNT(*) FROM app_users;")" = 1
SQLITE_SMOKE

# Use the independent online backup, never the running service's /data.
docker cp scripts/packaging/volume-snapshot.sh "$container:/tmp/volume-snapshot.sh"
docker exec -i "$container" sh <<'RESTORE_SMOKE'
	set -eu
	work=$(mktemp -d)
	cd "$work"
	mkdir data archives fresh-data fresh-archives
	cp /tmp/backup.db data/gh-migrate.db
	printf 'fixture\n' > archives/sample
	sh /tmp/volume-snapshot.sh backup snapshot data archives
	sh /tmp/volume-snapshot.sh check-current snapshot data
	sh /tmp/volume-snapshot.sh restore snapshot fresh-data fresh-archives
	test "$(sqlite3 fresh-data/gh-migrate.db 'SELECT count(*) FROM app_users')" = 1
	cmp archives/sample fresh-archives/sample
RESTORE_SMOKE

# Exercise the image health check itself on a nondefault listening port.
docker rm --force "$container" >/dev/null
container="$(docker run --detach --rm --network none --env PORT=3100 \
	--env GH_MIGRATE_ALLOW_UNAUTHENTICATED=false \
	--env GH_MIGRATE_USER=smoke-admin \
	--env GH_MIGRATE_PASS=smoke-test-password-not-for-deployment \
	"$image")"
attempt=0
while [ "$attempt" -lt 45 ]; do
	health="$(docker inspect --format '{{.State.Health.Status}}' "$container")"
	if [ "$health" = healthy ]; then
		break
	fi
	if [ "$health" = unhealthy ]; then
		docker inspect --format '{{json .State.Health}}' "$container" >&2
		exit 1
	fi
	attempt=$((attempt + 1))
	sleep 1
done
if [ "$health" != healthy ]; then
	docker logs "$container"
	echo "Container health check did not pass on nondefault PORT" >&2
	exit 1
fi

if [ -n "$analyzer_image" ]; then
	docker run --rm --network none "$analyzer_image" sh -c '
		set -eu
		test "$(id -un)" = app
		git --version
		git lfs version
		git-sizer --version
		sqlite3 --version
		ANALYSIS_RUN_ONCE=true bun build/profile-analyzer.js
	'
	echo "Analyzer toolchain and database startup smoke tests passed"
fi

echo "Container health and SQLite backup smoke tests passed"