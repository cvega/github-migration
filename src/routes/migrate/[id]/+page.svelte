<script lang="ts">
	import { onMount } from "svelte";
	import { enhance } from "$app/forms";
	import { invalidateAll } from "$app/navigation";
	import { page } from "$app/state";
	import CompactButton from "$lib/components/CompactButton.svelte";
	import ConfirmDialog from "$lib/components/ConfirmDialog.svelte";
	import ErrorDetail from "$lib/components/ErrorDetail.svelte";
	import MigrationForm from "$lib/components/migrate/MigrationForm.svelte";
	import MigrationProgress from "$lib/components/migrate/MigrationProgress.svelte";
	import Octicon from "$lib/components/Octicon.svelte";
	import { formatDateTime, formatElapsed, formatRepoSize } from "$lib/format";
	import type { UsedIconName } from "$lib/icons.generated";
	import { createMigrationEventSource, refreshMigrations } from "$lib/migrate/live.svelte";
	import { isGitHubCloud, STATE_ICONS, STATE_LABELS } from "$lib/migrate/migration-display";
	import { createMigrationForm } from "$lib/migrate/migration-form.svelte";
	import { pollScopedPage } from "$lib/migrate/scoped-poll";
	import type {
		Counts,
		FailureDetail,
		Migration,
		MigrationEvent,
		Phase,
		Progress,
	} from "$lib/migrate/types";
	import { isActiveMigrationState, isRestartableMigrationState } from "$lib/migration-state";
	import { getTargetPlatformPresentation, isPausedPersistedRoute, supportsMigrationTarget } from "$lib/migration-target";
	import { getSourceProviderAdapter, sourceBaseUrl, sourceProjectUrl } from "$lib/source-provider";

	let { data, form } = $props();
	let countsSubmitting = $state(false);
	let polledMigration = $state<Migration | null>(null);
	const freshMigration = $derived(
		polledMigration?.id === data.migration.id ? polledMigration : null,
	);
	const migration = $derived<Migration>(freshMigration ?? data.migration);
	const provider = $derived(getSourceProviderAdapter(migration.sourceProvider));
	const restartSupported = $derived(provider.capabilities.restart &&
		supportsMigrationTarget(migration.sourceProvider, migration.targetPlatform) &&
		!isPausedPersistedRoute(migration));
	const sourcePlatform = $derived(provider.sourcePlatform(migration.sourceApiUrl));
	const targetPlatform = $derived(getTargetPlatformPresentation(migration.targetPlatform));
	let eventLog = $state<MigrationEvent[]>([]);
	let currentPhase = $state<Phase>("PENDING_VALIDATION");
	let handoff = $state<{ completed: Phase; operation: string } | null>(null);
	let latestProgress = $state<Progress | null>(null);
	let sourceCounts = $state<Counts | null>(null);
	let failureDetail = $state<FailureDetail | null>(null);
	let eventSource = $state.raw<ReturnType<typeof createMigrationEventSource> | null>(null);
	let lastProcessedId = $state<number | undefined>();
	let pollInterval: ReturnType<typeof setInterval> | null = null;
	let pollSequence = 0;

	let showRestartForm = $state(false);
	let restartSubmitting = $state(false);
	let restartError = $state("");
	let showCancelDialog = $state(false);
	let cancelSubmitting = $state(false);
	let cancelError = $state("");
	let showReconciliationDialog = $state(false);
	let reconciliationSubmitting = $state(false);
	let reconciliationError = $state("");
	const cancelPhrase = $derived(`${migration.sourceOrg}/${migration.sourceRepo}`);
	const reconciliationPhrase = $derived(`${migration.targetOrg}/${migration.targetRepo}`);

	const sourceEnvApp = $derived(page.data.sourceAuth?.mode === "github-app");
	const targetEnvApp = $derived(page.data.targetAuth?.mode === "github-app");
	const sourceEnvPat = $derived(!!page.data.sourceAuth?.hasEnvPat);
	const targetEnvPat = $derived(!!page.data.targetAuth?.hasEnvPat);
	const restart = createMigrationForm(() => ({
		sourceEnvApp,
		sourceEnvPat,
		targetEnvApp,
		targetEnvPat,
	}));

	$effect(() => {
		const migrationId = data.migration.id;
		pollSequence += 1;
		polledMigration = null;
		eventLog = [...data.events];
		handoff = null;
		currentPhase = "PENDING_VALIDATION";
		latestProgress = null;
		sourceCounts = null;
		failureDetail = null;
		for (const event of data.events) processEvent(event);
		lastProcessedId = data.eventCursor || undefined;
		if (data.scoped) return;
		if (isActiveMigrationState(data.migration.state)) {
			eventSource = createMigrationEventSource(migrationId, data.eventCursor);
		}
		startPolling(migrationId);
		return () => {
			if (pollInterval) clearInterval(pollInterval);
			pollInterval = null;
			eventSource?.destroy();
			eventSource = null;
		};
	});

	onMount(() => {
		if (data.scoped) return pollScopedPage();
		restart.initAuthModes();
	});

	$effect(() => {
		if (!eventSource) return;
		const events = eventSource.events;
		if (events.length === 0) return;
		const lastId = lastProcessedId;
		const startIndex =
			lastId === undefined
				? 0
				: events.findIndex((event) => event.id !== undefined && event.id > lastId);
		if (startIndex === -1) return;
		for (let index = startIndex; index < events.length; index += 1) {
			const event = events[index];
			if (!event) continue;
			eventLog = [...eventLog.slice(-999), event];
			processEvent(event);
		}
		const lastEvent = events.at(-1);
		if (lastEvent?.id !== undefined) lastProcessedId = lastEvent.id;
	});

	function processEvent(event: MigrationEvent) {
		if (event.phase) {
			currentPhase = event.phase;
			handoff = null;
		}
		if (event.eventType === "step" && event.payload.executorPhase) {
			switch (event.payload.executorPhase) {
				case "archive_ready":
				case "transferring":
				case "preparing":
				case "mapping":
					handoff = { completed: "EXPORTING", operation: event.payload.message };
					break;
				case "auditing":
				case "unlocking":
					handoff = { completed: "IMPORTING_METADATA", operation: event.payload.message };
					break;
			}
		}
		if (event.eventType === "snapshot" || event.eventType === "complete") {
			latestProgress = event.payload.progress;
			if (event.payload.sourceCounts) sourceCounts = event.payload.sourceCounts;
		} else if (event.eventType === "failure" && event.payload.detail) {
			failureDetail = event.payload.detail;
		} else if (event.eventType === "restart") {
			handoff = null;
			currentPhase = "PENDING_VALIDATION";
			latestProgress = null;
			sourceCounts = null;
			failureDetail = null;
		}
	}

	const isActive = $derived(isActiveMigrationState(migration.state));
	const displayedPhase = $derived(migration.state === "succeeded" ? "SUCCEEDED" : currentPhase);
	const statePresentation: Record<
		Migration["state"],
		{ label: string; text: string; accent: string; dot: string; pulse: boolean }
	> = {
		queued: {
			label: STATE_LABELS.queued,
			text: "text-violet-400",
			accent: "bg-violet-500",
			dot: "bg-violet-400",
			pulse: false,
		},
		pending: {
			label: STATE_LABELS.pending,
			text: "text-yellow-400",
			accent: "bg-yellow-500",
			dot: "bg-yellow-400",
			pulse: false,
		},
		running: {
			label: STATE_LABELS.running,
			text: "text-green-400",
			accent: "bg-green-500",
			dot: "bg-green-400",
			pulse: true,
		},
		cancelling: {
			label: STATE_LABELS.cancelling,
			text: "text-cyan-400",
			accent: "bg-cyan-500",
			dot: "bg-cyan-400",
			pulse: true,
		},
		succeeded: {
			label: STATE_LABELS.succeeded,
			text: "text-green-400",
			accent: "bg-green-500",
			dot: "bg-green-400",
			pulse: false,
		},
		failed: {
			label: STATE_LABELS.failed,
			text: "text-red-400",
			accent: "bg-red-500",
			dot: "bg-red-400",
			pulse: false,
		},
		cancelled: {
			label: STATE_LABELS.cancelled,
			text: "text-gray-400",
			accent: "bg-gray-500",
			dot: "bg-gray-400",
			pulse: false,
		},
		reconciliation_required: {
			label: "Review required",
			text: "text-orange-400",
			accent: "bg-orange-500",
			dot: "bg-orange-400",
			pulse: false,
		},
	};
	const stateMeta = $derived(statePresentation[migration.state]);
	const displayTargetCounts = $derived<Counts | null>(
		migration.state === "succeeded"
			? migration.targetCounts
			: latestProgress?.current.countsAuthoritative
				? {
						commits: latestProgress.current.commits,
						branches: latestProgress.current.branches,
						tags: latestProgress.current.tags,
						issues: latestProgress.current.issues,
						pullRequests: latestProgress.current.pullRequests,
						releases: latestProgress.current.releases,
					}
				: migration.targetCounts,
	);
	const progressSourceCounts = $derived(sourceCounts ?? migration.sourceCounts);
	const currentTarget = $derived(form?.currentTarget?.id === migration.id ? form.currentTarget : null);
	const footerCounts = $derived(displayTargetCounts ?? currentTarget?.counts);
	const completionResources = $derived<[string, number, UsedIconName][]>(
		footerCounts
			? [
					["Commits", footerCounts.commits, "git-commit"],
					["Branches", footerCounts.branches, "git-branch"],
					["Tags", footerCounts.tags, "tag"],
					["Issues", footerCounts.issues, "issue-opened"],
					["Pull requests", footerCounts.pullRequests, "git-pull-request"],
					["Releases", footerCounts.releases, "package"],
				]
			: [],
	);

	async function refreshMigration(migrationId = migration.id): Promise<boolean> {
		const sequence = ++pollSequence;
		const response = await fetch(`/api/migrate/${migrationId}`);
		if (!response.ok) return false;
		const next = (await response.json()) as Migration;
		if (data.migration.id !== migrationId || sequence !== pollSequence) return false;
		polledMigration = next;
		return true;
	}

	function startPolling(migrationId = migration.id) {
		if (pollInterval) clearInterval(pollInterval);
		pollInterval = setInterval(async () => {
			await refreshMigration(migrationId);
			if (!isActiveMigrationState(migration.state)) {
				if (pollInterval) clearInterval(pollInterval);
				pollInterval = null;
			}
		}, 5000);
	}

	async function confirmCancel() {
		cancelError = "";
		cancelSubmitting = true;
		try {
			const response = await fetch(`/api/migrate/${migration.id}`, { method: "DELETE" });
			if (!response.ok) {
				cancelError = `Failed to cancel migration: HTTP ${response.status}`;
				return;
			}
			if (data.scoped) await invalidateAll();
			else if (!(await refreshMigration())) {
				cancelError = "Cancellation was accepted, but migration state could not be refreshed";
				return;
			}
			if (!data.scoped) void refreshMigrations();
			showCancelDialog = false;
		} catch (error) {
			cancelError = error instanceof Error ? error.message : "Unknown error";
		} finally {
			cancelSubmitting = false;
		}
	}

	async function confirmReconciliation() {
		reconciliationError = "";
		reconciliationSubmitting = true;
		try {
			const response = await fetch(`/api/migrate/${migration.id}/confirm-restart`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ confirmation: reconciliationPhrase }),
			});
			const body = (await response.json().catch(() => ({}))) as Migration & { error?: string };
			if (!response.ok) {
				reconciliationError = body.error || `HTTP ${response.status}`;
				return;
			}
			polledMigration = body;
			showReconciliationDialog = false;
			resumeEventLog();
			void refreshMigrations();
		} catch (error) {
			reconciliationError = error instanceof Error ? error.message : "Status review failed";
		} finally {
			reconciliationSubmitting = false;
		}
	}

	function openRestartForm() {
		restartError = "";
		restart.reset();
		showRestartForm = true;
	}

	function resumeEventLog() {
		eventSource?.destroy();
		eventSource = createMigrationEventSource(migration.id, lastProcessedId ?? 0);
	}

	async function handleRestart(event?: SubmitEvent) {
		event?.preventDefault();
		restartError = "";
		restartSubmitting = true;
		try {
			const response = await fetch(`/api/migrate/${migration.id}/restart`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(data.scoped ? {} : restart.buildPayload()),
			});
			const body = (await response.json().catch(() => ({}))) as Migration & { error?: string };
			if (!response.ok) {
				restartError = body.error || `HTTP ${response.status}`;
				return;
			}
			if (data.scoped) {
				showRestartForm = false;
				await invalidateAll();
				return;
			}
			pollSequence += 1;
			polledMigration = body;
			showRestartForm = false;
			currentPhase = "PENDING_VALIDATION";
			latestProgress = null;
			sourceCounts = null;
			failureDetail = null;
			resumeEventLog();
			startPolling();
			void refreshMigrations();
		} catch (error) {
			restartError = error instanceof Error ? error.message : "Unknown error";
		} finally {
			restartSubmitting = false;
		}
	}

	const isRestartable = $derived(
		restartSupported && isRestartableMigrationState(migration.state),
	);
	const sourceRepoUrl = $derived(
		sourceProjectUrl(
			migration.sourceProvider,
			migration.sourceApiUrl,
			migration.sourceOrg,
			migration.sourceRepo,
		),
	);
	const targetRepoUrl = $derived(
		`${sourceBaseUrl(migration.targetApiUrl)}/${migration.targetOrg}/${migration.targetRepo}`,
	);
	let copiedId = $state(false);

	async function copyMigrationId() {
		if (!migration.githubMigrationId) return;
		try {
			await navigator.clipboard.writeText(migration.githubMigrationId);
			copiedId = true;
			setTimeout(() => (copiedId = false), 1500);
		} catch {
			// Clipboard access can be unavailable in insecure browser contexts.
		}
	}
