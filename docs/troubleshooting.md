# Troubleshooting

## Readiness Fails

Check container logs and `/api/health`. A healthy process with failing
`/api/ready` usually indicates database initialization, write access, schema
upgrade, or data-directory lock failure. Confirm that only one dashboard
process uses the volume and that `/data` is writable by the application user.

## A Second Instance Will Not Start

This is expected when both instances share `DATA_DIR`. Stop the existing
process cleanly. Do not delete lock files while a process may still be running;
the lock is a correctness guard for the in-memory queue and recovery manager.

## Login Loops Or POST Origin Errors

Verify the configured username/password and ensure the session secret is at
least 32 independent characters. Behind TLS termination, set `ORIGIN` to the
browser-visible URL. Changing the session secret invalidates existing cookies.

## Provider Setup Is Unavailable

Review the **Setup** page and [Configuration](configuration.md). GitHub App mode
requires ID, private key, and installation ID together. GitLab and Bitbucket
credentials are server-owned. Request credentials are hidden when credential
override is disabled.

## SSH Or Archive Transfer Fails

Confirm the administrative host, port, username, private key, and pinned
SHA-256 host-key fingerprint. Verify that `ARCHIVE_DIR` is absolute and shared
with the configured exporter volume. Check archive size limits before retrying.

Never bypass host-key verification to diagnose production transfers.

## A Migration Requires Confirmation

`reconciliation_required` means a remote write may have completed but the
dashboard cannot prove its outcome. Inspect the source, target, persisted event
log, and GHES import state. Use the confirmation endpoint/UI only after deciding
that repeating the next operation is safe.

## Live Progress Disconnects

The UI reconnects with a durable event cursor. Check proxy buffering and idle
timeouts for `text/event-stream`, and ensure the proxy does not strip
`Last-Event-ID`. Reloading is safe; the bounded replay restores recent history.

## Collect Diagnostics

Record the dashboard version, provider and target type, migration/profile ID,
terminal state, relevant event messages, and sanitized container logs. Do not
include tokens, private keys, session cookies, or archive contents.