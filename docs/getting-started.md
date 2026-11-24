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
after signing in. On the operator’s user record, open **Migration access**.
Open the source picker, filter by project or organization, check one or more destinations, choose **View only** or
**View and migrate**, and select **Assign destinations**. Repeat for other
sources or for destinations that need a different permission. An assigned
destination shows its permission and a **Remove** action instead of a checkbox.

The sources are not user accounts or manually created mappings. Each is a
provider, instance and namespace from a completed **Profile** run. **View
report** opens its latest completed inventory. A source stays in the picker
even when no target is listed or deployment credentials cannot migrate it.

**Manage targets** shows destinations grouped by GitHub connection. The same
login on Cloud and Server represents two separate targets. Select **Add
target**, choose **Cloud** or **Server**, then enter an existing organization
login or use **Find organizations** and add a result. Discovery uses the
target credential's organization memberships (or its App installation);
it does not enumerate every organization on GitHub. A listed target belongs
to that connection and grants nobody access until you map it to a user.
Deployment organizations (`GH_TARGET_ORG`, `GHES_TARGET_ORG`) appear
automatically and are managed by configuration. **Connection details** shows
the endpoints and explains each connection's migration scope. A listed route outside the
migration credential scope can be assigned **View only** if the source's
profiling scope allows it. To enable migration, add that specific source
or target to its deployment allowlist; do not remove the allowlist.

Operators use the same **Profile** and **Migrations** tabs as admins.
**Switch source** appears when more than one source is assigned. In **Build
migration plan**, a single destination is shown directly; with several, the
operator must choose one. A batch goes to one destination, not all of them.
An account without assignments has empty lists, not access to every profile.

If using another hostname, IP address, port, or HTTPS, set `ORIGIN` in `.env`
to that exact browser-visible origin before starting the containers.

## Choose Your Path

| Goal | Supported path | What to do |
|---|---|---|
| Profile a source | GitHub organization, GitLab namespace, or Bitbucket project | Configure the source credentials, open **Profile**, and review the completed readiness report before planning migrations. |
| Migrate to GHEC | GitHub, GitLab, or Bitbucket Server to GitHub Enterprise Cloud | Configure source and target credentials. GitLab also requires an absolute archive directory; Bitbucket requires pinned SFTP archive access. Profile the source when readiness findings are needed, then choose **New migration** and the GHEC target. |
| Migrate to GHES | Bitbucket Server to a configured GitHub Enterprise Server target | Configure the source, GHES API and SSH credentials, archive storage, and exporter image; verify the pinned SSH host key before choosing the GHES target. |
| Map identities | GHES users and teams, or mannequin attribution | Open **Mappings**. Save an exact match manually or by CSV. GHES resolves archive conflicts before import; mannequin attribution happens after import. |

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

### Discover namespaces for profiling

In **Profile**, **Recent profiles** shows 10 runs per page. Search by namespace
or provider across the full history, or use the numbered pager. Expand a row
to review its observations or open the full report. Choose **New profile**, pick
the source, select the single-namespace scope, then **Discover namespaces**. Filter the loaded
results, load another page, or refresh to pick up newly created projects.
Selecting a row fills the namespace; **Start profile** collects its repository data.
Counts here describe loaded entries, not the size of the enterprise.

Bitbucket Data Center profiles aggregate commits on the default branch, incoming
pull requests, branches, tags and forks from separate repository APIs. The profile
shows private and public repository counts; Bitbucket has no internal visibility
category. Archived status is counted separately. These
counts describe repository contents, not programming languages. Unlike GitHub's
repository languages API, Bitbucket Data Center has no documented equivalent
that returns bytes per language; that breakdown requires analyzing source files.

Bitbucket profiles also request **Retrieve size details** from each repository's
settings (one additional read per repository). Source storage shows the reported
repository and attachment bytes, not a clone estimate or total disk usage.
This settings endpoint varies by version and access; missing measurements are
not counted as zero. Partial sums are labeled “At least.” Older snapshots are
not backfilled.

Bitbucket repository rows identify a fork's immediate upstream when Bitbucket
reports one. New profiles also read up to 100 lines of the default branch's
root `.gitattributes` through the browse API, looking for explicit `filter=lfs`
rules. **Source storage → Repos with LFS tracking rules** shows how many checked
repositories have a rule. **Export** downloads each captured repository's name,
default branch, and tracking result as JSON. Unverified repositories are excluded from
the denominator. This is not an object count or byte total.
A missing root file is not proof that a repository has no LFS objects.
Unreadable or incomplete checks without a match are shown as not verified.
No clone, history scan, file listing, or LFS payload download is required.

