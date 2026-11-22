# Getting Started

## Requirements

- Docker Engine with Compose for deployment, or Bun 1.4.4 for development.
- Source-provider credentials with access to the repositories being profiled or migrated.
- GitHub target credentials with organization and migration permissions.
- An absolute `ARCHIVE_DIR` for GitLab-to-GHEC and Bitbucket-to-GHES.
- Pinned SFTP credentials plus an absolute `ARCHIVE_DIR` for Bitbucket-to-GHEC.
- The Bitbucket exporter image for Bitbucket-to-GHES.

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
| Migrate to GHES | Bitbucket Server to a configured GitHub Enterprise Server target | Configure the source, GHES API and SSH credentials, archive storage, and exporter image; verify the pinned SSH host key before choosing the GHES target. |
| Map identities | GHES import users or mannequins exposed by GHEC or GHES | Open **Mannequins**, select a target organization, and save mappings before migration. Check membership and apply unique mannequin matches, or use approved user URLs during a GHES import. |

GitHub-to-GHES migration is not supported. GitLab-to-GHES execution is paused;
GitLab profiling and migration to GHEC remain available. See the generated
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
5. Launch the migration. For GitHub sources, **Keep source unlocked** skips both
   locking and archiving. **Lock and archive source** asks for confirmation:
   each source is locked during migration and archived after its migration succeeds.
   Both choices write repository data to the destination, for single and batch migrations.

The migration appears immediately. Work beyond capacity remains queued and
starts automatically. Detail and batch pages reconnect to durable event cursors
after navigation or transient network loss.

After success, **Resource verification** shows recorded destination totals, not
the number of items transferred. Commit counts cover the default branch's
history. If counts are unavailable, **Fetch counts** shows the current
repository at the target path. It does not backdate those counts or update
Statistics: the repository could have changed or been recreated since import.

All migration directions use the same six-stage pipeline. The event log shows
provider-specific operations; they do not add stages to the pipeline.
“Queue” represents the queued phase. A completed rail is a summary, not
evidence that the run spent time in a queue. “Checking for GHES import
errors” announces the post-import audit, not a finding.

## Export Statistics

**Top failure reasons** groups historical failures within the selected filters.
Follow the dated run link for the full diagnostic; a reason can remain on the
report after a later migration succeeds.

Open **Statistics**, select the report filters, and choose the printer icon
(**Print or save PDF**).
In the browser's print dialog, select **Save as PDF** to save the filtered report
with a cover and closing page showing the selected filters.

Statistics count migration attempts. The seven-day windows use UTC calendar days
ending today, and the Started filter selects migrations by their start time.
The completions chart covers the selected cohort's recorded completion dates;
spans over 210 days are grouped into labeled multi-day intervals.
Source repository size is the sum of available sizes for successful migrations,
not measured bytes transferred. Destination resource counts are recorded final
repository totals, not a count of items transferred. Coverage is shown beside
the totals. Commit counts represent default-branch history; older counts may
contain zeros from unavailable API data.

## Map Identities

Choose **Mannequins**, select the target and organization, and add mappings
individually or import a CSV with the exact header
`source_identity,target_username`. Select the source identity type for all CSV
rows. GHES `ghe-migrator` mappings use the exact source user URL reported by
the exporter; mannequin mappings use the exact mannequin login or node ID.
Mappings can be saved before the target user joins or the mannequin exists.

Use **Check mappings** to check target users, organization membership, and
mannequin matches. GHES imports apply matching user URLs after checking that
the target account exists. For mannequin mappings, **Send matched invitations**
sends invitations only for unique matches with active organization members.
Ambiguous, missing, and pending matches are skipped and reported. GitHub owns
acceptance; run the check again to see claimants. The dashboard does not detect
rejections, so verify uncertain or rejected invitations in GitHub before
taking further action.

## Stop The Dashboard

```bash
docker compose down
```

The named data and archive volumes remain. Use `docker compose down --volumes`
only when the persisted database and archives are intentionally disposable.