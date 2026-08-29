#!/bin/sh
set -eu

image="${1:?usage: container-smoke.sh IMAGE}"
container=""

cleanup() {
	if [ -n "$container" ]; then
		docker rm --force "$container" >/dev/null 2>&1 || true
	fi
}
trap cleanup EXIT INT TERM

container="$(docker run --detach --rm \
	--env GH_MIGRATE_ALLOW_UNAUTHENTICATED=true \
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

docker exec "$container" sh -c '
	set -eu
	sqlite3 /tmp/source.db "CREATE TABLE records(value TEXT); INSERT INTO records VALUES (\"backup-check\");"
	sqlite3 /tmp/source.db ".backup /tmp/backup.db"
	test "$(sqlite3 /tmp/backup.db "PRAGMA integrity_check;")" = ok
	test "$(sqlite3 /tmp/backup.db "SELECT value FROM records;")" = backup-check
'

echo "Container health and SQLite backup smoke tests passed"