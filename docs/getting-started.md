# Getting Started

## Requirements

- Docker Engine with Compose for deployment, or Bun 1.4.4 for development.
- Source-provider credentials with access to the repositories being profiled or migrated.
- GitHub target credentials with organization and migration permissions.
- An absolute `ARCHIVE_DIR` for GitLab-to-GHEC and all GitLab/Bitbucket-to-GHES paths.
- Pinned SFTP credentials plus an absolute `ARCHIVE_DIR` for Bitbucket-to-GHEC.
- The matching exporter image for GitLab/Bitbucket-to-GHES paths.

## Start The Dashboard

```bash
cp .env.example .env
docker compose up -d --build --wait
```

Open `http://localhost:3000`. The example configuration is intentionally open
for trusted local use. Before publishing it beyond that network, replace
unauthenticated mode with first-administrator bootstrap credentials; see
[Configuration](configuration.md#core). Add operators from **Manage users**
after signing in.

If using another hostname, IP address, port, or HTTPS, set `ORIGIN` in `.env`
to that exact browser-visible origin before starting the containers.

## Choose Your Path

| Goal | Supported path | What to do |
|---|---|---|
| Profile a source | GitHub organization, GitLab namespace, or Bitbucket project | Configure the source credentials, open **Profile**, and review the completed readiness report before planning migrations. |
| Migrate to GHEC | GitHub, GitLab, or Bitbucket Server to GitHub Enterprise Cloud | Configure source and target credentials. GitLab also requires an absolute archive directory; Bitbucket requires pinned SFTP archive access. Profile the source when readiness findings are needed, then choose **New migration** and the GHEC target. |
| Migrate to GHES | GitLab or Bitbucket Server to a configured GitHub Enterprise Server target | Configure the source, GHES API and SSH credentials, archive storage, and exporter image; verify the pinned SSH host key before choosing the GHES target. |
| Attribute mannequins | Migrated source identities in a GHEC organization | Configure a GHEC target organization and credential, open **Mannequins**, map each source identity to a visible target member, and send the attribution invitation. |

GitHub-to-GHES migration is not supported. See the generated
[support matrix](architecture.md#migration-pipeline) for the authoritative
source and target combinations.

## Configure Providers

1. Configure one GitHub source and target credential mode: PAT or all three App values.
2. Add GitLab or Bitbucket server-owned credentials when those providers are needed.
3. Configure archive storage for GitLab-to-GHEC and pinned SFTP archive access for Bitbucket-to-GHEC.
4. Add a GHES target profile and pinned SSH host key for exporter-to-GHES migrations.
5. Restart the container and check `/api/ready`.

The **Setup** page reports available providers, credentials, target profiles,
and migration paths without exposing secret values.

## Profile A Source

Choose **Profile**, select the provider and organization/namespace, then
start the run. The detail page streams discovery progress and records provider
coverage, repository metrics, warnings, blockers, and planning candidates.

Completed profiles can produce a bounded batch plan. Review each source and
target mapping before opening the migration workflow. A GitHub batch launched
from a profile requires successful repository analysis for selected
repositories with warnings or blockers. Start that analysis from the completed
profile page and wait for the analyzer service to finish, or retry failed
repository jobs there. Clear repositories remain eligible without analysis.

## Start A Migration

1. Choose a supported source and target route.
2. Select single or batch mode and enter repository mappings.
3. Confirm source access, destination, visibility, and execution options.
4. Resolve readiness errors and review the final mapping.
5. Type the production confirmation when required, then launch.

The migration appears immediately. Work beyond capacity remains queued and
starts automatically. Detail and batch pages reconnect to durable event cursors
after navigation or transient network loss.

## Attribute Mannequins

Choose **Mannequins**, select a configured GHEC organization, and map each
unclaimed source identity to a visible organization member. The dashboard sends
the invitation through GitHub and records the operator action, but GitHub owns
acceptance. Invitation status is not persisted or polled by the dashboard, so
review pending or rejected invitations in GitHub before sending another.

## Stop The Dashboard

```bash
docker compose down
```

The named data and archive volumes remain. Use `docker compose down --volumes`
only when the persisted database and archives are intentionally disposable.