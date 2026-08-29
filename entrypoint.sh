#!/bin/sh
# Fix ownership on mounted volumes, then drop to the unprivileged application user.
find /data ! -user app -exec chown app:app {} + 2>/dev/null || true
[ -d /archives ] && find /archives ! -user app -exec chown app:app {} + 2>/dev/null || true
if [ -S /var/run/docker.sock ]; then
	socket_gid="$(stat -c '%g' /var/run/docker.sock)"
	socket_group="$(awk -F: -v gid="$socket_gid" '$3 == gid { print $1; exit }' /etc/group)"
	if [ -z "$socket_group" ]; then
		socket_group=docker-host
		addgroup -S -g "$socket_gid" "$socket_group"
	fi
	addgroup app "$socket_group"
fi
exec su-exec app "$@"