</script>

<div class="space-y-6">
	<section
		class="min-w-0 border-b border-gray-700 pb-5"
		aria-labelledby="migration-route-heading"
	>
		<nav aria-label="Breadcrumb" class="mb-2">
			<a href="/migrate" class="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-blue-400">
				<Octicon name="chevron-left" size={16} />All migrations
			</a>
		</nav>
		<div class="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
			<div class="min-w-0">
				<h1 id="migration-route-heading" class="flex min-w-0 flex-col gap-1 text-xl text-gray-100 sm:flex-row sm:flex-wrap sm:items-center sm:gap-2">
					<a href={sourceRepoUrl} target="_blank" rel="noopener" class="min-w-0 break-all hover:text-blue-400 hover:underline">
						<span class="font-normal text-gray-400">{migration.sourceOrg}/</span><span class="font-semibold">{migration.sourceRepo}</span>
					</a>
					<span class="flex min-w-0 items-start gap-2">
						<span class="sr-only"> to </span>
						<Octicon name="arrow-right" size={16} class="mt-1 shrink-0 text-gray-600" />
						<a href={targetRepoUrl} target="_blank" rel="noopener" class="min-w-0 break-all hover:text-blue-400 hover:underline">
							<span class="font-normal text-gray-400">{migration.targetOrg}/</span><span class="font-semibold text-gray-300">{migration.targetRepo}</span>
						</a>
					</span>
				</h1>
				<div class="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-gray-500">
					<span class="inline-flex items-center gap-1.5 font-medium {stateMeta.text}">
						{#if stateMeta.pulse}
							<span class="relative flex h-2 w-2" aria-hidden="true">
								<span class="absolute inline-flex h-full w-full animate-ping rounded-full {stateMeta.dot} opacity-40"></span>
								<span class="relative inline-flex h-2 w-2 rounded-full {stateMeta.dot}"></span>
							</span>
						{:else}
							<Octicon name={STATE_ICONS[migration.state]} size={12} />
						{/if}
						{stateMeta.label}
					</span>
					<span class="inline-flex items-center gap-1"><Octicon name="clock" size={12} />Started {formatDateTime(migration.startedAt)}</span>
					<span class="inline-flex items-center gap-1"><Octicon name="stopwatch" size={12} />{formatElapsed(migration.elapsedSeconds)}</span>
					<span class="inline-flex items-center gap-1" title="{sourcePlatform.displayName} to {targetPlatform.displayName}">
						<Octicon name={sourcePlatform.icon} size={16} />{sourcePlatform.label}
						<Octicon name="arrow-right" size={12} class="text-gray-600" />
						<Octicon name={targetPlatform.icon} size={16} />{targetPlatform.label}
					</span>
					{#if migration.sourceSizeKb != null}<span>{formatRepoSize(migration.sourceSizeKb)}</span>{/if}
					{#if migration.warningsCount > 0}<span class="text-yellow-400">{migration.warningsCount} warnings</span>{/if}
					{#if migration.batchId}<a href="/migrate/batches/{migration.batchId}" class="text-blue-400 hover:underline">View batch</a>{/if}
				</div>
			</div>
			<div class="flex shrink-0 flex-wrap items-center gap-2">
				{#if migration.githubMigrationId}
					<button
						type="button"
						onclick={copyMigrationId}
						aria-label={copiedId ? "Migration ID copied" : "Copy migration ID"}
						title={copiedId ? "Copied" : "Copy migration ID"}
						class="inline-flex h-8 w-8 items-center justify-center rounded-md border border-gray-700 bg-gray-900 text-gray-400 transition-colors hover:border-gray-600 hover:bg-gray-800 hover:text-gray-100 focus-visible:outline-2 focus-visible:outline-blue-500"
					>
						<Octicon name={copiedId ? "check" : "copy"} size={16} />
					</button>
				{/if}
				{#if isActive && data.canCancel}
					<CompactButton
						aria-haspopup="dialog"
						aria-expanded={showCancelDialog}
						onclick={() => (showCancelDialog = true)}
						aria-label="Cancel migration">Cancel</CompactButton>
				{:else if !data.scoped && migration.state === "reconciliation_required" && restartSupported}
					<CompactButton
						aria-label="Review remote status"
						aria-haspopup="dialog"
						aria-expanded={showReconciliationDialog}
						onclick={() => (showReconciliationDialog = true)}>Review status</CompactButton>
				{:else if isRestartable && data.canRestart}
					<CompactButton
						aria-haspopup="dialog"
						aria-expanded={showRestartForm}
						onclick={openRestartForm}>Restart</CompactButton>
				{/if}
			</div>
		</div>
	</section>

	<div class="grid gap-6 lg:grid-cols-[15rem_minmax(0,1fr)] lg:items-start">
		<aside class="lg:border-r lg:border-gray-700 lg:pr-6">
			<MigrationProgress
				view="steps"
				currentPhase={displayedPhase}
				handoff={migration.state === "succeeded" ? null : handoff}
				failed={migration.state === "failed"}
				active={isActive}
				showComparison={false}
			/>
		</aside>

		<div class="min-w-0 space-y-6">
			{#if isActive && latestProgress}
				<MigrationProgress
					view="activity"
					currentPhase={displayedPhase}
					active
					progress={latestProgress}
					source={progressSourceCounts}
				/>
			{/if}

			<section aria-labelledby="event-log-title">
				<div class="mb-3 flex items-center justify-between gap-3">
					<h2 id="event-log-title" class="flex items-center gap-2 text-lg font-semibold text-gray-200">
						<Octicon name="log" size={16} class="text-gray-500" />Event log
					</h2>
					<div class="flex items-center gap-2">
						<span class="text-xs tabular-nums text-gray-500">{eventLog.length} events</span>
						<a href={`/api/migrate/${migration.id}/events?download=1`} download aria-label={data.scoped ? "Download recent event log" : "Download full event log"} title={data.scoped ? "Download recent event log (NDJSON)" : "Download full event log (NDJSON)"} class="inline-flex size-7 items-center justify-center rounded-md text-gray-400 hover:bg-gray-800 hover:text-gray-100 focus-visible:outline-2 focus-visible:outline-blue-500">
							<Octicon name="download" size={16} />
						</a>
					</div>
				</div>
				<div class="max-h-128 overflow-y-auto rounded-md border border-gray-700 bg-gray-950">
					{#each eventLog as event, index (event.id ?? index)}
						<div class="grid grid-cols-[minmax(11ch,max-content)_minmax(0,1fr)] gap-3 border-b border-gray-800/70 px-4 py-2 font-mono text-xs last:border-0 hover:bg-gray-900/60">
							<time datetime={event.createdAt} class="whitespace-nowrap tabular-nums text-gray-600">{new Date(event.createdAt).toLocaleTimeString()}</time>
							<span class="min-w-0 wrap-break-word text-gray-300">
								{#if event.eventType === "step"}
									{event.payload.message === "Auditing failed GHES import records" ? "Checking for GHES import errors" : event.payload.message || ""}
								{:else if event.eventType === "phase_change"}
									{event.payload.from} to {event.payload.to}
								{:else if event.eventType === "snapshot"}
									{event.phase}: {event.payload.progress.current.commits.toLocaleString()} commits,
									{event.payload.progress.current.issues.toLocaleString()} issues
								{:else if event.eventType === "complete"}
									Migration succeeded in {formatElapsed(event.payload.elapsed)}
								{:else if event.eventType === "failure"}
									{event.payload.error || event.payload.detail?.failureReason || "Migration failed"}
								{:else if event.eventType === "banner" || event.eventType === "milestone"}
									{event.payload.message}
								{:else if event.eventType === "restart"}
									{event.payload.message || "Migration restarted"}
								{/if}
							</span>
						</div>
					{/each}
					{#if eventLog.length === 0}
						<div class="px-4 py-3 text-center text-sm text-gray-500">{isActive ? "Waiting for events..." : "No events recorded"}</div>
					{/if}
				</div>
			</section>
	{#if migration.state === "succeeded"}
		<section aria-labelledby="target-contents-title" class="rounded-md border border-gray-700">
			<header class="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-gray-700 px-4 py-3">
				<h2 id="target-contents-title" class="flex items-center gap-2 text-lg font-semibold text-gray-200">
					<Octicon name="repo" size={16} class="text-gray-400" />Target repository contents
				</h2>
				{#if displayTargetCounts}<span class="text-sm text-gray-400">Recorded at completion</span>{/if}
			</header>
			{#if footerCounts}
				{#if !displayTargetCounts}
					<p class="px-4 py-2 text-sm text-gray-400">Current repository at this path, observed {currentTarget?.observedAt}. Totals at migration completion remain unknown.</p>
				{/if}
				<dl class="divide-y divide-gray-700">
					{#each completionResources as [label, count, icon] (label)}
						<div class="flex items-center justify-between gap-3 px-4 py-2">
							<dt class="flex items-center gap-2 text-sm text-gray-400"><Octicon name={icon} size={16} class="shrink-0" />{label}</dt>
							<dd class="whitespace-nowrap text-right text-lg font-semibold tabular-nums text-gray-100">{count.toLocaleString()}</dd>
						</div>
					{/each}
				</dl>
				<p class="border-t border-gray-700 px-4 py-2 text-sm text-gray-400">Commits count the default branch only.</p>
			{:else}
				<div class="p-4">
				<p class="text-sm text-gray-400">Migration completed, but target resource totals have not been collected.</p>
				{#if !data.scoped}
				<form method="POST" action="?/refreshCounts" class="mt-3 flex flex-wrap items-center gap-3" use:enhance={() => {
					countsSubmitting = true;
					return async ({ update }) => {
						try { await update(); } finally { countsSubmitting = false; }
					};
				}}>
					<button type="submit" disabled={countsSubmitting} class="h-9 rounded-md border border-gray-600 px-3 text-sm font-medium text-gray-200 hover:bg-gray-800 disabled:opacity-50">
						{countsSubmitting ? "Fetching counts..." : "Fetch counts"}
					</button>
					<p class="text-sm text-gray-400">Shows current counts only. Does not change the migration record.</p>
				</form>
				{/if}
				{#if form?.countsError}
					<p role="alert" class="mt-3 text-sm text-red-400">{form.countsError}</p>
				{/if}
				</div>
			{/if}
		</section>
	{/if}
		</div>
	</div>

	{#if migration.state === "failed" && failureDetail}
		<ErrorDetail detail={failureDetail} {migration} events={eventLog} />
	{:else if migration.state === "failed" && migration.failureReason}
		<details>
			<summary>Recorded failure</summary>
			<pre class="whitespace-pre-wrap break-words">{migration.failureReason}</pre>
		</details>
	{/if}

	<MigrationProgress
		view="comparison"
		currentPhase={displayedPhase}
		failed={migration.state === "failed"}
		active={isActive}
		progress={latestProgress}
		source={progressSourceCounts}
		target={displayTargetCounts}
		showComparison={migration.state !== "succeeded"}
	/>
</div>

{#if data.scoped}
<ConfirmDialog bind:open={showRestartForm} title="Restart migration?" confirmPhrase={reconciliationPhrase}
	submitLabel="Restart migration" submitting={restartSubmitting} error={restartError}
	inputId="restart-confirm" tone="warning" onConfirm={() => void handleRestart()}>
	{#snippet body()}<p>This restarts the migration to {reconciliationPhrase} using the assigned server credentials.</p>{/snippet}
</ConfirmDialog>
{:else}
<MigrationForm
	bind:open={showRestartForm}
	form={restart}
	submitting={restartSubmitting}
	error={restartError}
	title="Restart Migration"
	submitLabel="Restart Migration"
	sourceProvider={migration.sourceProvider}
	productionLockText="Source repository will be locked during migration and archived after success."
	{sourceEnvApp}
	{sourceEnvPat}
	{targetEnvApp}
	{targetEnvPat}
	allowOverride={page.data.allowCredentialOverride ?? true}
	onsubmit={handleRestart}
>
	{#snippet info()}
		<div class="rounded-md border border-gray-700/50 bg-gray-800/50 px-4 py-3 text-sm text-gray-300">
			{migration.sourceOrg}/{migration.sourceRepo} to {migration.targetOrg}/{migration.targetRepo}
			{#if !isGitHubCloud(migration.sourceApiUrl)}<p class="mt-1 text-xs text-gray-500">{migration.sourceApiUrl}</p>{/if}
		</div>
	{/snippet}
</MigrationForm>
{/if}

<ConfirmDialog
	bind:open={showCancelDialog}
	title="Cancel this migration?"
	confirmPhrase={cancelPhrase}
	submitLabel="Cancel Migration"
	cancelLabel="Keep running"
	submitting={cancelSubmitting}
	error={cancelError}
	inputId="cancel-confirm"
	onConfirm={confirmCancel}
>
	{#snippet body()}
		<p class="text-sm text-gray-300">
			This stops the migration of <span class="font-medium text-gray-50">{cancelPhrase}</span>.
			You can restart it afterwards from this page.
		</p>
	{/snippet}
</ConfirmDialog>

<ConfirmDialog
	bind:open={showReconciliationDialog}
	title="Review remote migration status"
	confirmPhrase={reconciliationPhrase}
	submitLabel="Confirm remote status"
	submitting={reconciliationSubmitting}
	error={reconciliationError}
	inputId="reconciliation-confirm"
	tone="warning"
	onConfirm={confirmReconciliation}
>
	{#snippet body()}
		<div class="space-y-3 text-sm text-gray-300">
			<p class="rounded-md border border-orange-500/30 bg-orange-500/10 px-4 py-3 text-orange-200">
				Verify in GitHub that no migration is active for <span class="font-mono">{reconciliationPhrase}</span>.
			</p>
			<p>This is a manual confirmation. The dashboard does not check the remote job. Confirm only after checking the destination; this enables Restart without starting a migration.</p>
		</div>
	{/snippet}
</ConfirmDialog>