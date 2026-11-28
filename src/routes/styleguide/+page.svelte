<script lang="ts">
	import AuthFields from "$lib/components/AuthFields.svelte";
	import AuthStatus from "$lib/components/AuthStatus.svelte";
	import ConfirmDialog from "$lib/components/ConfirmDialog.svelte";
	import ErrorDetail from "$lib/components/ErrorDetail.svelte";
	import GitHubStatus from "$lib/components/GitHubStatus.svelte";
	import MigrationCard from "$lib/components/migrate/MigrationCard.svelte";
	import MigrationProgress from "$lib/components/migrate/MigrationProgress.svelte";
	import Octicon from "$lib/components/Octicon.svelte";
	import OrgSelect from "$lib/components/OrgSelect.svelte";
	import Pagination from "$lib/components/Pagination.svelte";
	import ProfileList from "$lib/components/profile/ProfileList.svelte";
	import ProfileProgress from "$lib/components/profile/ProfileProgress.svelte";
	import SourceInventory from "$lib/components/profile/SourceInventory.svelte";
	import SourceProviderSelector from "$lib/components/SourceProviderSelector.svelte";
	import { ICONS, type UsedIconName } from "$lib/icons.generated";
	import type { AuthFieldMode, Counts, FailureDetail, Migration, Progress } from "$lib/migrate/types";
	import type { ProfileDetailRollup, ProfileInventorySummary, ProfileRun } from "$lib/profile/types";
	import type { SourceProvider } from "$lib/source-provider";
	import type { GitHubStatus as GitHubStatusValue } from "$lib/status";

	type PreviewStage = "path" | "configure" | "review";
	type RunMode = "dry-run" | "production";

	const workflowSteps = [
		"Path",
		"Repositories",
		"Source access",
		"Destination",
		"Options",
		"Review",
	] as const;
	const stageStep: Record<PreviewStage, number> = { path: 0, configure: 1, review: 5 };
	const colorGroups = [
		{
			name: "Neutral foundation",
			description: "Inset, canvas, surface, and controls form a deliberate depth sequence.",
			tokens: [
				{ name: "Inset", token: "--workbench-canvas-inset" },
				{ name: "Canvas", token: "--workbench-canvas" },
				{ name: "Surface", token: "--workbench-surface" },
				{ name: "Control", token: "--workbench-control-surface" },
				{ name: "Hover", token: "--workbench-control-hover" },
				{ name: "Active", token: "--workbench-control-active" },
				{ name: "Muted rule", token: "--workbench-rule-muted" },
				{ name: "Rule", token: "--workbench-rule" },
				{ name: "Strong rule", token: "--workbench-rule-strong" },
			],
		},
		{
			name: "Accent / path",
			description: "Navigation, selection, focus, and migration direction.",
			tokens: [
				{ name: "Foreground", token: "--workbench-path" },
				{ name: "Muted", token: "--workbench-path-muted" },
				{ name: "Border", token: "--workbench-path-border" },
				{ name: "Emphasis", token: "--workbench-path-emphasis" },
			],
		},
		{
			name: "Success / executable",
			description: "Completed checks and safe executable actions.",
			tokens: [
				{ name: "Foreground", token: "--workbench-ready" },
				{ name: "Muted", token: "--workbench-ready-muted" },
				{ name: "Border", token: "--workbench-ready-border" },
				{ name: "Emphasis", token: "--workbench-ready-emphasis" },
			],
		},
		{
			name: "Attention / production",
			description: "Warnings and production consequences requiring deliberate review.",
			tokens: [
				{ name: "Foreground", token: "--workbench-production" },
				{ name: "Muted", token: "--workbench-production-muted" },
				{ name: "Border", token: "--workbench-production-border" },
				{ name: "Emphasis", token: "--workbench-production-emphasis" },
			],
		},
		{
			name: "Danger / failure",
			description: "Validation failures, failed work, and destructive actions.",
			tokens: [
				{ name: "Foreground", token: "--workbench-danger" },
				{ name: "Muted", token: "--workbench-danger-muted" },
				{ name: "Border", token: "--workbench-danger-border" },
				{ name: "Emphasis", token: "--workbench-danger-emphasis" },
			],
		},
	] as const;
	const sourceOptions = [
		{ id: "github", label: "GitHub", detail: "Organizations", icon: "mark-github" },
		{ id: "gitlab", label: "GitLab", detail: "Namespaces", icon: "gitlab-logo" },
		{
			id: "bitbucket",
			label: "Bitbucket Server",
			detail: "Projects",
			icon: "bitbucket-logo",
		},
	] as const;
	const componentGroups = [
		{ name: "Foundation", components: ["Octicon"] },
		{ name: "Shell & navigation", components: ["AppHeader", "NotificationBell", "Pagination"] },
		{
			name: "Inputs & authentication",
			components: ["AuthFields", "AuthStatus", "OrgSelect", "SourceProviderSelector"],
		},
		{ name: "Feedback", components: ["ConfirmDialog", "ErrorDetail", "GitHubStatus"] },
		{ name: "Migration", components: ["MigrationCard", "MigrationForm", "MigrationProgress"] },
		{
			name: "Profiling",
			components: ["ProfileForm", "ProfileList", "ProfileProgress", "SourceInventory"],
		},
	] as const;
	const componentCount = componentGroups.reduce(
		(total, group) => total + group.components.length,
		0,
	);
	const liveComponentCount = 14;
	const catalogOrganizations = ["octo-org", "octo-platform", "octo-services"];
	const healthyGitHubStatus: GitHubStatusValue = { ok: true, incidentCount: 0, incidents: [] };
	const incidentGitHubStatus: GitHubStatusValue = {
		ok: false,
		incidentCount: 1,
		incidents: [
			{
				name: "Git Operations degradation",
				status: "investigating",
				url: "https://www.githubstatus.com",
			},
		],
	};
	const catalogSourceCounts: Counts = {
		commits: 12480,
		branches: 42,
		tags: 118,
		issues: 860,
		pullRequests: 314,
		releases: 27,
	};
	const catalogProgress: Progress = {
		current: {
			timestamp: "2026-08-29T12:00:00.000Z",
			migrationState: "running",
			failureReason: "",
			migrationLogUrl: "",
			warningsCount: 0,
			repoExists: true,
			countsAuthoritative: true,
			repoSize: 483200,
			commits: 9340,
			branches: 42,
			tags: 118,
			issues: 0,
			pullRequests: 0,
			releases: 0,
			phase: "IMPORTING_GIT",
			elapsed: 428,
		},
		previous: null,
		deltaCommits: 620,
		deltaBranches: 0,
		deltaTags: 0,
		deltaIssues: 0,
		deltaPRs: 0,
		deltaReleases: 0,
		deltaSize: 24100,
		commitsPerMin: 186,
		issuesPerMin: 0,
	};
	const catalogRunningMigration: Migration = {
		id: "migration-running",
		batchId: "batch-platform",
		githubMigrationId: "GE-4821",
		sourceProvider: "gitlab",
		sourceApiUrl: "https://gitlab.example.com/api/v4",
		targetProfileId: "target-production",
		targetPlatform: "ghec",
		targetApiUrl: "https://api.github.com",
		sourceOrg: "platform",
		sourceRepo: "payments-api",
		targetOrg: "octo-platform",
		targetRepo: "payments-api",
		state: "running",
		failureReason: null,
		migrationLogUrl: null,
		warningsCount: 2,
		sourceCounts: catalogSourceCounts,
		targetCounts: null,
		sourceSizeKb: 483200,
		startedAt: "2026-08-29T11:52:52.000Z",
		completedAt: null,
		elapsedSeconds: 428,
		authMode: "env-app",
		requestOptions: null,
	};
	const catalogFailedMigration: Migration = {
		...catalogRunningMigration,
		id: "migration-failed",
		batchId: null,
		sourceProvider: "bitbucket-server",
		sourceApiUrl: "https://bitbucket.example.com",
		sourceOrg: "commerce",
		sourceRepo: "ledger-service",
		targetOrg: "octo-commerce",
		targetRepo: "ledger-service",
		state: "failed",
		failureReason: "Archive exceeded the configured import limit during metadata transfer.",
		warningsCount: 0,
		completedAt: "2026-08-29T11:46:10.000Z",
		elapsedSeconds: 786,
	};
	const catalogFailureDetail: FailureDetail = {
		migrationId: catalogFailedMigration.id,
		state: "failed",
		failureReason: catalogFailedMigration.failureReason ?? "Migration failed",
		elapsed: catalogFailedMigration.elapsedSeconds ?? 0,
		logUrl: "https://github.example.com/migrations/GE-4821",
		logEntries: [
			{ severity: "ERROR", modelName: "Repository", message: "Metadata archive exceeded 40 GiB." },
			{ severity: "ERROR", modelName: "Release", message: "Release assets could not be imported." },
			{ severity: "WARNING", modelName: "Webhook", message: "Webhook secrets require rotation." },
		],
	};
	const catalogProfileRun: ProfileRun = {
		id: "profile-running",
		sourceProvider: "github",
		sourceApiUrl: "https://api.github.com",
		org: "octo-platform",
		state: "running",
		totalRepos: 148,
		profiledRepos: 104,
		blockers: 8,
		warnings: 31,
		orgRulesetCount: 6,
		orgResources: { actionsSecrets: 24, actionsVariables: 18, dependabotSecrets: 9, codespacesSecrets: 3, selfHostedRunners: 12, customProperties: 7, teams: 42, appInstallations: 16 },
		apiCalls: 1240,
		startedAt: "2026-08-29T11:42:00.000Z",
		completedAt: null,
		failureReason: null,
	};
	const catalogComposition: ProfileDetailRollup["composition"] = {
		total: 148,
		active: { count: 104, pct: 70 },
		stale: { count: 22, pct: 15 },
		empty: { count: 8, pct: 5 },
		archived: { count: 14, pct: 10 },
	};
	const exactObservation = (value: number) => ({ kind: "exact" as const, value });
	const catalogInventory: ProfileInventorySummary = {
		projectCount: exactObservation(148),
		projectsCaptured: 148,
		visibility: { private: 102, internal: 31, public: 15 },
		archivedProjects: 14,
		projectsWithoutDefaultBranch: 8,
		storage: {
			repositorySizeBytes: exactObservation(386547056640),
			storageSizeBytes: exactObservation(472446402560),
			lfsObjectsSizeBytes: exactObservation(62277025792),
			packagesSizeBytes: exactObservation(12884901888),
			wikiSizeBytes: exactObservation(2147483648),
			uploadsSizeBytes: { kind: "unavailable", reason: "not-reported" },
			jobArtifactsSizeBytes: { kind: "unavailable", reason: "not-reported" },
			pipelineArtifactsSizeBytes: { kind: "unavailable", reason: "not-reported" },
			snippetsSizeBytes: { kind: "unavailable", reason: "not-reported" },
			containerRegistrySizeBytes: { kind: "unavailable", reason: "not-reported" },
		},
		metrics: { commits: exactObservation(184290), pullRequests: exactObservation(4820), branches: exactObservation(936), tags: exactObservation(1284), releases: exactObservation(412), issues: exactObservation(7290) },
	};
	const catalogProfileRuns = [
		{ id: "profile-running", sourceProvider: "github" as const, org: "octo-platform", state: "running" as const, totalRepos: 148, profiledRepos: 104, blockers: 8, warnings: 31, startedAt: "2026-08-29T11:42:00.000Z", inventoryProjectCount: null },
		{ id: "profile-complete", sourceProvider: "gitlab" as const, org: "commerce-platform", state: "completed" as const, totalRepos: 76, profiledRepos: 76, blockers: 0, warnings: 12, startedAt: "2026-08-28T14:20:00.000Z", inventoryProjectCount: exactObservation(76) },
	];
	const iconRoleGroups = [
		{
			name: "Movement",
			detail: "Transfer direction and execution",
			icons: ["repo-push", "arrow-switch", "sync", "rocket"],
		},
		{
			name: "Status",
			detail: "Ready, waiting, attention, and failure",
			icons: ["check-circle-fill", "clock", "alert", "x-circle-fill"],
		},
		{
			name: "Resources",
			detail: "Repositories, owners, data, and batches",
			icons: ["repo", "organization", "database", "stack"],
		},
		{
			name: "Actions",
			detail: "Find, configure, copy, and export",
			icons: ["search", "gear", "copy", "download"],
		},
	] as const;
	const providerBrandIcons = [
		{ name: "mark-github", label: "GitHub", source: "Octicons" },
		{ name: "gitlab-logo", label: "GitLab", source: "Simple Icons" },
		{ name: "bitbucket-logo", label: "Bitbucket", source: "Simple Icons" },
	] as const;
	const shippedOcticons = Object.keys(ICONS) as UsedIconName[];

	let activeStage = $state<PreviewStage>("path");
	let compactPreview = $state(false);
	let selectedSource = $state<(typeof sourceOptions)[number]["id"]>("github");
	let runMode = $state<RunMode>("dry-run");
	let catalogProvider = $state<SourceProvider>("github");
	let catalogOrg = $state("octo-org");
	let catalogLockedOrg = $state("octo-platform");
	let catalogPage = $state(4);
	let catalogAuthMode = $state<AuthFieldMode>("pat");
	let catalogToken = $state("ghp_example_token");
	let catalogAppId = $state("");
	let catalogInstallationId = $state("");
	let catalogAppKey = $state("");
	let confirmDialogOpen = $state(false);

	const currentStep = $derived(stageStep[activeStage]);
	const primaryAction = $derived(
		activeStage === "review"
			? runMode === "production"
				? "Start production migration"
				: "Start dry run"
			: "Continue",
	);

