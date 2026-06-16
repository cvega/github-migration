/**
 * Consideration registry — the canonical list of source data that the GitHub
 * export does not carry cleanly. The Profile workspace reads this to detect
 * each consideration, classify it, and route it to its remediation
 * (supplemental tooling, a reconfigure step, or a "heads up, this is lost"
 * note).
 *
 * It is plain reference data — edit it whenever the export's coverage changes.
 * The accompanying test (consideration-registry.test.ts) guards its integrity
 * (unique ids, well-formed entries, kind/severity consistency) so edits can't
 * silently corrupt it.
 *
 * Verified against GitHub's "About migrations between GitHub products" and its
 * "Limitations on migrated data" section. Several entries are in public preview
 * upstream, so re-check periodically and bump MIGRATION_DOCS_VERIFIED.
 */

/** Base migration documentation URL; each entry's `docAnchor` appends to this. */
export const MIGRATION_DOC_URL =
  "https://docs.github.com/en/migrations/using-github-enterprise-importer/migrating-between-github-products/about-migrations-between-github-products";

/** Date the registry was last reconciled with the migration docs (YYYY-MM-DD). */
export const MIGRATION_DOCS_VERIFIED = "2026-06-15";

/**
 * Where a consideration's data lives — which determines how the Profiler
 * evaluates and surfaces it:
 * - `repo`      — per repository; detected in the per-repo crawl and shown in the matrix.
 * - `org`       — once per organization (secrets, runners, teams…); shown in the org panel.
 * - `migration` — a whole-migration fact that always applies (mannequins, audit logs…);
 *                 there's nothing to count, so it's listed as an always-present loss.
 */
type ConsiderationScope = "repo" | "org" | "migration";

/**
 * What kind of remediation a consideration needs:
 * - `routable`       — not migrated, but a supplemental tool can move it.
 * - `recreate`       — not migrated and must be re-established by hand (secrets…).
 * - `reconfigure`    — migrates, but arrives disabled/partial; needs a target pass.
 * - `blocker`        — a size/policy limit that can fail the migration outright.
 * - `accepted-loss`  — not migrated and not practically recoverable (informational).
 */
export type ConsiderationKind =
  | "routable"
  | "recreate"
  | "reconfigure"
  | "blocker"
  | "accepted-loss";

/** How loudly to surface a consideration. */
export type ConsiderationSeverity = "info" | "warn" | "blocker";

/** How confident detection is: an exact API signal, or an estimate/proxy. */
type ConsiderationConfidence = "exact" | "estimated";

export interface Consideration {
  /** Stable kebab-case identifier (also the matrix column key). */
  id: string;
  /** Human-readable label for the UI. */
  label: string;
  kind: ConsiderationKind;
  severity: ConsiderationSeverity;
  /**
   * Where the data lives. Defaults to `repo` (the common case) when omitted, so
   * only org- and migration-scoped entries need to state it.
   */
  scope?: ConsiderationScope;
  /**
   * Identifier of the profiler check that detects this consideration. The
   * detection function itself lives server-side and keys off this string.
   */
  detector: string;
  confidence: ConsiderationConfidence;
  /**
   * The supplemental tool / remediation a detected consideration routes to, or
   * null when it is an accepted loss with no practical remediation.
   */
  routesTo: string | null;
  /** One-line, doc-grounded explanation of the consideration. */
  summary: string;
  /** Anchor into MIGRATION_DOC_URL backing this entry. */
  docAnchor: string;
}

const NOT_MIGRATED = "#data-that-is-not-migrated";
const LIMITS = "#limitations-on-migrated-data";
const BRANCH_PROTECTIONS = "#branch-protections";

/**
 * The registry. Ordered roughly by how actionable each consideration is
 * (routable and recreate first, accepted-loss last), not by severity.
 */
