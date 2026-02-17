#!/bin/sh
# Fix ownership on mounted volumes, then drop to non-root user
# Only chown if not already owned by app (avoids slow recursive walk on large volumes)
find /data ! -user app -exec chown app:app {} + 2>/dev/null || true
[ -d /archives ] && find /archives ! -user app -exec chown app:app {} + 2>/dev/null || true
exec su-exec app "$@"
