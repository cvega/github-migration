#!/bin/sh
set -eu

# Fix ownership on mounted volumes, then drop to the unprivileged application user.
ensure_owned() {
	directory="$1"
	[ -d "$directory" ] || return 0
	find "$directory" ! -user app -exec chown app:app {} +
	if find "$directory" ! -user app -print -quit | grep -q .; then
		echo "Unable to assign $directory to the application user" >&2
		exit 1
	fi
	if ! su-exec app test -w "$directory"; then
		echo "$directory is not writable by the application user" >&2
		exit 1
	fi
}

ensure_owned /data
ensure_owned /archives
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