</script>

<svelte:head>
	<title>Migration Workbench Style Guide</title>
	<meta
		name="description"
		content="Live component and composition reference for the Migration Workbench design system."
	/>
</svelte:head>

<div class="styleguide-page">
	<header class="guide-masthead">
		<div>
			<p class="guide-kicker">Design system / Reference 01</p>
			<h1>Migration Workbench</h1>
			<p class="guide-intro">
				A directed operational interface for planning, validating, and launching repository
				migrations.
			</p>
		</div>
		<nav class="guide-overview" aria-label="Reference overview">
			<div class="overview-heading">
				<span>Reference index</span>
				<span class="overview-status"><i></i> Current</span>
			</div>
			<a href="#components">
				<span class="overview-count">{componentCount}</span>
				<span><strong>Svelte components</strong><small>{liveComponentCount} live specimens</small></span>
				<Octicon name="arrow-right" size={16} />
			</a>
			<a href="#composition">
				<span class="overview-count">06</span>
				<span><strong>Workflow stages</strong><small>Responsive reference</small></span>
				<Octicon name="arrow-right" size={16} />
			</a>
			<a href="#typography">
				<span class="overview-count">05</span>
				<span><strong>Typography roles</strong><small>Mona Sans + Mona Sans Mono</small></span>
				<Octicon name="arrow-right" size={16} />
			</a>
			<a href="#iconography">
				<span class="overview-count">{shippedOcticons.length}</span>
				<span><strong>Shipped Octicons</strong><small>Semantic roles, sizes, and brands</small></span>
				<Octicon name="arrow-right" size={16} />
			</a>
			<a href="#foundations">
				<span class="overview-count">25</span>
				<span><strong>Color roles</strong><small>Primer semantics and geometry</small></span>
				<Octicon name="arrow-right" size={16} />
			</a>
		</nav>
	</header>

	{@render componentAtlas()}
	{@render referenceComposition()}
	{@render foundationsReference()}

	{#snippet foundationsReference()}
	<section id="foundations" class="guide-section">
		<header class="section-heading">
			<h2>Foundations</h2>
			<p>Primer semantics, constrained into a product-specific surface and type system.</p>
		</header>

		<div class="foundation-block">
			<div class="block-heading">
				<h3>Color roles</h3>
				<p>Official Primer functional roles, organized around migration decisions and state.</p>
			</div>
			<div class="palette-groups">
				{#each colorGroups as group (group.name)}
					<div class="palette-group">
						<div class="palette-heading"><h4>{group.name}</h4><p>{group.description}</p></div>
						<div class="swatch-grid">
							{#each group.tokens as color (color.token)}
								<div class="swatch">
									<span class="swatch-color" style:background-color={`var(${color.token})`}></span>
									<span class="swatch-name">{color.name}</span>
									<code>{color.token}</code>
								</div>
							{/each}
						</div>
					</div>
				{/each}
			</div>
		</div>

		<div id="typography" class="foundation-block typography-block">
			<div class="block-heading">
				<h3>Interface typography</h3>
				<p>Mona Sans carries decisions; Mona Sans Mono carries repository identity and machine values.</p>
			</div>
			<div class="typography-reference">
				<div class="type-composition">
					<div class="type-context"><span>New migration</span><span>Step 2 of 6</span></div>
					<p class="type-display">Configure repositories</p>
					<p class="type-lede">Choose the source repository, then confirm the target identity before validation.</p>
					<div class="type-route"><code>platform/payments-api</code><Octicon name="arrow-right" size={16} /><code>octo-platform/payments-api</code></div>
					<p class="type-status"><i></i> Configuration is valid</p>
				</div>
				<dl class="type-ledger">
					<div><dt>Page</dt><dd>32 / 40 / 600</dd><small>Route and task titles</small></div>
					<div><dt>Stage</dt><dd>20 / 28 / 600</dd><small>Current decision</small></div>
					<div><dt>Body</dt><dd>15 / 22 / 400</dd><small>Instruction and context</small></div>
					<div><dt>Meta</dt><dd>13 / 18 / 500</dd><small>Status and counts</small></div>
					<div><dt>Machine</dt><dd>14 / 20 / mono</dd><small>Repositories and tokens</small></div>
				</dl>
			</div>
		</div>

		<div class="foundation-block geometry-block">
			<div class="block-heading"><h3>Geometry</h3><p>Compact controls inside spacious compositions.</p></div>
			<dl class="geometry-list">
				<div><dt>Standard control</dt><dd>40px</dd></div>
				<div><dt>Mobile control</dt><dd>44px</dd></div>
				<div><dt>Endpoint option</dt><dd>72px</dd></div>
				<div><dt>Transfer lane</dt><dd>64px</dd></div>
				<div><dt>Workbench radius</dt><dd>6px</dd></div>
				<div><dt>Form measure</dt><dd>720px</dd></div>
			</dl>
		</div>
	</section>
	{/snippet}

	{#snippet componentAtlas()}
	<section id="components" class="guide-section">
		<header class="atlas-heading">
			<div>
				<p class="guide-kicker">Component atlas / Production surface</p>
				<h2>Fourteen components, doing the real work</h2>
				<p>Live product states, bound inputs, operational feedback, and migration intelligence.</p>
			</div>
			<div class="atlas-tally"><strong>{liveComponentCount}</strong><span>live of<br />{componentCount} shared</span></div>
		</header>

		<div class="showcase-groups">
			<section class="showcase-group">
				<header class="showcase-group-heading"><span>01</span><div><h3>Migration operations</h3><p>Queue state, transfer progress, and failure recovery.</p></div><code>MigrationCard · MigrationProgress · ErrorDetail</code></header>
				<div class="showcase-grid">
					<article class="showcase-module wide unframed">
						<div class="showcase-caption"><span>Live queue</span><h4>MigrationCard</h4><p>Running and failed states preserve route, phase, timing, and intervention context.</p></div>
						<div class="migration-card-stack">
							<MigrationCard migration={catalogRunningMigration} live={{ snapshot: catalogProgress.current, sourceCounts: catalogSourceCounts }} now={new Date("2026-08-29T12:00:00.000Z").getTime()} />
							<MigrationCard migration={catalogFailedMigration} />
						</div>
					</article>
					<article class="showcase-module wide unframed">
						<div class="showcase-caption"><span>Transfer telemetry</span><h4>MigrationProgress</h4><p>The production phase rail and authoritative source-to-target counts.</p></div>
						<MigrationProgress currentPhase="IMPORTING_GIT" active progress={catalogProgress} source={catalogSourceCounts} showComparison={false} />
					</article>
					<article class="showcase-module wide unframed">
						<div class="showcase-caption"><span>Failure recovery</span><h4>ErrorDetail</h4><p>A shareable operator report with grouped errors, warnings, elapsed time, and source logs.</p></div>
						<ErrorDetail detail={catalogFailureDetail} migration={catalogFailedMigration} />
					</article>
				</div>
			</section>

			<section class="showcase-group">
				<header class="showcase-group-heading"><span>02</span><div><h3>Source intelligence</h3><p>Discovery progress, composition, inventory, and profiling history.</p></div><code>ProfileProgress · SourceInventory · ProfileList</code></header>
				<div class="showcase-grid">
					<article class="showcase-module wide unframed"><div class="showcase-caption"><span>Discovery in motion</span><h4>ProfileProgress</h4></div><ProfileProgress run={catalogProfileRun} composition={catalogComposition} livePhase="details" /></article>
					<article class="showcase-module wide unframed"><div class="showcase-caption"><span>Source evidence</span><h4>SourceInventory</h4><p>Counts retain certainty, scale, coverage gaps, and storage limitations.</p></div><SourceInventory providerName="GitHub" running={false} progress={null} summary={catalogInventory} /></article>
					<article class="showcase-module wide unframed"><div class="showcase-caption"><span>Run history</span><h4>ProfileList</h4></div><ProfileList runs={catalogProfileRuns} totalRuns={catalogProfileRuns.length} /></article>
				</div>
			</section>

			<section class="showcase-group">
				<header class="showcase-group-heading"><span>03</span><div><h3>Identity and access</h3><p>Provider selection, organization scope, and explicit credential ownership.</p></div><code>SourceProviderSelector · OrgSelect · AuthFields</code></header>
				<div class="showcase-grid">
					<article class="showcase-module seven provider-showcase">
						<div class="showcase-caption"><span>Migration source</span><h4>SourceProviderSelector</h4></div>
					<SourceProviderSelector
						bind:value={catalogProvider}
						onselect={(provider) => (catalogProvider = provider)}
						purpose="migration"
						accent="blue"
						availability={{ github: true, gitlab: true, "bitbucket-server": false }}
						name="catalog-source-provider"
					/>
					<p class="specimen-state">Selected value <code>{catalogProvider}</code></p>
					</article>
					<article class="showcase-module five"><div class="showcase-caption"><span>Organization scope</span><h4>OrgSelect</h4></div><div class="org-showcase"><label for="catalog-org">Suggested organization</label><OrgSelect id="catalog-org" bind:value={catalogOrg} options={catalogOrganizations} placeholder="owner-name" /><label for="catalog-locked-org">Managed organization</label><OrgSelect id="catalog-locked-org" bind:value={catalogLockedOrg} options={catalogOrganizations} locked /></div></article>
					<article class="showcase-module wide"><div class="showcase-caption"><span>Credential ownership</span><h4>AuthFields</h4><p>Switch between request-scoped PAT and GitHub App authentication without leaving the form.</p></div><div class="auth-fields-showcase"><AuthFields title="Target credentials" icon="key" envApp={false} envPat={false} required bind:mode={catalogAuthMode} bind:token={catalogToken} bind:appId={catalogAppId} bind:installationId={catalogInstallationId} bind:appKey={catalogAppKey} /></div></article>
				</div>
			</section>

			<section class="showcase-group">
				<header class="showcase-group-heading"><span>04</span><div><h3>Status and consequence</h3><p>Service health, credential pressure, and guarded destructive action.</p></div><code>GitHubStatus · AuthStatus · ConfirmDialog</code></header>
				<div class="showcase-grid">
					<article class="showcase-module seven"><div class="showcase-caption"><span>Operational state</span><h4>GitHubStatus + AuthStatus</h4></div><div class="status-showcase"><div><span>Healthy</span><GitHubStatus status={healthyGitHubStatus} /></div><div><span>Incident</span><GitHubStatus status={incidentGitHubStatus} /></div><div><span>Server App</span><AuthStatus label="Source" isApp rateText="4,700" ratePct={94} /></div><div><span>Active PAT</span><AuthStatus label="Target" rateText="840" ratePct={17} migrating /></div></div></article>
					<article class="showcase-module five consequence-showcase"><div class="showcase-caption"><span>Guarded action</span><h4>ConfirmDialog</h4><p>Typed confirmation makes destructive consequence explicit.</p></div><button class="button danger-trigger" type="button" onclick={() => (confirmDialogOpen = true)}><Octicon name="x-circle" size={16} /> Open destructive confirmation</button></article>
				</div>
			</section>

			<section class="showcase-group">
				<header class="showcase-group-heading"><span>05</span><div><h3>Navigation and primitives</h3><p>Dataset movement and the semantic icon vocabulary behind every control.</p></div><code>Pagination · Octicon</code></header>
				<div class="showcase-grid">
					<article class="showcase-module seven pagination-stage"><div class="showcase-caption"><span>Large result sets</span><h4>Pagination</h4></div>
					<Pagination page={catalogPage} totalPages={12} total={286} limit={25} onPageChange={(page) => (catalogPage = page)} />
					</article>
					<article id="iconography" class="showcase-module wide icon-module" data-icon-count={shippedOcticons.length}>
						<div class="showcase-caption"><span>Semantic vocabulary</span><h4>Octicons in the workbench</h4><p>Application icons inherit interface color and describe a task or state. Provider marks retain their source identity.</p></div>
						<div class="icon-reference">
							<section aria-labelledby="icon-role-title">
								<h5 id="icon-role-title">Applied roles</h5>
								<div class="icon-role-grid">
									{#each iconRoleGroups as group (group.name)}
										<div class="icon-role">
											<div class="icon-role-symbols">{#each group.icons as icon (icon)}<span title={icon}><Octicon name={icon} size={16} /></span>{/each}</div>
											<strong>{group.name}</strong>
											<p>{group.detail}</p>
										</div>
									{/each}
								</div>
							</section>
							<aside class="icon-standards" aria-label="Icon standards">
								<div>
									<h5>Optical sizes</h5>
									<div class="icon-size-scale"><span><Octicon name="repo-push" size={12} /><code>12</code></span><span><Octicon name="repo-push" size={16} /><code>16</code></span><span><Octicon name="repo-push" size={24} /><code>24</code></span></div>
									<p>Metadata, controls, and section emphasis.</p>
								</div>
								<div>
									<h5>Provider marks</h5>
									<div class="provider-icon-list">{#each providerBrandIcons as icon (icon.name)}<span><Octicon name={icon.name} size={24} /><span><strong>{icon.label}</strong><small>{icon.source}</small></span></span>{/each}</div>
								</div>
							</aside>
						</div>
						<details class="icon-inventory">
							<summary><span><strong>Complete shipped Octicon set</strong><small>Generated from icon names used in application source</small></span><code>{shippedOcticons.length} icons</code></summary>
							<div class="icon-inventory-grid">{#each shippedOcticons as icon (icon)}<div><Octicon name={icon} size={16} /><code>{icon}</code></div>{/each}</div>
						</details>
					</article>
				</div>
			</section>
		</div>

		<details class="component-registry">
			<summary><div><strong id="component-registry-title">Complete shared inventory</strong><span>{componentCount} components</span></div><span>View source map</span></summary>
			<div class="registry-groups">{#each componentGroups as group (group.name)}<div><h3>{group.name}</h3><ul>{#each group.components as component (component)}<li><code>{component}.svelte</code></li>{/each}</ul></div>{/each}</div>
		</details>
	</section>
	{/snippet}

	{#snippet confirmDialogBody()}
		<p class="text-sm text-gray-300">This removes the migration record and its local event history. The target repository is not deleted.</p>
	{/snippet}

	<ConfirmDialog bind:open={confirmDialogOpen} title="Delete migration record" confirmPhrase="delete migration" submitLabel="Delete record" submitting={false} error="" onConfirm={() => (confirmDialogOpen = false)} body={confirmDialogBody} />

	{#snippet referenceComposition()}
	<section id="composition" class="guide-section composition-section">
		<header class="section-heading">
			<h2>Reference composition</h2>
			<p>The complete `/migrate/new` workflow is the primary expression of Migration Workbench.</p>
		</header>

		<ol class="composition-anatomy" aria-label="Composition anatomy">
			<li><span>01</span><strong>Route</strong><small>Source and destination remain visible.</small></li>
			<li><span>02</span><strong>Workbench</strong><small>One decision surface owns the stage.</small></li>
			<li><span>03</span><strong>Action dock</strong><small>Consequence stays fixed and explicit.</small></li>
		</ol>

		<div class="preview-controls">
			<div class="segmented" role="tablist" aria-label="Workflow stage">
				{#each ["path", "configure", "review"] as stage (stage)}
					<button
						type="button"
						role="tab"
						aria-selected={activeStage === stage}
						onclick={() => (activeStage = stage as PreviewStage)}
					>{stage === "path" ? "Path" : stage === "configure" ? "Configure" : "Review"}</button>
				{/each}
			</div>
			<fieldset class="segmented">
				<legend class="sr-only">Preview viewport</legend>
				<button type="button" aria-pressed={!compactPreview} onclick={() => (compactPreview = false)}>Desktop</button>
				<button type="button" aria-pressed={compactPreview} onclick={() => (compactPreview = true)}>Mobile</button>
			</fieldset>
		</div>

		<div class="preview-stage">
			<div class:compact={compactPreview} class="workflow-preview">
				<div class="preview-appbar">
					<span><Octicon name="mark-github" size={16} /> Migration Toolkit</span>
					<span class="preview-capacity"><i></i> 0 of 10 active</span>
				</div>
				<div class="preview-content">
					<header class="preview-masthead">
						<div><h3>New migration</h3><p>Move repositories between configured platforms.</p></div>
						<span>Migration capacity available</span>
					</header>

					<ol class="workflow-rail" aria-label="Migration progress">
						{#each workflowSteps as step, index (step)}
							<li
								class:complete={index < currentStep}
								class:current={index === currentStep}
								data-progress={`${index + 1} of ${workflowSteps.length}`}
							>
								<span class="step-node">{index < currentStep ? "✓" : index + 1}</span>
								<span class="step-label">{step}</span>
								<span class="compact-progress">{index + 1} of {workflowSteps.length}</span>
							</li>
						{/each}
					</ol>

					<section class="workbench">
						<header class="workbench-head">
							<div>
								<h4>{activeStage === "path" ? "Choose a migration path" : activeStage === "configure" ? "Configure repositories" : "Review and launch"}</h4>
								<p>{activeStage === "path" ? "Select the source platform and destination profile." : activeStage === "configure" ? "Choose one repository or prepare a normalized batch list." : "Confirm the route, destination, and execution mode."}</p>
							</div>
							<span>{activeStage === "review" ? "1 repository" : `${currentStep + 1} of 6`}</span>
						</header>

						<div class="workbench-body">
							{#if activeStage === "path"}
								<div class="route-choice">
									<div>
										<p class="structural-label">Source</p>
										<div class="endpoint-list compact-options">
											{#each sourceOptions as option (option.id)}
												<button type="button" class:selected={selectedSource === option.id} onclick={() => (selectedSource = option.id)}>
													<span class="provider-mark"><Octicon name={option.icon} size={16} /></span>
													<span class="provider-copy"><strong>{option.label}</strong><small>{option.detail}</small></span>
													{#if selectedSource === option.id}<span class="selected-check"><Octicon name="check" size={12} /></span>{/if}
												</button>
											{/each}
										</div>
									</div>
									<div class="transfer"><span></span><Octicon name="arrow-right" size={16} /></div>
									<div>
										<p class="structural-label">Destination</p>
										<div class="endpoint-list compact-options">
											<button type="button" class="selected">
												<span class="provider-mark"><Octicon name="mark-github" size={16} /></span>
												<span class="provider-copy"><strong>GitHub Enterprise Cloud</strong><small>Default profile</small></span>
												<span class="selected-check"><Octicon name="check" size={12} /></span>
											</button>
										</div>
									</div>
								</div>
							{:else if activeStage === "configure"}
								<div class="configure-layout">
									<div class="preview-form">
										<div class="segmented"><button type="button" aria-pressed="true">Single repository</button><button type="button" aria-pressed="false">Batch</button></div>
										<label><span>Source organization</span><input value="octo-org" readonly /><small>Organization containing the repository to migrate.</small></label>
										<label><span>Repository</span><input value="payments-service" readonly /></label>
									</div>
									<aside class="route-context">
										<p class="structural-label">Route</p>
										<strong>{sourceOptions.find((option) => option.id === selectedSource)?.label} <Octicon name="arrow-right" size={12} /> GHEC</strong>
										<p class="structural-label context-label">Source access</p>
										<span class="context-status"><i></i> Administrator managed</span>
									</aside>
								</div>
							{:else}
								<div class="review-route">
									<span><b class="provider-mark"><Octicon name="gitlab-logo" size={16} /></b><strong>GitLab<small>test-group</small></strong></span>
									<div><i></i><Octicon name="arrow-right" size={16} /></div>
									<span><b class="provider-mark"><Octicon name="mark-github" size={16} /></b><strong>GitHub Enterprise Cloud<small>test-target-org</small></strong></span>
								</div>
								<div class="mapping">
									<p class="structural-label">Repository mappings</p>
									<div class="mapping-head"><span>Source repository</span><span></span><span>Target repository</span></div>
									<div class="mapping-row"><code>test-group/payments-service</code><Octicon name="arrow-right" size={16} /><code>test-target-org/payments-service</code></div>
								</div>
								<div class="launch-grid">
									<div><p class="structural-label">Run mode</p><div class="run-modes"><button type="button" class:selected={runMode === "dry-run"} onclick={() => (runMode = "dry-run")}><span></span> Dry run</button><button type="button" class:selected={runMode === "production"} class:production={runMode === "production"} onclick={() => (runMode = "production")}><span></span> Production</button></div></div>
									<div><p class="structural-label">Capacity</p><strong class="capacity-ready"><i></i> Available now</strong><small>10 migration slots are open.</small></div>
								</div>
							{/if}
						</div>

						<footer class="action-dock">
							<span>{activeStage === "review" ? "Ready to launch" : "Configuration is valid"}</span>
							<div><button class="button secondary" type="button">{activeStage === "path" ? "Cancel" : "Back"}</button><button class:ready={activeStage === "review" && runMode === "dry-run"} class:production={activeStage === "review" && runMode === "production"} class="button primary" type="button">{primaryAction}{#if activeStage !== "review"} <Octicon name="arrow-right" size={16} />{/if}</button></div>
						</footer>
					</section>
				</div>
			</div>
		</div>
	</section>
	{/snippet}
</div>

<style>
	:global(html) {
		scroll-behavior: smooth;
	}

	.styleguide-page {
		--guide-rule: var(--workbench-rule);
		--guide-muted: var(--fgColor-muted);
		max-width: var(--workbench-content-width);
		margin: 0 auto;
	}

	.guide-masthead {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 320px;
		align-items: flex-start;
		gap: clamp(48px, 8vw, 112px);
		padding: 28px 0 40px;
	}

	.guide-kicker,
	.structural-label {
		margin: 0;
		color: var(--workbench-path);
		font-size: 13px;
		font-weight: 600;
		line-height: 18px;
		text-transform: uppercase;
	}

	.guide-masthead h1 {
		margin: 8px 0 0;
		color: var(--fgColor-default);
		font-size: 40px;
		font-weight: 600;
		line-height: 48px;
	}

	.guide-intro {
		max-width: 680px;
		margin: 8px 0 0;
		color: var(--guide-muted);
		font-size: 16px;
		line-height: 24px;
	}

	.guide-overview {
		display: grid;
		padding-left: 24px;
		border-left: 1px solid var(--guide-rule);
	}

	.overview-heading,
	.guide-overview a {
		display: grid;
		align-items: center;
	}

	.overview-heading {
		grid-template-columns: 1fr auto;
		padding: 0 0 8px;
		color: var(--guide-muted);
		font-size: 13px;
		font-weight: 600;
		line-height: 18px;
		text-transform: uppercase;
	}

	.overview-status {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		color: var(--workbench-ready);
		text-transform: none;
	}

	.overview-status i {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: currentColor;
	}

	.guide-overview a {
		grid-template-columns: 32px minmax(0, 1fr) 16px;
		gap: 12px;
		min-height: 52px;
		padding: 0;
		border-radius: 4px;
		color: var(--fgColor-default);
		text-decoration: none;
	}

	.guide-overview a:hover {
		color: var(--workbench-path);
	}

	.overview-count {
		color: var(--workbench-path);
		font-family: var(--font-mono);
		font-size: 13px;
		font-weight: 600;
	}

	.guide-overview strong,
	.guide-overview small {
		display: block;
	}

	.guide-overview strong {
		font-size: 14px;
		line-height: 18px;
	}

	.guide-overview small {
		margin-top: 1px;
		color: var(--guide-muted);
		font-size: 13px;
		line-height: 18px;
	}

	.guide-section {
		scroll-margin-top: 64px;
		padding: 56px 0 0;
	}

	.section-heading {
		max-width: 760px;
		margin-bottom: 32px;
	}

	.section-heading h2,
	.block-heading h3 {
		margin: 0;
		color: var(--fgColor-default);
		font-weight: 600;
	}

	.section-heading h2 {
		font-size: 24px;
		line-height: 32px;
	}

	.section-heading p,
	.block-heading p {
		margin: 4px 0 0;
		color: var(--guide-muted);
		font-size: 15px;
		line-height: 22px;
	}

	.foundation-block {
		min-width: 0;
	}

	.block-heading {
		margin-bottom: 16px;
	}

	.block-heading h3 {
		font-size: 16px;
		line-height: 24px;
	}

	.atlas-heading {
		display: flex;
		align-items: end;
		justify-content: space-between;
		gap: 48px;
		margin-bottom: 48px;
	}

	.atlas-heading h2 {
		max-width: 720px;
		margin: 8px 0 0;
		color: var(--fgColor-default);
		font-size: 32px;
		font-weight: 600;
		line-height: 40px;
	}

	.atlas-heading > div > p:last-child {
		margin: 8px 0 0;
		color: var(--guide-muted);
		font-size: 15px;
		line-height: 22px;
	}

	.atlas-tally {
		display: flex;
		align-items: end;
		gap: 10px;
		padding-bottom: 2px;
		white-space: nowrap;
	}

	.atlas-tally strong {
		color: var(--workbench-path);
		font-size: 48px;
		font-weight: 500;
		line-height: 44px;
	}

	.atlas-tally span {
		color: var(--guide-muted);
		font-size: 13px;
		line-height: 16px;
	}

	.showcase-group + .showcase-group {
		margin-top: 80px;
	}

	.showcase-group-heading {
		display: grid;
		grid-template-columns: 32px minmax(0, 1fr) auto;
		gap: 12px;
		align-items: start;
		margin-bottom: 20px;
	}

	.showcase-group-heading > span {
		padding-top: 3px;
		color: var(--workbench-path);
		font-family: var(--font-mono);
		font-size: 13px;
		font-weight: 600;
	}

	.showcase-group-heading h3,
	.showcase-caption h4 {
		margin: 0;
		color: var(--fgColor-default);
		font-weight: 600;
	}

	.showcase-group-heading h3 {
		font-size: 20px;
		line-height: 28px;
	}

	.showcase-group-heading p,
	.showcase-caption p {
		margin: 2px 0 0;
		color: var(--guide-muted);
		font-size: 13px;
		line-height: 18px;
	}

	.showcase-group-heading code {
		padding-top: 4px;
		color: var(--guide-muted);
		font-size: 13px;
		line-height: 18px;
	}

	.showcase-grid {
		display: grid;
		grid-template-columns: repeat(12, minmax(0, 1fr));
		gap: 24px;
	}

	.showcase-module {
		grid-column: span 6;
		min-width: 0;
		padding: 20px;
		border-radius: var(--workbench-radius);
		background: var(--workbench-surface);
	}

	.showcase-module.wide { grid-column: 1 / -1; }
	.showcase-module.seven { grid-column: span 7; }
	.showcase-module.five { grid-column: span 5; }
	.showcase-module.unframed { padding: 0; background: transparent; }

	.showcase-caption {
		margin-bottom: 16px;
	}

	.showcase-caption > span {
		color: var(--workbench-path);
		font-size: 13px;
		font-weight: 600;
		line-height: 18px;
		text-transform: uppercase;
	}

	.showcase-caption h4 {
		margin-top: 2px;
		font-size: 16px;
		line-height: 24px;
	}

	.migration-card-stack {
		display: grid;
		gap: 12px;
	}

	.auth-fields-showcase {
		max-width: 680px;
	}

	.org-showcase {
		display: grid;
		gap: 8px;
	}

	.status-showcase {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 20px;
	}

	.consequence-showcase {
		display: flex;
		flex-direction: column;
		justify-content: space-between;
	}

	.danger-trigger {
		align-self: flex-start;
		border-color: var(--borderColor-danger-emphasis);
		background: var(--bgColor-danger-muted);
		color: var(--fgColor-danger);
	}

	.icon-module {
		scroll-margin-top: 64px;
	}

	.icon-reference {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 280px;
		gap: 32px;
	}

	.icon-reference h5 {
		margin: 0 0 12px;
		color: var(--guide-muted);
		font-size: 13px;
		font-weight: 600;
		line-height: 18px;
		text-transform: uppercase;
	}

	.icon-role-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 24px 32px;
	}

	.icon-role-symbols {
		display: flex;
		gap: 6px;
		margin-bottom: 10px;
	}

	.icon-role-symbols span {
		display: grid;
		width: 32px;
		height: 32px;
		border-radius: 4px;
		place-items: center;
		background: var(--workbench-control-surface);
		color: var(--fgColor-default);
	}

	.icon-role strong {
		color: var(--fgColor-default);
		font-size: 14px;
		line-height: 20px;
	}

	.icon-role p,
	.icon-standards p {
		margin: 2px 0 0;
		color: var(--guide-muted);
		font-size: 13px;
		line-height: 18px;
	}

	.icon-standards {
		display: grid;
		gap: 24px;
		padding-left: 24px;
		border-left: 1px solid var(--guide-rule);
	}

	.icon-size-scale {
		display: flex;
		align-items: end;
		gap: 20px;
	}

	.icon-size-scale > span {
		display: grid;
		gap: 6px;
		justify-items: center;
		color: var(--fgColor-default);
	}

	.icon-size-scale code,
	.provider-icon-list small {
		color: var(--guide-muted);
		font-size: 13px;
		line-height: 18px;
	}

	.provider-icon-list {
		display: grid;
		gap: 10px;
	}

	.provider-icon-list > span {
		display: flex;
		align-items: center;
		gap: 10px;
	}

	.provider-icon-list strong {
		color: var(--fgColor-default);
		font-size: 13px;
		line-height: 18px;
	}

	.icon-inventory {
		margin-top: 24px;
		border-top: 1px solid var(--guide-rule);
	}

	.icon-inventory summary {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 24px;
		min-height: 52px;
		cursor: pointer;
		list-style: none;
	}

	.icon-inventory summary::-webkit-details-marker {
		display: none;
	}

	.icon-inventory-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(152px, 1fr));
		gap: 4px 16px;
		padding: 8px 0 16px;
	}

	.icon-inventory-grid > div {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
		min-height: 30px;
		color: var(--fgColor-default);
	}

	.icon-inventory-grid code {
		overflow: hidden;
		color: var(--guide-muted);
		font-size: 13px;
		line-height: 18px;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.component-registry {
		margin-top: 72px;
		padding: 0 20px;
		border-radius: var(--workbench-radius);
		background: var(--workbench-surface);
	}

	.component-registry > summary {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 24px;
		min-height: 52px;
		cursor: pointer;
		list-style: none;
	}

	.component-registry > summary::-webkit-details-marker {
		display: none;
	}

	.component-registry > summary > span::after {
		margin-left: 8px;
		content: "+";
	}

	.component-registry[open] > summary > span::after {
		content: "−";
	}

	.registry-groups {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 24px 32px;
		padding: 8px 0 24px;
	}

	.registry-groups h3 {
		margin: 0 0 8px;
		color: var(--guide-muted);
		font-size: 13px;
		font-weight: 600;
		line-height: 18px;
	}

	.registry-groups ul {
		display: grid;
		gap: 4px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.registry-groups code {
		color: var(--fgColor-default);
		font-size: 13px;
		line-height: 18px;
	}

	.composition-anatomy span {
		color: var(--workbench-path);
		font-size: 13px;
		font-weight: 600;
		line-height: 18px;
		text-transform: uppercase;
	}

	.specimen-state {
		margin: 12px 0 0;
		color: var(--guide-muted);
		font-size: 13px;
		line-height: 18px;
	}

	.specimen-state code {
		color: var(--fgColor-default);
	}

	.palette-groups {
		display: grid;
		gap: 28px;
	}

	.palette-heading {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 24px;
		margin-bottom: 10px;
	}

	.palette-heading h4 {
		margin: 0;
		color: var(--fgColor-default);
		font-size: 14px;
		font-weight: 600;
		line-height: 20px;
	}

	.palette-heading p {
		margin: 0;
		color: var(--guide-muted);
		font-size: 13px;
		line-height: 18px;
		text-align: right;
	}

	.swatch-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
		gap: 12px;
	}

	.swatch {
		min-width: 0;
	}

	.swatch-color {
		display: block;
		height: 56px;
		margin-bottom: 10px;
		border: 1px solid var(--guide-rule);
		border-radius: var(--workbench-radius);
	}

	.swatch-name,
	.swatch code {
		display: block;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.swatch-name {
		color: var(--fgColor-default);
		font-size: 13px;
		font-weight: 600;
	}

	.swatch code {
		margin-top: 3px;
		color: var(--guide-muted);
		font-size: 13px;
	}

	.typography-block {
		margin-top: 48px;
	}

	.typography-reference {
		display: grid;
		grid-template-columns: minmax(0, 1.45fr) minmax(280px, 0.75fr);
		overflow: hidden;
		border-radius: var(--workbench-radius);
		background: var(--workbench-surface);
	}

	.type-composition {
		padding: 36px;
		border-right: 1px solid var(--guide-rule);
	}

	.type-context {
		display: flex;
		justify-content: space-between;
		gap: 16px;
		color: var(--guide-muted);
		font-size: 13px;
		font-weight: 600;
		line-height: 18px;
		text-transform: uppercase;
	}

	.type-display {
		margin: 40px 0 0;
		color: var(--fgColor-default);
		font-size: 32px;
		font-weight: 600;
		line-height: 40px;
	}

	.type-lede {
		max-width: 560px;
		margin: 8px 0 0;
		color: var(--guide-muted);
		font-size: 16px;
		line-height: 24px;
	}

	.type-route {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 20px minmax(0, 1fr);
		gap: 12px;
		align-items: center;
		margin-top: 36px;
		padding-top: 24px;
		border-top: 1px solid var(--guide-rule);
		color: var(--workbench-path);
	}

	.type-route code {
		overflow: hidden;
		color: var(--fgColor-default);
		font-family: var(--font-mono);
		font-size: 14px;
		line-height: 20px;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.type-status {
		display: flex;
		align-items: center;
		gap: 8px;
		margin: 18px 0 0;
		color: var(--guide-muted);
		font-size: 13px;
		font-weight: 500;
		line-height: 18px;
	}

	.type-status i {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--workbench-ready);
	}

	.type-ledger {
		margin: 0;
		padding: 24px;
		background: var(--workbench-canvas-inset);
	}

	.type-ledger > div {
		display: grid;
		grid-template-columns: 72px minmax(0, 1fr);
		gap: 2px 12px;
		padding: 10px 0;
	}

	.type-ledger dt,
	.type-ledger dd,
	.type-ledger small {
		font-size: 13px;
		line-height: 18px;
	}

	.type-ledger dt { color: var(--fgColor-default); font-weight: 600; }
	.type-ledger dd { margin: 0; color: var(--workbench-path); font-family: var(--font-mono); }
	.type-ledger small { grid-column: 2; color: var(--guide-muted); }

	.geometry-block {
		margin-top: 40px;
	}

	.geometry-list {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 8px;
		margin: 0;
	}

	.geometry-list > div {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 16px;
		padding: 14px 16px;
		background: var(--workbench-surface);
	}

	.geometry-list dt,
	.geometry-list dd {
		font-size: 13px;
		line-height: 18px;
	}

	.geometry-list dt { color: var(--guide-muted); }
	.geometry-list dd { margin: 0; color: var(--fgColor-default); font-family: var(--font-mono); }

	.button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		min-height: var(--workbench-control-height);
		padding: 0 14px;
		border: 1px solid var(--borderColor-emphasis);
		border-radius: var(--workbench-radius);
		font-size: 14px;
		font-weight: 600;
		white-space: nowrap;
	}

	.button.primary,
	.button.ready { border-color: var(--button-primary-borderColor-rest); background: var(--button-primary-bgColor-rest); color: var(--button-primary-fgColor-rest); }
	.button.primary:hover,
	.button.ready:hover { background: var(--button-primary-bgColor-hover); }
	.button.primary:active,
	.button.ready:active { background: var(--button-primary-bgColor-active); }
	.button.production { border-color: var(--borderColor-attention-emphasis); background: var(--workbench-production-emphasis); color: var(--fgColor-onEmphasis); }
	.button.secondary { border-color: var(--button-default-borderColor-rest); background: var(--button-default-bgColor-rest); color: var(--button-default-fgColor-rest); }
	.button.secondary:hover { background: var(--button-default-bgColor-hover); }
	.button.secondary:active { background: var(--button-default-bgColor-active); }
	.button:disabled { cursor: not-allowed; opacity: 0.5; }

	.preview-form label {
		display: block;
	}

	.preview-form input {
		width: 100%;
		height: var(--workbench-control-height);
		padding: 0 12px;
		border: 1px solid var(--borderColor-emphasis);
		border-radius: var(--workbench-radius);
		background: var(--workbench-control-surface);
		color: var(--fgColor-default);
		font-size: 14px;
	}

	.preview-form input:focus {
		outline: var(--focus-outline);
		outline-offset: -1px;
	}

	.preview-form small,
	.launch-grid small {
		display: block;
		margin-top: 4px;
		color: var(--guide-muted);
		font-size: 13px;
		line-height: 18px;
	}

	.endpoint-list {
		overflow: hidden;
		border: 1px solid var(--borderColor-emphasis);
		border-radius: var(--workbench-radius);
	}

	.endpoint-list button {
		display: grid;
		grid-template-columns: 40px minmax(0, 1fr) 20px;
		gap: 12px;
		align-items: center;
		width: 100%;
		height: var(--workbench-option-height);
		padding: 12px;
		border: 0;
		background: transparent;
		color: var(--fgColor-default);
		text-align: left;
	}

	.provider-mark {
		display: grid;
		width: 40px;
		height: 40px;
		place-items: center;
		border-radius: var(--workbench-radius);
		background: var(--workbench-control-surface);
	}

	.provider-copy strong,
	.provider-copy small {
		display: block;
	}

	.provider-copy strong { font-size: 15px; line-height: 20px; }
	.provider-copy small { margin-top: 2px; color: var(--guide-muted); font-size: 13px; line-height: 18px; }

	.selected-check {
		display: grid;
		width: 18px;
		height: 18px;
		place-items: center;
		border-radius: 50%;
		background: var(--bgColor-accent-emphasis);
		color: var(--fgColor-onEmphasis);
	}

	.composition-anatomy {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 32px;
		padding: 0;
		margin-bottom: 28px;
		list-style: none;
	}

	.composition-anatomy > li {
		display: grid;
		grid-template-columns: 28px minmax(0, 1fr);
		column-gap: 10px;
		align-items: baseline;
	}

	.composition-anatomy strong {
		color: var(--fgColor-default);
		font-size: 14px;
		line-height: 20px;
	}

	.composition-anatomy small {
		grid-column: 2;
		color: var(--guide-muted);
		font-size: 13px;
		line-height: 18px;
	}

	.preview-controls {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		margin-bottom: 12px;
	}

	.segmented {
		display: inline-flex;
		padding: 3px;
		border: 1px solid var(--guide-rule);
		border-radius: var(--workbench-radius);
		background: var(--workbench-canvas);
	}

	.segmented button {
		min-height: 32px;
		padding: 0 12px;
		border: 0;
		border-radius: 4px;
		background: transparent;
		color: var(--guide-muted);
		font-size: 13px;
		font-weight: 600;
		white-space: nowrap;
	}

	.preview-stage {
		overflow-x: auto;
		padding: 24px;
		border: 1px solid var(--guide-rule);
		background: var(--workbench-canvas-inset);
	}

	.workflow-preview {
		width: 100%;
		min-width: 760px;
		overflow: hidden;
		border: 1px solid var(--borderColor-emphasis);
		border-radius: 8px;
		background: var(--workbench-canvas);
		transition: width var(--workbench-transition);
	}

	.workflow-preview.compact {
		width: 390px;
		min-width: 390px;
		margin: 0 auto;
	}

	.preview-appbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		height: 52px;
		padding: 0 20px;
		border-bottom: 1px solid var(--guide-rule);
		background: var(--bgColor-muted);
		color: var(--fgColor-default);
		font-size: 13px;
		font-weight: 600;
	}

	.preview-appbar > span { display: flex; align-items: center; gap: 8px; }
	.preview-capacity { color: var(--guide-muted); font-weight: 400; }
	.preview-capacity i,
	.context-status i,
	.capacity-ready i { width: 7px; height: 7px; border-radius: 50%; background: var(--workbench-ready); }

	.preview-content { padding: 32px; }

	.preview-masthead {
		display: flex;
		align-items: end;
		justify-content: space-between;
		gap: 24px;
		margin-bottom: 24px;
	}

	.preview-masthead h3 { margin: 0; color: var(--fgColor-default); font-size: 22px; font-weight: 600; line-height: 28px; }
	.preview-masthead p { margin: 3px 0 0; color: var(--guide-muted); font-size: 14px; line-height: 20px; }
	.preview-masthead > span { color: var(--guide-muted); font-size: 13px; }

	.workflow-rail {
		display: grid;
		grid-template-columns: repeat(6, minmax(0, 1fr));
		margin: 0 0 18px;
		padding: 0;
		list-style: none;
	}

	.workflow-rail li {
		position: relative;
		display: grid;
		grid-template-columns: 20px minmax(0, 1fr);
		gap: 7px;
		align-items: center;
		color: var(--fgColor-disabled);
		font-size: 13px;
	}

	.workflow-rail li:not(:last-child)::after {
		position: absolute;
		top: 9px;
		left: 20px;
		right: 7px;
		height: 1px;
		background: var(--guide-rule);
		content: "";
	}

	.workflow-rail li.complete:not(:last-child)::after { background: var(--workbench-path); }
	.step-node { position: relative; z-index: 1; display: grid; width: 20px; height: 20px; place-items: center; border: 1px solid var(--borderColor-emphasis); border-radius: 50%; background: var(--workbench-canvas); font-size: 13px; font-weight: 700; }
	.step-label { position: relative; z-index: 1; width: max-content; padding-right: 7px; background: var(--workbench-canvas); }
	.compact-progress { display: none; }
	.workflow-rail li.complete,
	.workflow-rail li.current { color: var(--fgColor-default); }
	.workflow-rail li.complete .step-node { border-color: var(--workbench-path); background: var(--bgColor-accent-emphasis); color: var(--fgColor-onEmphasis); }
	.workflow-rail li.current .step-node { border-color: var(--workbench-path); color: var(--workbench-path); box-shadow: 0 0 0 3px var(--workbench-path-muted); }

	.workbench { overflow: hidden; border: 1px solid var(--guide-rule); border-radius: var(--workbench-radius); background: var(--workbench-surface); }
	.workbench-head { display: flex; align-items: start; justify-content: space-between; gap: 20px; padding: 24px 28px 0; }
	.workbench-head h4 { margin: 0; color: var(--fgColor-default); font-size: 18px; font-weight: 600; line-height: 26px; }
	.workbench-head p { margin: 2px 0 0; color: var(--guide-muted); font-size: 13px; line-height: 18px; }
	.workbench-head > span { padding-top: 4px; color: var(--guide-muted); font-size: 13px; white-space: nowrap; }
	.workbench-body { padding: 24px 28px 28px; }

	.route-choice { display: grid; grid-template-columns: minmax(0, 1fr) 64px minmax(0, 1fr); align-items: start; }
	.structural-label { margin-bottom: 9px; color: var(--guide-muted); font-size: 13px; line-height: 18px; }
	.compact-options button { height: 58px; grid-template-columns: 32px minmax(0, 1fr) 18px; padding: 9px; }
	.compact-options .provider-mark { width: 32px; height: 32px; }
	.transfer { display: flex; align-items: center; height: 58px; margin-top: 25px; color: var(--workbench-path); }
	.transfer span { width: 44px; height: 1px; background: var(--workbench-path); }

	.configure-layout { display: grid; grid-template-columns: minmax(0, 1fr) 240px; gap: 32px; }
	.preview-form { max-width: 560px; }
	.preview-form label { margin-top: 16px; }
	.route-context { padding-left: 24px; border-left: 1px solid var(--guide-rule); }
	.route-context strong { display: flex; align-items: center; gap: 6px; color: var(--fgColor-default); font-size: 13px; }
	.context-label { margin-top: 24px; }
	.context-status,
	.capacity-ready { display: flex; align-items: center; gap: 8px; color: var(--fgColor-default); font-size: 13px; font-weight: 600; }

	.review-route { display: grid; grid-template-columns: auto minmax(60px, 1fr) auto; gap: 14px; align-items: center; padding-bottom: 22px; border-bottom: 1px solid var(--guide-rule); }
	.review-route > span { display: flex; align-items: center; gap: 9px; }
	.review-route strong,
	.review-route small { display: block; }
	.review-route strong { color: var(--fgColor-default); font-size: 13px; }
	.review-route small { color: var(--guide-muted); font-size: 13px; font-weight: 400; }
	.review-route > div { display: flex; align-items: center; color: var(--workbench-path); }
	.review-route > div i { width: 100%; height: 1px; background: var(--workbench-path); }

	.mapping { padding-top: 22px; }
	.mapping-head,
	.mapping-row { display: grid; grid-template-columns: minmax(0, 1fr) 28px minmax(0, 1fr); gap: 6px; align-items: center; }
	.mapping-head { padding: 0 8px 7px; color: var(--guide-muted); font-size: 13px; font-weight: 600; }
	.mapping-row { min-height: 42px; padding: 7px 8px; border-top: 1px solid var(--guide-rule); color: var(--workbench-path); }
	.mapping-row code { overflow: hidden; color: var(--fgColor-default); font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }

	.launch-grid { display: grid; grid-template-columns: minmax(0, 1fr) 220px; gap: 32px; margin-top: 22px; padding-top: 22px; border-top: 1px solid var(--guide-rule); }
	.run-modes { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
	.run-modes button { display: flex; align-items: center; gap: 8px; min-height: 38px; padding: 0 10px; border: 1px solid var(--borderColor-emphasis); border-radius: var(--workbench-radius); background: transparent; color: var(--fgColor-default); font-size: 13px; font-weight: 600; }

	.action-dock { display: flex; align-items: center; justify-content: space-between; min-height: 64px; padding: 11px 28px; border-top: 1px solid var(--guide-rule); }
	.action-dock > span { color: var(--guide-muted); font-size: 13px; }
	.action-dock > div { display: flex; gap: 8px; }

	.org-showcase label,
	.status-showcase > div > span {
		color: var(--guide-muted);
		font-size: 13px;
		font-weight: 600;
		line-height: 18px;
	}

	.status-showcase > div > span {
		display: block;
		margin-bottom: 6px;
	}

	.provider-icon-list > span > span,
	.provider-icon-list strong,
	.provider-icon-list small {
		display: block;
	}

	.icon-inventory summary span,
	.icon-inventory summary strong,
	.icon-inventory summary small {
		display: block;
	}

	.icon-inventory summary strong {
		color: var(--fgColor-default);
		font-size: 13px;
		line-height: 18px;
	}

	.icon-inventory summary small,
	.icon-inventory summary > code {
		color: var(--guide-muted);
		font-size: 13px;
		line-height: 18px;
	}

	.component-registry > summary div {
		display: flex;
		align-items: baseline;
		gap: 10px;
	}

	.component-registry > summary strong {
		color: var(--fgColor-default);
		font-size: 15px;
		line-height: 22px;
	}

	.component-registry > summary span {
		color: var(--guide-muted);
		font-size: 13px;
		line-height: 18px;
	}

	.preview-form label > span {
		display: block;
		margin-bottom: 8px;
		color: var(--fgColor-default);
		font-size: 13px;
		font-weight: 600;
	}

	.endpoint-list button + button {
		border-top: 1px solid var(--guide-rule);
	}

	.run-modes button span { width: 14px; height: 14px; border: 1px solid var(--borderColor-emphasis); border-radius: 50%; }

	.org-showcase label:not(:first-child) {
		margin-top: 8px;
	}

	.endpoint-list button:hover { background: var(--workbench-control-hover); }
	.endpoint-list button.selected { background: var(--workbench-path-muted); box-shadow: inset 2px 0 var(--workbench-path); }

	.segmented button[aria-selected="true"],
	.segmented button[aria-pressed="true"] {
		background: var(--workbench-control-active);
		box-shadow: inset 0 -2px var(--workbench-path);
		color: var(--fgColor-default);
	}

	.compact-options .provider-copy strong { font-size: 13px; line-height: 18px; }
	.compact-options .provider-copy small { font-size: 13px; line-height: 18px; }
	.run-modes button.selected { border-color: var(--workbench-path); background: var(--workbench-path-muted); }
	.run-modes button.selected span { border: 4px solid var(--workbench-path); }
	.run-modes button.production { border-color: var(--workbench-production-border); background: var(--workbench-production-muted); }
	.run-modes button.production span { border-color: var(--workbench-production); }

	.workflow-preview.compact .preview-capacity,
	.workflow-preview.compact .preview-masthead > span,
	.workflow-preview.compact .workflow-rail li:not(.current),
	.workflow-preview.compact .route-context,
	.workflow-preview.compact .workbench-head > span,
	.workflow-preview.compact .action-dock > span { display: none; }
	.workflow-preview.compact .preview-content { padding: 24px 16px; }
	.workflow-preview.compact .preview-masthead { margin-bottom: 20px; }
	.workflow-preview.compact .workflow-rail { display: block; }
	.workflow-preview.compact .workflow-rail li.current { display: grid; width: 100%; grid-template-columns: 20px auto 1fr; }
	.workflow-preview.compact .compact-progress { display: block; justify-self: end; color: var(--guide-muted); }
	.workflow-preview.compact .workbench-head { padding: 20px 20px 0; }
	.workflow-preview.compact .workbench-body { padding: 22px 20px; }
	.workflow-preview.compact .route-choice,
	.workflow-preview.compact .configure-layout,
	.workflow-preview.compact .launch-grid { grid-template-columns: 1fr; }
	.workflow-preview.compact .transfer { width: 58px; height: 42px; margin: 0; transform: rotate(90deg); }
	.workflow-preview.compact .review-route { grid-template-columns: 1fr; }
	.workflow-preview.compact .review-route > div { width: 44px; height: 22px; transform: rotate(90deg); }
	.workflow-preview.compact .mapping-head { display: none; }
	.workflow-preview.compact .mapping-row { grid-template-columns: 1fr; gap: 5px; padding: 10px 0; }
	.workflow-preview.compact .mapping-row :global(svg) { transform: rotate(90deg); }
	.workflow-preview.compact .launch-grid { gap: 20px; }
	.workflow-preview.compact .run-modes { grid-template-columns: 1fr; }
	.workflow-preview.compact .action-dock { padding: 11px 20px; }
	.workflow-preview.compact .action-dock > div { width: 100%; }
	.workflow-preview.compact .action-dock .button { min-height: var(--workbench-mobile-control-height); flex: 1; padding: 0 10px; }

	@media (max-width: 900px) {
		.guide-masthead { grid-template-columns: minmax(0, 1fr) 288px; gap: 40px; }
		.composition-anatomy { grid-template-columns: 1fr; gap: 16px; }
		.typography-reference { grid-template-columns: 1fr; }
		.type-composition { border-right: 0; border-bottom: 1px solid var(--guide-rule); }
		.icon-reference { grid-template-columns: 1fr; }
		.icon-standards { grid-template-columns: repeat(2, minmax(0, 1fr)); padding: 24px 0 0; border-top: 1px solid var(--guide-rule); border-left: 0; }
		.showcase-module.seven,
		.showcase-module.five { grid-column: 1 / -1; }
		.registry-groups { grid-template-columns: repeat(2, minmax(0, 1fr)); }
		.swatch-grid { grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); }
	}

	@media (max-width: 640px) {
		.guide-masthead { grid-template-columns: 1fr; gap: 28px; padding-top: 16px; }
		.guide-masthead h1 { font-size: 32px; line-height: 40px; }
		.guide-overview { padding-left: 16px; }
		.atlas-heading { align-items: flex-start; flex-direction: column; gap: 20px; margin-bottom: 48px; }
		.atlas-heading h2 { font-size: 28px; line-height: 36px; }
		.showcase-group + .showcase-group { margin-top: 64px; }
		.showcase-group-heading { grid-template-columns: 28px minmax(0, 1fr); }
		.showcase-group-heading code { display: none; }
		.showcase-module { grid-column: 1 / -1; padding: 16px; }
		.showcase-module.unframed { padding: 0; }
		.status-showcase { grid-template-columns: 1fr; gap: 16px; }
		.icon-role-grid { grid-template-columns: 1fr; }
		.icon-standards { grid-template-columns: 1fr; }
		.icon-inventory summary { align-items: flex-start; flex-direction: column; gap: 4px; padding: 10px 0; }
		.type-composition { padding: 24px 20px; }
		.type-display { margin-top: 28px; font-size: 28px; line-height: 36px; }
		.type-route { grid-template-columns: 1fr; }
		.typography-block .typography-reference .type-composition .type-route :global(svg) { transform: rotate(90deg); }
		.geometry-list { grid-template-columns: 1fr; }
		.component-registry > summary { align-items: flex-start; flex-direction: column; gap: 0; padding-block: 10px; }
		.registry-groups { grid-template-columns: 1fr; gap: 18px; }
		.palette-heading { align-items: flex-start; flex-direction: column; gap: 2px; }
		.palette-heading p { text-align: left; }
		.swatch-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
		.preview-controls { align-items: stretch; flex-direction: column; }
		.preview-controls > .segmented { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); }
		.preview-controls > .segmented:last-child { grid-template-columns: repeat(2, minmax(0, 1fr)); }
		.preview-stage { margin-inline: -16px; padding: 12px; }
	}

	@media (prefers-reduced-motion: reduce) {
		.workflow-preview { transition: none; }
	}
</style>