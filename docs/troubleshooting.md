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

Bootstrap environment credentials create the first administrator only; they do
not override a stored user's password. Ask an administrator to reset the user,
or stop the dashboard and run `bun run auth:reset --username <administrator>`.
The temporary password must be changed after sign-in.

Set `ORIGIN` to the exact browser-visible origin for direct HTTP access as well
as TLS termination. The container default is `http://localhost:3000`; browsing
`http://127.0.0.1:3000`, a LAN hostname, or an HTTPS URL requires a matching
override. Do not disable origin protection to work around a mismatch. Configure
`ADDRESS_HEADER` and `XFF_DEPTH` only when every request passes through the
trusted proxy. Existing sessions can be revoked from **Manage users**.

## Provider Setup Is Unavailable

For a first Bitbucket Data Center → GHES installation, use the
[deployment and pilot checklist](bitbucket-datacenter-to-ghes.md). The base
Compose file alone can start a healthy dashboard without a usable exporter.

Review the **Setup** page and [Configuration](configuration.md). GitHub App mode
requires ID, private key, and installation ID together. GitLab and Bitbucket
credentials are server-owned. Request credentials are hidden when credential
override is disabled.

## GitHub Rejects Target Access

A configured target credential can still be invalid, expired, installed on the
wrong organization, or missing migration permissions. A `401` means GitHub
rejected the PAT or App installation token; replace the credential or verify the
App installation. The Mannequins page uses `GH_TARGET_PAT` or the target GitHub
App for GHEC, and `GHES_TARGET_ADMIN_PAT` for GHES. A `403` usually means the credential is valid but cannot view
the organization, mannequins, or members, or cannot create attribution
invitations.

## Repository Analysis Does Not Advance

Check `docker compose ps profile-analyzer` for status and
`docker compose logs --tail=100 profile-analyzer` for clone, source-App
authentication, lease, and cleanup failures. Inspect the recent probe output
for a timed-out phase or an unavailable listener:

```sh
docker inspect --format '{{json .State.Health}}' "$(docker compose ps -q profile-analyzer)"
```

Confirm the service shares the dashboard's `DATA_DIR` and that its private
`ANALYSIS_DIR` is writable with enough space for the configured workspace limit.
Docker's `unless-stopped` restart policy acts on process exit. If the service
remains unhealthy after addressing the reported cause, restart only the
analyzer with `docker compose restart profile-analyzer`. Watch for healthy status
and check the analysis run in the dashboard for progress. An interrupted job
can be reclaimed after its lease expires. Retry failed jobs from the profile
detail page.

## Another Device Cannot Reach The Dashboard

The Compose deployment publishes to `127.0.0.1` by default. Set
`GH_MIGRATE_PUBLISH_HOST=0.0.0.0`, restart Compose, and allow TCP port 3000 only
from the intended network. The Vite development server already listens on all
interfaces on port 5173.

On WSL2, confirm the distribution is using mirrored networking or configure
the required forwarding. Windows Defender Firewall, including the Hyper-V
firewall applied to WSL, must also allow the selected port; a Linux listener
alone does not prove that another LAN device can reach it.

## SSH Or Archive Transfer Fails

Confirm the administrative host, port, username, private key, and pinned
SHA-256 host-key fingerprint. Verify that `ARCHIVE_DIR` is absolute and shared
with the configured exporter volume. Check archive size limits before retrying.

Never bypass host-key verification to diagnose production transfers.

## A Migration Requires Confirmation

`reconciliation_required` means a remote write may have completed but the
dashboard cannot prove its outcome. Inspect the source, target, persisted event
log, and GHES import state. For GHES, inspect the **saved GUID** on the appliance.
A missing target repository is not proof that the import never ran. A known
audit or unlock checkpoint continues on that GUID; do not submit another import
or erase its checkpoint. Use the confirmation endpoint/UI only after deciding
that the next operation is safe.

A paused GitLab-to-GHES import can also hold the appliance slot. After verifying
that its remote operation is inactive and the appliance lock is free, an
administrator can send `POST /api/migrate/:id/confirm-restart` with
`{"confirmation":"<targetOrg>/<targetRepo>"}` using the exact saved target.
The dashboard records the review, retains the import checkpoint, marks the
migration failed, and drains eligible work. GitLab-to-GHES execution stays paused.

## Live Progress Disconnects

The UI reconnects with a durable event cursor. Check proxy buffering and idle
timeouts for `text/event-stream`, and ensure the proxy does not strip
`Last-Event-ID`. Reloading is safe; the bounded replay restores recent history.

## Collect Diagnostics

Record the dashboard version, provider and target type, migration/profile ID,
terminal state, relevant event messages, and sanitized container logs. Do not
include tokens, private keys, session cookies, or archive contents.