Discovery uses the configured source host and credential: Bitbucket projects,
GitLab groups (including subgroup paths), and GitHub user organizations or the
organization owning the configured App installation's visible repositories.
The existing namespace restrictions apply by default. To allow administrators
to profile what a particular source credential can read, set
`PROFILE_CONNECTION_SCOPE` to one or more provider IDs (`bitbucket-server`,
`gitlab`, `github`). Use a least-privilege source credential. This opt-in affects
discovery and profile submission, not migration authorization.

Select **Entire enterprise** in **New profile** and click **Start profile** to
discover all eligible namespaces, not just the
loaded page. On Bitbucket this means visible projects on the configured
instance. For GitHub enter the enterprise slug; the source credential must be
able to list its organizations and read the repositories you want to profile.
For GitLab.com specify the enterprise group; on self-managed GitLab leave it
blank to cover visible groups. A parent group profile includes its subgroups.
The server queues work only after discovery finishes, and processes namespaces
one at a time per provider. You can close the page once queued. Pending work
survives a restart; interrupted runs are reported as failed in **Profile runs**.
Running and queued namespaces are not added twice. Completed profiles are
refreshed. Coverage is limited to the source credential and profile policy;
an empty result does not certify an empty enterprise.

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

The event log grows with its rows and scrolls once it reaches its maximum
height. Use the download icon beside the event count to save the full log for one
migration as newline-delimited JSON, oldest first. A download during a run
includes events recorded up to the start of the download. Cancellation requests
are distinct from confirmed cancellations: if the remote outcome is uncertain,
the log records that review is required. Review and restart appear in the same
log before the next attempt's steps.

After success, **Target repository contents** lists one resource per row with
its exact destination total, not
the number of items transferred. Commit counts cover the default branch's
history. If counts are unavailable, **Fetch counts** shows the current
repository at the target path. It does not backdate those counts or update
Statistics: the repository could have changed or been recreated since import.

All migration directions use the same six-stage pipeline. The event log shows
provider-specific operations; they do not add stages to the pipeline.
For new GHES archive imports, export and archive import events advance the rail
as they happen. The downloaded step's `payload.executorPhase` identifies the
specific operation (for example, `mapping` or `auditing`), even when there is
no corresponding shared `phase`. Once the archive is ready, the rail marks
Exporting complete and shows the current transfer, preparation, or mapping
operation above the steps. Git Import starts when GHES starts the import,
not when the archive is uploaded. GHES imports Git and metadata together.
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

Choose **Mappings**. The **Users** and **Teams** lists show approved decisions across
configured organizations, not a feed of migration conflicts. Choose **Add** or **Import CSV**;
the organization and source type in the form scope that decision across repos.
For a manual Bitbucket user mapping, enter the **Bitbucket username**. Saved rows
show that source username beside the target GitHub login; no source URL is needed.
Bitbucket → GHES applies approved identities present in the prepared archive
with the organization and repository mappings, then checks for remaining conflicts.
Different Bitbucket groups in the same project require separate approvals when they conflict.
Each repository migration processes only its own archive, including when it belongs to a batch.
Bitbucket → GHES preserves Git tags in the mirrored repository but excludes release
metadata, so tags do not create GitHub Releases.
For Bitbucket → GHES the worker reads that archive's identity records locally instead
of launching a GHES mapping audit. If it cannot read the manifests within five
seconds it falls back to the remote audit. GHES applies the mappings to its prepared
import, not to the Bitbucket repository or the export archive, and checks
for unresolved conflicts before import.
Use the pencil on a saved user or team mapping to change its GitHub target without
changing the source identity. The trash button removes the saved mapping.
For a manual Bitbucket team mapping, enter the **Bitbucket project key** and
**Bitbucket group name**. Project-scoped rows show the Bitbucket project key
in the source column and only the GitHub team slug in the destination column. The importer still
matches the exact archive identity. User CSV header: `source_identity,target_username`. Team CSV header:
`source_identity,target_team_slug`. Keep the exact source URL, including a Bitbucket
group's project fragment. Mannequin mappings use an exact mannequin login or node ID.
GHES prepares the archive, queries conflicts, applies matching approved users and teams
and rechecks before import. A team merge requires a saved decision. If a decision is
missing, the run stops before import: save the indicated mapping, review the run status,
then restart. Team mappings are not GHEC mannequin invitations.
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