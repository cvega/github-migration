#!/bin/sh
# Fix ownership on mounted volumes, then drop to non-root user
chown -R app:app /data
[ -d /archives ] && chown -R app:app /archives
exec su-exec app "$@"