export const MIGRATION_CONSIDERATIONS: readonly Consideration[] = [
  // ── Routable: a supplemental tool can carry these over ──────────────────────
  {
    id: "git-lfs",
    label: "Git LFS objects",
    kind: "routable",
    severity: "warn",
    detector: "gitattributes-lfs",
    confidence: "exact",
    routesTo: "Git LFS push (post-migration)",
    summary:
      "Repos using Git LFS migrate, but the LFS objects themselves do not — they must be pushed to the destination afterwards.",
    docAnchor: LIMITS,
  },
  {
    id: "packages",
    label: "GitHub Packages",
    kind: "routable",
    severity: "warn",
    detector: "packages-api",
    confidence: "exact",
    routesTo: "Package migration tooling",
    summary:
      "Packages in GitHub Packages are not migrated and must be moved with separate tooling.",
    docAnchor: NOT_MIGRATED,
  },
  {
    id: "discussions",
    label: "Repository Discussions",
    kind: "routable",
    severity: "warn",
    detector: "graphql-discussions-count",
    confidence: "exact",
    routesTo: "Discussions migration tooling",
    summary: "Discussions at the repository level are not included in the GitHub export.",
    docAnchor: NOT_MIGRATED,
  },
  {
    id: "projects-v2",
    label: "Projects (new experience)",
    kind: "routable",
    severity: "warn",
    detector: "graphql-projects-count",
    confidence: "exact",
    routesTo: "Projects migration tooling",
    summary: "Projects (the new Projects experience) are not migrated.",
    docAnchor: NOT_MIGRATED,
  },

  // ── Recreate: not migrated, must be re-established by hand ───────────────────
  {
    id: "actions-secrets",
    label: "Actions secrets & variables",
    kind: "recreate",
    severity: "warn",
    scope: "org",
    detector: "actions-secrets-count",
    confidence: "exact",
    routesTo: "Re-create secrets/variables on the target",
    summary:
      "GitHub Actions secrets and variables are not migrated; their values are never exported and must be re-entered.",
    docAnchor: NOT_MIGRATED,
  },
  {
    id: "actions-environments",
    label: "Actions environments",
    kind: "recreate",
    severity: "warn",
    detector: "graphql-environments-count",
    confidence: "exact",
    routesTo: "Re-create environments + env secrets",
    summary: "Actions environments (and their environment secrets) are not migrated.",
    docAnchor: NOT_MIGRATED,
  },
  {
    id: "self-hosted-runners",
    label: "Self-hosted runners",
    kind: "recreate",
    severity: "warn",
    scope: "org",
    detector: "actions-runners-count",
    confidence: "exact",
    routesTo: "Re-register runners on the target",
    summary: "Self-hosted and larger runners are not migrated.",
    docAnchor: NOT_MIGRATED,
  },
  {
    id: "dependabot-secrets",
    label: "Dependabot secrets",
    kind: "recreate",
    severity: "warn",
    scope: "org",
    detector: "dependabot-secrets-count",
    confidence: "exact",
    routesTo: "Re-create Dependabot secrets",
    summary: "Dependabot secrets are not migrated.",
    docAnchor: NOT_MIGRATED,
  },
  {
    id: "codespaces-secrets",
    label: "Codespaces secrets",
    kind: "recreate",
    severity: "warn",
    scope: "org",
    detector: "codespaces-secrets-count",
    confidence: "exact",
    routesTo: "Re-create Codespaces secrets",
    summary: "Codespaces secrets are not migrated.",
    docAnchor: NOT_MIGRATED,
  },
  {
    id: "teams",
    label: "Teams & team membership",
    kind: "recreate",
    severity: "warn",
    scope: "org",
    detector: "org-teams-count",
    confidence: "exact",
    routesTo: "Recreate teams and re-add members on the target",
    summary:
      "On a direct repository migration teams are not migrated; even on an organization migration, team membership is not carried over and members must be re-added.",
    docAnchor: NOT_MIGRATED,
  },
  {
    id: "github-apps",
    label: "GitHub Apps & installations",
    kind: "recreate",
    severity: "warn",
    scope: "org",
    detector: "org-app-installations",
    confidence: "exact",
    routesTo: "Reinstall and reconfigure GitHub Apps on the target",
    summary:
      "GitHub Apps and their installations are not migrated; each must be reinstalled and reconfigured on the destination.",
    docAnchor: NOT_MIGRATED,
  },
  {
    id: "repo-collaborators",
    label: "Repository access (collaborators & teams)",
    kind: "recreate",
    severity: "warn",
    detector: "repo-collaborators-count",
    confidence: "exact",
    routesTo: "Re-grant collaborator and team access on the target",
    summary:
      "Direct user access and team access to a repository are not migrated — collaborators and their permissions must be re-granted after migrating.",
    docAnchor: NOT_MIGRATED,
  },

  // ── Reconfigure: migrates but needs a target-side pass ──────────────────────
  {
    id: "webhooks",
    label: "Webhooks",
    kind: "reconfigure",
    severity: "warn",
    detector: "webhooks-count",
    confidence: "exact",
    routesTo: "Re-enable webhooks; re-enter webhook secrets",
    summary:
      "Webhooks migrate but arrive disabled and must be re-enabled; webhook secrets are not migrated.",
    docAnchor: NOT_MIGRATED,
  },
  {
    id: "branch-protection-partial",
    label: "Branch protection (partial rules)",
    kind: "reconfigure",
    severity: "warn",
    detector: "graphql-branch-protection-rules",
    confidence: "exact",
    routesTo: "Re-apply unmigrated protection rules",
    summary:
      "Branch protections migrate, but several rules (bypass actors, require-approval-of-most-recent-push, require-deployments, lock branch, restrict-creating-branches, allow-force-pushes) do not.",
    docAnchor: BRANCH_PROTECTIONS,
  },
  {
    id: "rulesets",
    label: "Rulesets",
    kind: "reconfigure",
    severity: "warn",
    detector: "rulesets-api",
    confidence: "exact",
    routesTo: "Re-create rulesets on the target",
    summary:
      "Rulesets are not migrated, and an org ruleset (e.g. a commit-author email rule) can cause the migration itself to fail.",
    docAnchor: NOT_MIGRATED,
  },
  {
    id: "pages",
    label: "GitHub Pages",
    kind: "reconfigure",
    severity: "info",
    detector: "pages-api",
    confidence: "exact",
    routesTo: "Reconfigure Pages settings",
    summary: "GitHub Pages settings migrate but typically need to be reconfigured on the target.",
    docAnchor: LIMITS,
  },
  {
    id: "wiki-attachments",
    label: "Wiki attachments",
    kind: "reconfigure",
    severity: "info",
    detector: "wiki-enabled-flag",
    confidence: "exact",
    routesTo: "Re-upload wiki attachments",
    summary: "Wikis migrate excluding their attachments.",
    docAnchor: NOT_MIGRATED,
  },
  {
    id: "custom-properties",
    label: "Custom properties",
    kind: "reconfigure",
    severity: "info",
    scope: "org",
    detector: "custom-properties-api",
    confidence: "exact",
    routesTo: "Re-apply custom properties",
    summary: "Repository custom properties are not migrated.",
    docAnchor: NOT_MIGRATED,
  },
  {
    id: "tag-protection",
    label: "Tag protection rules",
    kind: "reconfigure",
    severity: "info",
    detector: "tag-protection-rules",
    confidence: "exact",
    routesTo: "Recreate tag protection (or move it to rulesets)",
    summary:
      "Tag protection rules are not migrated; recreate them on the target — GitHub now recommends expressing them as rulesets.",
    docAnchor: NOT_MIGRATED,
  },

  // ── Blockers: size/policy limits that can fail the migration ────────────────
  {
    id: "release-size-limit",
    label: "Releases over the size limit",
    kind: "blocker",
    severity: "blocker",
    detector: "release-asset-sizes",
    confidence: "estimated",
    routesTo: "Move releases manually (--skip-releases)",
    summary:
      "From GHEC, releases migrate up to 10 GiB per repo; from GHES they are not migrated at all. Oversized release assets are the usual cause of exceeding the metadata limit.",
    docAnchor: LIMITS,
  },
  {
    id: "metadata-archive-limit",
    label: "Metadata archive over limit",
    kind: "blocker",
    severity: "blocker",
    detector: "metadata-size-estimate",
    confidence: "estimated",
    routesTo: "Trim release assets; --skip-releases",
    summary:
      "The Importer cannot migrate repos with more than 40 GiB of metadata (issues, PRs, releases, attachments) — usually driven by binary release assets.",
    docAnchor: LIMITS,
  },
  {
    id: "git-archive-size-limit",
    label: "Git archive over limit",
    kind: "blocker",
    severity: "blocker",
    detector: "disk-usage-estimate",
    confidence: "estimated",
    routesTo: "Reduce repo size (git-sizer)",
    summary:
      "A version-dependent compressed-archive size limit applies to the Git source (2/10/20/40 GiB). diskUsage is only a proxy — confirm with git-sizer.",
    docAnchor: LIMITS,
  },
  {
    id: "commit-size-limit",
    label: "Single commit over 2 GiB",
    kind: "blocker",
    severity: "blocker",
    detector: "git-sizer",
    confidence: "estimated",
    routesTo: "Split the offending commit",
    summary: "No single Git commit can exceed 2 GiB.",
    docAnchor: LIMITS,
  },
  {
    id: "file-size-limit",
    label: "Single file over 400 MiB",
    kind: "blocker",
    severity: "blocker",
    detector: "git-sizer",
    confidence: "estimated",
    routesTo: "Move large files to Git LFS",
    summary: "During migration no single file can exceed 400 MiB (100 MiB afterward).",
    docAnchor: LIMITS,
  },
  {
    id: "git-ref-length-limit",
    label: "Git ref name over 255 bytes",
    kind: "blocker",
    severity: "blocker",
    detector: "refs-scan",
    confidence: "estimated",
    routesTo: "Rename the offending ref",
    summary: "No single Git reference name can exceed 255 bytes.",
    docAnchor: LIMITS,
  },

  // ── Accepted loss: not migrated, not practically recoverable (informational) ─
  {
    id: "actions-run-history",
    label: "Workflow run history & artifacts",
    kind: "accepted-loss",
    severity: "info",
    detector: "actions-workflows-present",
    confidence: "exact",
    routesTo: null,
    summary: "Workflow run history and artifacts are not migrated (workflows themselves are).",
    docAnchor: NOT_MIGRATED,
  },
  {
    id: "code-scanning-history",
    label: "Code scanning & Dependabot alerts",
    kind: "accepted-loss",
    severity: "info",
    detector: "scanning-enabled",
    confidence: "exact",
    routesTo: null,
    summary:
      "Code scanning results, Dependabot alerts, and secret-scanning remediation states are not migrated (scanning can be re-enabled, but history is lost).",
    docAnchor: NOT_MIGRATED,
  },
  {
    id: "stars-watchers",
    label: "Stars & watchers",
    kind: "accepted-loss",
    severity: "info",
    detector: "graphql-stargazers-count",
    confidence: "exact",
    routesTo: null,
    summary: "Repository stars and watchers are not migrated.",
    docAnchor: NOT_MIGRATED,
  },
  {
    id: "fork-relationships",
    label: "Fork relationships",
    kind: "accepted-loss",
    severity: "info",
    detector: "is-fork-flag",
    confidence: "exact",
    routesTo: null,
    summary: "Fork relationships between repositories are not preserved.",
    docAnchor: NOT_MIGRATED,
  },

  // ── Always lost: whole-migration facts that apply to every run ──────────────
  // Nothing to count per repo — these are intrinsic to how the Importer works,
  // so they're surfaced as always-present losses rather than detected signals.
  {
    id: "mannequins",
    label: "User attribution (mannequins)",
    kind: "accepted-loss",
    severity: "info",
    scope: "migration",
    detector: "always",
    confidence: "exact",
    routesTo: null,
    summary:
      "Imported issues, PRs, and comments are attributed to placeholder “mannequin” users until an admin reclaims each one to a real account on the target.",
    docAnchor: LIMITS,
  },
  {
    id: "audit-log",
    label: "Audit logs",
    kind: "accepted-loss",
    severity: "info",
    scope: "migration",
    detector: "always",
    confidence: "exact",
    routesTo: null,
    summary: "Audit log history is not migrated.",
    docAnchor: NOT_MIGRATED,
  },
  {
    id: "commit-status-checks",
    label: "Commit status checks",
    kind: "accepted-loss",
    severity: "info",
    scope: "migration",
    detector: "always",
    confidence: "exact",
    routesTo: null,
    summary:
      "Historical commit status checks — the pass/fail marks CI posts on commits — are not migrated.",
    docAnchor: NOT_MIGRATED,
  },
  {
    id: "comment-edit-history",
    label: "Comment edit history",
    kind: "accepted-loss",
    severity: "info",
    scope: "migration",
    detector: "always",
    confidence: "exact",
    routesTo: null,
    summary:
      "Only the latest version of each issue and pull request comment migrates — prior edit history is not carried over.",
    docAnchor: NOT_MIGRATED,
  },
  {
    id: "sub-issues",
    label: "Sub-issue relationships",
    kind: "accepted-loss",
    severity: "info",
    scope: "migration",
    detector: "always",
    confidence: "exact",
    routesTo: null,
    summary: "Parent/child sub-issue relationships are not preserved by the migration.",
    docAnchor: NOT_MIGRATED,
  },
  {
    id: "cross-repo-references",
    label: "Cross-repository references",
    kind: "accepted-loss",
    severity: "info",
    scope: "migration",
    detector: "always",
    confidence: "exact",
    routesTo: null,
    summary:
      "Autolinked references between pull requests and issues in different repositories are not migrated and will not resolve.",
    docAnchor: NOT_MIGRATED,
  },
  {
    id: "mention-relinking",
    label: "@mention re-linking",
    kind: "accepted-loss",
    severity: "info",
    scope: "migration",
    detector: "always",
    confidence: "exact",
    routesTo: null,
    summary:
      "Mentions of users, teams, and organizations keep their original text but are not re-linked to accounts on the target.",
    docAnchor: NOT_MIGRATED,
  },
  {
    id: "secret-scanning-states",
    label: "Secret-scanning remediation states",
    kind: "accepted-loss",
    severity: "info",
    scope: "migration",
    detector: "always",
    confidence: "exact",
    routesTo: null,
    summary:
      "Remediation states of secret-scanning results (resolved, false-positive, …) are not migrated.",
    docAnchor: NOT_MIGRATED,
  },
  {
    id: "activity-feed",
    label: "Repository activity feed",
    kind: "accepted-loss",
    severity: "info",
    scope: "migration",
    detector: "always",
    confidence: "exact",
    routesTo: null,
    summary: "The repository activity feed is not migrated.",
    docAnchor: NOT_MIGRATED,
  },
];
