# GitLab profile coverage

Audited on 2026-11-28 against dashboard `main` at
`efef6b07c9cf7b878f43a5497b0d42f105b2a576`, using source code and public
GitLab and GitHub documentation. No provider instance or migration was run.

## What the dashboard collects

The GitLab profile uses the server-configured GitLab personal access token
(PAT). [Discovery](../src/lib/server/source/gitlab/inventory.ts) pages
`GET /groups/:id/projects` with `include_subgroups=true`, `with_shared=false`,
`simple=false`, and `statistics=true`. The inventory is limited to visible
projects under the selected namespace, up to 10,000 projects. It records
project ID, path, name, visibility, archive state, default branch, last
activity, six storage sizes when reported, and optional project metadata.
**It does not collect general native group-level metrics or settings.** Webhook
dependency enrichment now inspects group hooks inside the selected namespace. The
[namespace summary](../src/lib/server/profile/analysis/overview.ts) rolls up
the captured projects, not the entire GitLab group.

[Per-project enrichment](../src/lib/server/source/gitlab/profile.ts) records
issues and merge requests visible to the caller (all states and authors),
enumerates branches, tags, and releases, and counts commits reachable from
the default-branch head. It uses
`GET /projects/:id/repository/branches/:branch` to resolve that head and
`GET /projects/:id/repository/commits/:sha/sequence` for the count. The branch
and tag totals say nothing about protection rules, which are counted separately
(see the protected branch and tag rules rows below). A GitLab project
statistics `commit_count` is a separate observation and is not the source of
the current Commits tile.

Webhook enrichment enumerates `GET /projects/:id/hooks` and
`GET /groups/:id/hooks`, including pages and retries in the shared profile
request budget. It stores only counts and allowlisted enabled event categories,
never destinations, header values, secrets, or raw hook payloads. Project hooks
and inherited group hooks are reported separately, so zero project hooks do not
hide a group-triggered deployment dependency. Group counts represent project-hook
relationships, not distinct hooks across the profile. Only ancestors from the
selected namespace through the project's immediate group are inspected; ancestors
above that authorization boundary remain uninspected, even when the scoped count
is exact. GitHub Enterprise Importer does not recreate either kind of webhook.

Permission failures (`401`/`403`) are `unavailable / forbidden`; hidden or
unlicensed endpoints (`404`, including Premium/Ultimate-only group hooks) are
`unavailable / not-reported`, never zero. Collection continues for other scopes.
Budget exhaustion preserves observed hooks as a lower bound, or records
`unavailable / request-budget` before any evidence. Partial group access also
preserves a lower bound and identifies the limiting reason in its scope. Event
categories describe affirmative observations, not proof that other events are
disabled. The Repository contents cards expose separate counts and observed
project/group event categories.

On this revision, no per-project statistics fallback is made. If the group
listing omits `statistics` or returns `null`, the six stored sizes are
`unavailable / not-reported`, not zero. A sum of known project sizes is a
lower bound when some projects have no observation. The report in the
pending 6qc task describes this listing behavior on GitLab 19.6.1 even with a
group Owner token. That change proposes a bounded fallback to
`GET /projects/:id?statistics=true` and adds `commit_count`,
`job_artifacts_size`, `pipeline_artifacts_size`, `snippets_size`, and
`container_registry_size` to collection. None of that is counted as coverage
on the audited revision. Registry and package item counts would still be
separate from storage bytes.

## How to read the audit

