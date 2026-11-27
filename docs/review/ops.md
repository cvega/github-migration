# Operations, deployment and test review

Reviewed the Docker targets, Compose and provider overrides, entrypoint, deployment/configuration guidance, workflows, gate manifest, and test inventory. This was a static defensive review; no live migrations, provider systems, or production data were used.

## Findings

### P2 — Image readiness probe ignores a nondefault port

Beads issue gh-migrate-dashboard-kbd tracks this finding. `Dockerfile:31-35` exposes `PORT` but hard-codes port 3000 in the image health check. An otherwise working direct container deployment using another port is therefore marked unhealthy; Compose fixes the port to 3000 and is unaffected. `scripts/packaging/container-smoke.sh` exercises only the default. Make the image probe use the configured port and exercise a nondefault port in production-image smoke coverage.

### P2 — Analyzer progress has no independent health signal

Beads issue gh-migrate-dashboard-558 tracks this finding. The analyzer target (`Dockerfile:39-57`) and service (`docker-compose.yml:35-55`) define no health check, while the dashboard probe checks only `/api/ready`. A running but stalled analyzer can leave queued work without the stack's readiness indicating that the worker is not making progress. Add a separately actionable worker liveness/progress signal, with appropriate thresholds and failure/recovery coverage; do not conflate dashboard readiness with worker health.

## Other observations

- Both entrypoints begin as root to repair mounted volume ownership and then use `su-exec app`; the analyzer smoke checks its effective user. The optional exporter override grants Docker socket access, which is an intentional privileged deployment boundary documented in the deployment guidance.
- The documented stopped-service backup includes data and archive volumes, validates SQLite and migration checkpoints, and restores only to fresh volumes. The helper's ledger compares migration and GHES records, not all durable data; `docs/deployment.md:163-166` requires a separate operator comparison of users, grants and configuration. Backup tests cover corruption, unresolved migrations and paired restore, but cannot establish that an operator performed that comparison.
- PR, main and release invoke the reusable verification workflow, which builds and scans both targets and runs container smoke and base Compose checks. Main and release publish only the dashboard; deployment documentation explicitly requires a same-revision local analyzer build. Provider contracts and full mutation tests run separately on schedules, not on each PR. The smoke suite checks analyzer startup, not sustained queue progress or a real provider migration.
- Configuration and deployment documentation cover origins, shared SQLite storage, non-root runtime, volume backup and restore, and the separate analyzer. No live container build, image scan, external provider contract, or production backup was run as part of this review.

## Verification

`bun install --frozen-lockfile` succeeded with Bun 1.4.4. One `bun run verify` completed successfully: all gates passed, including 38 Playwright tests, 92.17% function and 90.66% line coverage, and a clean dependency audit. Production container smoke and image scans are separate CI jobs and were not run locally.