All paths below are relative to GitLab REST `/api/v4`. For authenticated
reads, the baseline is a PAT with [`read_api`][scopes] (or the broader
`api`) **and** the resource access in each row. Feature visibility, GitLab
tier, instance settings and custom roles can change what the caller sees.
`read_repository` is also valid for the repository files API, not a
substitute for general API access. GitLab's project export is a separate
operation: GitLab requires a project Maintainer or Owner, and
[GitHub's GitLab migration guide][migration-access] specifies `api` and
`read_repository` for its export-and-import workflow.

**Importer** means GitHub Enterprise Importer for **GitLab to GitHub
Enterprise Cloud**, not the GitHub-to-GitHub coverage table or the generic
GitHub Importer. The [dashboard executor](../src/lib/server/migrate/executors/gitlab-to-ghec.ts)
also submits a GitLab project export to the native GitHub import service.
[GitHub's GitLab coverage][github-coverage] is conditional on the data being
in the archive; [GitLab's export coverage][gitlab-export] is not proof that
GitHub will import it. **Not documented** means don't rely on automatic
transfer; it is not a tested assertion that the importer drops the data.
GitLab-to-GHES is paused in the dashboard. GitHub distinguishes the 40 GB
GitLab.com export limit (the whole archive) from the 40 GiB Git source limit
(public preview); the project storage counters are not either measurement.

## Project storage and volume

For all rows in this table the documented endpoint is
[`GET /projects/:id?statistics=true`][projects]. It requires Reporter,
Developer, Maintainer, or Owner. Main only reads the six indicated fields
from the group project listing if reported; it doesn't call this endpoint.
Sizes are bytes, not object counts or a prediction of the compressed export
size.

| GitLab statistics field | Profile on main | GitHub Enterprise Importer |
| --- | --- | --- |
| `repository_size` | Yes, when reported. | Git source and history migrate within GitHub's limits; the byte counter itself does not migrate. |
| `storage_size` | Yes, when reported. | No equivalent transfer of the GitLab storage total. It includes data beyond the Git source that may not migrate. |
| `commit_count` | No; the Commits tile uses default-branch reachability instead. | History migrates, not the counter. |
| `lfs_objects_size` | Yes, when reported; no object enumeration. | LFS pointers travel in Git; binaries need a separate transfer. |
| `packages_size` | Yes, when reported; no package inventory. | No; packages are excluded from GitLab project export. |
| `wiki_size` | Yes, when reported; no page inventory. | Project wiki repository migrates when present in the archive. |
| `uploads_size` | Yes, when reported. | Project attachments migrate when present in the archive. |
| `job_artifacts_size`, `pipeline_artifacts_size` | No. | No; GitHub excludes job artifacts and does not migrate GitLab pipelines. Don't infer pipeline artifact coverage from the Git export. |
| `snippets_size` | No. | No; GitHub explicitly excludes snippets even though GitLab exports them. |
| `container_registry_size` | No. On self-managed GitLab this field requires the registry metadata database. | No; container images are excluded from GitLab project export. |

## Project features and migration follow-up

| Data and endpoint | GitLab access beyond the PAT scope | Profile on main | GitHub Enterprise Importer |
| --- | --- | --- | --- |
| **CI/CD configuration**: [`GET /projects/:id`][projects] for `builds_access_level`, `ci_config_path`, and `auto_devops_enabled`; [`HEAD /projects/:id/repository/files/:file_path?ref=HEAD`][files] for metadata-only presence of the local config (default `.gitlab-ci.yml`). | Project visibility for the builds setting, repository read access for the path/file, and Maintainer or Owner for the Auto DevOps field. [Custom config][ci-config] may be in a different project or on an external host. | Yes, since this audit: classifies a found local file, an external or cross-project reference (never fetched), enabled Auto DevOps, absence, or unknown; no path or content is retained. | Git-tracked YAML migrates as a file, not as an Actions workflow. Pipelines, schedules, and triggers don't migrate. |
| **CI/CD variable count**: [`GET /projects/:id/variables`][project-variables], paginated. Count entries, not distinct keys (environment scopes can differ). | Project Maintainer or Owner. The list returns values, including data that must not enter the profile; there is no documented count-only response. | No. | No; CI/CD variables are not exported. |
| **Protected branch and tag rules**: [`GET /projects/:id/protected_branches`][protected-branches] and [`GET /projects/:id/protected_tags`][protected-tags]; names/patterns, access levels, and applicable branch inheritance and force-push settings. | Branch listing requires [repository read access][branch-read]; tag rule listing is [available to Maintainers and Owners][tag-read], not a Guest read. Some rule details require Premium or Ultimate. | Yes; counts project branch rules (excluding group-inherited ones), inherited branch rules, and tag rules separately from refs, each wildcard pattern once. 401/403 records `forbidden`, 404 `not-found-or-hidden`; access levels are not retained. | No; Git refs are not the same as protection policy. Recreate policy on the target. |
| **Webhooks**: [`GET /projects/:id/hooks`][project-hooks]; count and event types. | Project Maintainer, Owner, or instance administrator. Don't retain hook destinations, headers, or other configuration containing secrets. | No. | No; webhooks are not in the archive. |
| **Deploy keys**: [`GET /projects/:id/deploy_keys`][deploy-keys]; presence and `can_push` per project. | Project administration permission (Maintainer or Owner for standard roles); the instance-wide list is admin-only and not needed. | No. | Not documented; GitLab explicitly excludes deploy keys allowed to push to protected branches. Plan to set up replacement access. |
| **Members**: [`GET /projects/:id/members` and `GET /projects/:id/members/all`][project-members]; direct vs. effective access including inherited/invited memberships. | Authenticated caller with project member-list access (Guest on a private project under standard permissions); results are caller-visible and `/all` returns the highest access level per user. | No. | Partial: project members in the archive migrate as mannequins, not as live target access grants. [Export authority][gitlab-export] affects included memberships; [mannequin reclamation][github-follow-up] and destination access are separate tasks. |
| **LFS**: [`GET /projects/:id`][projects] for `lfs_enabled` plus `statistics.lfs_objects_size`. The toggle is not evidence that objects exist. | Project read access for the toggle; Reporter/Developer/Maintainer/Owner for statistics. `read_repository` and repository read access can be used to inspect tracking rules via [repository files][files], but rules are not an object inventory. | Partial: bytes if reported; neither enablement nor tracking rules. | Pointers only; separately transfer LFS objects. |
| **Container registry**: [`GET /projects/:id/registry/repositories?tags_count=true`][registry] plus the repository tags endpoint if needed; `container_registry_access_level` from project details. | [Registry visibility][registry-access] controls results; normally Reporter or higher for private projects or members-only registries. Public/enabled registries are publicly readable. | Partial: optional legacy `container_registry_enabled` flag only, no registry bytes or inventory. | No; images are not exported. |
| **Packages**: [`GET /projects/:id/packages`][packages]; package type, name, version and status. Default statuses don't include every possible state. | Package read access; Reporter is a baseline for private projects (Guest access depends on offering/visibility). Public package data can be available anonymously. | Partial: `packages_size` if reported; no package count or types. | No; packages are not exported. |
| **Wiki**: [`GET /projects/:id/wikis`][project-wiki] for page metadata (omit `with_content`); `wiki_access_level` on project details. | Wiki read access based on feature visibility and membership (Guest on a private project under standard permissions). | Partial: optional legacy `wiki_enabled` flag and bytes if reported, not page count. | Yes, project wiki repository when in the archive. |
| **Snippets**: [`GET /projects/:id/snippets`][snippets] for visible project snippets; `snippets_access_level` on project details. | [Snippet visibility][snippet-access] within project access; private project snippets require membership. Personal snippets aren't project data. | Partial: optional legacy `snippets_enabled` flag; no count or bytes. | No; snippets are explicitly not migrated. |
| **Mirrors**: [`GET /projects/:id/remote_mirrors`][push-mirrors] for push mirrors and [`GET /projects/:id/mirror/pull`][pull-mirror] for pull; enabled state and direction. | Use a project Maintainer/Owner for mirror configuration reads; push listing checks `admin_remote_mirror`; pull mirroring requires Premium or Ultimate and an available feature. Avoid persisting remote URLs or error text. | No. | No; repository mirroring policy isn't migrated. |
| **Forks**: [`GET /projects/:id`][projects] for `forks_count` and `forked_from_project`; [`GET /projects/:id/forks`][forks] lists forks visible to the authenticated caller. | Project read access, plus access to private upstream/fork details. Visible forks need not be the whole fork network. | Partial: optional upstream path from discovery, not a fork count or enumeration. | Git data can be imported as a repository; preservation of the fork relationship is not documented. |
| **Archived**: [`GET /projects/:id`][projects] and [`GET /groups/:id/projects`][group-projects] expose `archived`; the listing can filter on it. | Project read access to observe state; archive/unarchive permissions are not required. Current GitLab can report effective archive state inherited from a group. | Yes: records the flag per project and summarizes archived projects. | Automatic preservation of archive state isn't documented. Verify the destination state explicitly. |
| **Merge request approval rules**: [`GET /projects/:id/approval_rules`][approvals] for project policy; `GET /projects/:id/merge_requests/:iid/approval_rules` for per-MR rules where needed. Rules include required approvals and protected branch applicability. | Premium/Ultimate, authenticated visibility of the applicable rules and MR; [Developer can read project rules via REST][approval-read]. Editing rules is a separate Maintainer/Owner permission. | Yes, since this audit: counts visible project rules and detects required approvals and explicit protected-branch scope without retaining approver identities. Unreadable or unlicensed rules stay unknown; group rules and per-MR overrides are not queried. | Historical reviewers/approvers can migrate with MRs, but do not enforce approvals. Recreate required policy on the target. |

## Group-level observations not collected on main

Group endpoints are not interchangeable with project endpoints. For an
inherited policy, record whether the observation is configured on the chosen
group, inherited from an ancestor, or effective on a project. Do not fetch
outside the authorized namespace to fill a missing result.

| Data and endpoint | GitLab access beyond the PAT scope | GitHub Enterprise Importer |
| --- | --- | --- |
| **Group storage**: [`GET /groups?statistics=true`][group-statistics] returns `statistics` and top-level `root_storage_statistics`. Includes repository, total, wiki, LFS, package, upload, snippet and artifact sizes. Root storage includes dependency proxy and, with registry metadata enabled, `container_registry_size` and `container_registry_size_is_estimated`. | Instance administrator; group Owner alone is insufficient for this API. Don't equate estimated registry bytes with an exact number or sum root storage on top of project totals. | No group storage counter migrates. Eligible project content migrates separately. |
| **Group variables**: [`GET /groups/:id/variables`][group-variables]; count locally configured entries separately from inherited variables. | Group Owner; paginated list also returns values. | No. |
| **Protected branch rules**: [`GET /groups/:id/protected_branches`][group-branches]; inherited by projects. Tag rule reads are project-level. | Top-level group only, Premium/Ultimate and group administration permission (Owner under standard roles). The profile reads it once per run, only when the profiled namespace is itself a top-level group, and merges it by rule name with project rules flagged `inherited`. A 404 records `not-reported` (tier), 401/403 `forbidden`; rules without a project `inherited` flag then stay unclassified, so both branch rule counts are unavailable unless every project rule is flagged. | No; group settings and repository policies don't migrate. |
| **Group webhooks**: [`GET /groups/:id/hooks`][group-hooks]; may fire for projects and subgroups. | Group Owner or instance administrator; Premium/Ultimate. | No. |
| **Group members**: [`GET /groups/:id/members` and `GET /groups/:id/members/all`][group-members]; direct and effective member observations. | Authenticated caller with group member-list access (membership for private groups); invited/private group visibility applies. | No group membership transfer. Some inherited members can appear as project mannequins if in the project archive. |
| **Group registry**: [`GET /groups/:id/registry/repositories`][registry]; registry repositories visible to the caller, not a complete list of all artifacts in the hierarchy. | Registry/project visibility applies; Reporter or higher for private project registries under standard roles. | No. |
| **Group packages**: [`GET /groups/:id/packages`][packages]; includes subgroups by default. | GitLab documents Reporter, Security Manager, Developer, Maintainer, or Owner on at least one project in the hierarchy for the authenticated group list; public visibility also applies. | No. |
| **Group wiki**: [`GET /groups/:id/wikis`][group-wiki]; use metadata without page contents. | Premium/Ultimate and group wiki read access; group and feature visibility apply. | No group wiki transfer is documented. GitHub lists the project wiki, not a group export. |
| **Group archive state**: [`GET /groups/:id?with_projects=false`][group-details] returns group metadata including `archived` on current GitLab. | Group read access (public groups are readable without authentication). Do not retain raw group detail responses, which can include privileged fields. | No group settings transfer. |
| **Group approval rules**: [`GET /groups/:id/approval_rules`][group-approvals]. | Group administrator/Owner; Premium/Ultimate self-managed only when the experimental `approval_group_rules` flag is enabled. Not available on GitLab.com or Dedicated. | No; required approval policy doesn't migrate. |

## Collection limits for follow-up work

Prioritize evidence that changes the cutover plan: workflow and variable
dependencies, protection and access rules, integrations, and artifact
inventories. Keep collection bounded and caller-scoped. Count only complete
visible results as exact; distinguish partial pagination, unsupported
features, unreadable endpoints and missing data from a measured zero. Avoid
group-wide enumeration where scoped project reads suffice.

Collect counts and nonsecret presence signals, not values, member identities,
keys, URLs or raw responses. In particular, variable-list responses can contain
secret values: don't enable collection until a field-selective approach or
an approved count-only handling path has been established.

[scopes]: https://docs.gitlab.com/security/tokens/access_token_scopes/
[migration-access]: https://docs.github.com/en/migrations/using-github-enterprise-importer/migrate-from-gitlab/manage-access
[github-coverage]: https://docs.github.com/en/migrations/using-github-enterprise-importer/migrate-from-gitlab/understand-migrations
[github-follow-up]: https://docs.github.com/en/migrations/using-github-enterprise-importer/migrate-from-gitlab/follow-up-tasks#reclaiming-mannequins
[gitlab-export]: https://docs.gitlab.com/user/project/settings/import_export/#export-a-project-and-its-data
[projects]: https://docs.gitlab.com/api/projects/#retrieve-a-project
[group-projects]: https://docs.gitlab.com/api/groups/#list-projects
[group-details]: https://docs.gitlab.com/api/groups/#retrieve-a-group
[group-statistics]: https://docs.gitlab.com/api/groups/#list-groups
[files]: https://docs.gitlab.com/api/repository_files/#get-file-metadata-only
[ci-config]: https://docs.gitlab.com/ci/pipelines/settings/#specify-a-custom-cicd-configuration-file
[project-variables]: https://docs.gitlab.com/api/project_level_variables/#list-project-variables
[group-variables]: https://docs.gitlab.com/api/group_level_variables/#list-all-group-variables
[protected-branches]: https://docs.gitlab.com/api/protected_branches/#list-protected-branches
[protected-tags]: https://docs.gitlab.com/api/protected_tags/#list-protected-tags
[branch-read]: https://gitlab.com/gitlab-org/gitlab/-/blob/master/lib/api/protected_branches.rb
[tag-read]: https://gitlab.com/gitlab-org/gitlab/-/blob/master/spec/requests/api/protected_tags_spec.rb
[group-branches]: https://docs.gitlab.com/api/group_protected_branches/#list-protected-branches
[project-hooks]: https://docs.gitlab.com/api/project_webhooks/#list-webhooks-for-a-project
[group-hooks]: https://docs.gitlab.com/api/group_webhooks/#list-all-group-hooks
[deploy-keys]: https://docs.gitlab.com/api/deploy_keys/#list-deploy-keys-for-project
[project-members]: https://docs.gitlab.com/api/project_members/
[group-members]: https://docs.gitlab.com/api/group_members/
[registry]: https://docs.gitlab.com/api/container_registry/#list-all-registry-repositories
[registry-access]: https://docs.gitlab.com/user/packages/container_registry/#container-registry-visibility-permissions
[packages]: https://docs.gitlab.com/api/packages/#list-packages
[project-wiki]: https://docs.gitlab.com/api/wikis/#list-all-wiki-pages
[group-wiki]: https://docs.gitlab.com/api/group_wikis/#list-wiki-pages
[snippets]: https://docs.gitlab.com/api/project_snippets/#list-all-snippets-for-a-project
[snippet-access]: https://docs.gitlab.com/user/snippets/#snippet-visibility
[push-mirrors]: https://docs.gitlab.com/api/remote_mirrors/#list-all-remote-mirrors-for-a-project
[pull-mirror]: https://docs.gitlab.com/api/project_pull_mirroring/#retrieve-project-pull-mirror-details
[forks]: https://docs.gitlab.com/api/project_forks/#list-all-forks-of-a-project
[approvals]: https://docs.gitlab.com/api/merge_request_approvals/#list-all-approval-rules-for-a-project
[approval-read]: https://gitlab.com/gitlab-org/gitlab/-/work_items/431794
[group-approvals]: https://docs.gitlab.com/api/merge_request_approvals/#approval-rules-for-groups
