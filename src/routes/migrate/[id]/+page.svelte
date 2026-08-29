<script lang="ts">
	import { onMount } from "svelte";
	import { page } from "$app/state";
	import ConfirmDialog from "$lib/components/ConfirmDialog.svelte";
	import ErrorDetail from "$lib/components/ErrorDetail.svelte";
	import MigrationForm from "$lib/components/migrate/MigrationForm.svelte";
	import MigrationProgress from "$lib/components/migrate/MigrationProgress.svelte";
	import Octicon from "$lib/components/Octicon.svelte";
	import { formatDateTime, formatElapsed, formatRepoSize } from "$lib/format";
	import { createMigrationEventSource, refreshMigrations } from "$lib/migrate/live.svelte";
	import { isGitHubCloud, STATE_ICONS, STATE_LABELS } from "$lib/migrate/migration-display";
	import { createMigrationForm } from "$lib/migrate/migration-form.svelte";
	import type {
		Counts,
		FailureDetail,
		Migration,
		MigrationEvent,
		Phase,
		Progress,
	} from "$lib/migrate/types";
	import { isActiveMigrationState, isRestartableMigrationState } from "$lib/migration-state";
	import { getTargetPlatformPresentation } from "$lib/migration-target";
	import { getSourceProviderAdapter, sourceBaseUrl, sourceProjectUrl } from "$lib/source-provider";

	let { data } = $props();
	let polledMigration = $state<Migration | null>(null);
	const freshMigration = $derived(
		polledMigration?.id === data.migration.id ? polledMigration : null,
	);
	const migration = $derived<Migration>(freshMigration ?? data.migration);
	const provider = $derived(getSourceProviderAdapter(migration.sourceProvider));
	const sourcePlatform = $derived(provider.sourcePlatform(migration.sourceApiUrl));
	const targetPlatform = $derived(getTargetPlatformPresentation(migration.targetPlatform));
	let eventLog = $state<MigrationEvent[]>([]);
	let currentPhase = $state<Phase>("PENDING_VALIDATION");
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
		polledMigration = null;
		eventLog = [...data.events];
		currentPhase = "PENDING_VALIDATION";
		latestProgress = null;
		sourceCounts = null;
		failureDetail = null;
		for (const event of data.events) processEvent(event);
		lastProcessedId = data.eventCursor || undefined;
		if (isActiveMigrationState(data.migration.state)) {
			eventSource = createMigrationEventSource(migrationId, data.eventCursor || undefined);
		}
		startPolling(migrationId);
		return () => {
			if (pollInterval) clearInterval(pollInterval);
			pollInterval = null;
			eventSource?.destroy();
			eventSource = null;
		};
	});

	onMount(() => restart.initAuthModes());

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
		if (event.phase) currentPhase = event.phase;
		if (event.eventType === "snapshot" || event.eventType === "complete") {
			latestProgress = event.payload.progress;
			if (event.payload.sourceCounts) sourceCounts = event.payload.sourceCounts;
		} else if (event.eventType === "failure" && event.payload.detail) {
			failureDetail = event.payload.detail;
		} else if (event.eventType === "restart") {
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
		latestProgress?.current
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
	const completionResources = $derived<[string, number][]>([
		["Commits", displayTargetCounts?.commits ?? 0],
		["Branches", displayTargetCounts?.branches ?? 0],
		["Tags", displayTargetCounts?.tags ?? 0],
		["Issues", displayTargetCounts?.issues ?? 0],
		["PRs", displayTargetCounts?.pullRequests ?? 0],
		["Releases", displayTargetCounts?.releases ?? 0],
	]);

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
			if (!(await refreshMigration())) {
				cancelError = "Cancellation was accepted, but migration state could not be refreshed";
				return;
			}
			void refreshMigrations();
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

	async function handleRestart(event: SubmitEvent) {
		event.preventDefault();
		restartError = "";
		restartSubmitting = true;
		try {
			const response = await fetch(`/api/migrate/${migration.id}/restart`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(restart.buildPayload()),
			});
			const body = (await response.json().catch(() => ({}))) as Migration & { error?: string };
			if (!response.ok) {
				restartError = body.error || `HTTP ${response.status}`;
				return;
			}
			pollSequence += 1;
			polledMigration = body;
			showRestartForm = false;
			currentPhase = "PENDING_VALIDATION";
			latestProgress = null;
			sourceCounts = null;
			failureDetail = null;
			eventSource?.destroy();
			eventSource = createMigrationEventSource(migration.id);
			startPolling();
			void refreshMigrations();
		} catch (error) {
			restartError = error instanceof Error ? error.message : "Unknown error";
		} finally {
			restartSubmitting = false;
		}
	}

	const isRestartable = $derived(
		provider.capabilities.restart && isRestartableMigrationState(migration.state),
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
		class="relative min-w-0 overflow-hidden rounded-md border border-gray-700 bg-gray-900"
		aria-labelledby="migration-route-heading"
	>
		<span class="absolute inset-y-0 left-0 w-1 {stateMeta.accent}"></span>
		<h1 id="migration-route-heading" class="sr-only">
			{migration.sourceOrg}/{migration.sourceRepo} to {migration.targetOrg}/{migration.targetRepo}
		</h1>
		<div
			class="grid grid-cols-[minmax(0,1fr)_2rem_minmax(0,1fr)] items-center gap-2 p-4 pl-5 md:grid-cols-[minmax(12rem,1fr)_3rem_minmax(12rem,1fr)_10rem] md:gap-4"
		>
			<div class="flex min-w-0 items-center gap-3">
				<Octicon name={sourcePlatform.icon} size={24} class="shrink-0 text-gray-400" />
				<div class="min-w-0">
					<div class="text-[10px] font-semibold uppercase text-gray-500">{sourcePlatform.label} source</div>
					<a
						href={sourceRepoUrl}
						target="_blank"
						rel="noopener"
						class="mt-1 block truncate font-semibold text-gray-50 hover:text-blue-400"
					>
						{migration.sourceOrg}/{migration.sourceRepo}
					</a>
				</div>
			</div>
			<div class="flex items-center text-gray-600">
				<span class="h-px flex-1 bg-gray-700"></span><Octicon name="chevron-right" size={16} />
			</div>
			<div class="flex min-w-0 items-center gap-3">
				<Octicon name={targetPlatform.icon} size={24} class="shrink-0 text-gray-400" />
				<div class="min-w-0">
					<div class="text-[10px] font-semibold uppercase text-gray-500">{targetPlatform.label} target</div>
					<a
						href={targetRepoUrl}
						target="_blank"
						rel="noopener"
						class="mt-1 block truncate font-semibold text-gray-300 hover:text-blue-400"
					>
						{migration.targetOrg}/{migration.targetRepo}
					</a>
				</div>
			</div>
			<div
				class="col-span-3 mt-1 flex items-center justify-between border-t border-gray-700/70 pt-3 md:col-span-1 md:mt-0 md:block md:border-t-0 md:border-l md:pt-0 md:pl-4"
			>
				<span class="inline-flex items-center gap-1.5 text-xs font-medium {stateMeta.text}">
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
				<span class="inline-flex items-center gap-1 text-sm text-gray-400 md:mt-2">
					<Octicon name="stopwatch" size={12} />{formatElapsed(migration.elapsedSeconds)}
				</span>
			</div>
		</div>

		<div class="flex flex-wrap items-center gap-2 border-t border-gray-700/70 px-5 py-2.5 text-xs text-gray-500">
			<span><Octicon name="clock" size={12} /> Started {formatDateTime(migration.startedAt)}</span>
			{#if migration.sourceSizeKb != null}<span>{formatRepoSize(migration.sourceSizeKb)}</span>{/if}
			{#if migration.warningsCount > 0}<span class="text-yellow-400">{migration.warningsCount} warnings</span>{/if}
			{#if migration.batchId}<a href="/migrate/batches/{migration.batchId}" class="text-blue-400">View batch</a>{/if}
			<div class="ml-auto flex flex-wrap items-center gap-2">
				{#if migration.githubMigrationId}
					<button type="button" onclick={copyMigrationId} class="rounded-md border border-gray-700 px-2 py-1">
						<Octicon name={copiedId ? "check" : "copy"} size={12} />{copiedId ? "Copied" : "Copy ID"}
					</button>
				{/if}
				{#if isActive}
					<button
						type="button"
						aria-haspopup="dialog"
						aria-expanded={showCancelDialog}
						onclick={() => (showCancelDialog = true)}
						class="rounded-md bg-red-500/10 px-2 py-1 text-red-400">Cancel migration</button
					>
				{:else if migration.state === "reconciliation_required" && provider.capabilities.restart}
					<button
						type="button"
						aria-haspopup="dialog"
						aria-expanded={showReconciliationDialog}
						onclick={() => (showReconciliationDialog = true)}
						class="rounded-md bg-orange-500/10 px-2 py-1 text-orange-300">Review remote status</button
					>
				{:else if isRestartable}
					<button
						type="button"
						aria-haspopup="dialog"
						aria-expanded={showRestartForm}
						onclick={openRestartForm}
						class="rounded-md bg-blue-500/10 px-2 py-1 text-blue-400">Restart</button
					>
				{/if}
			</div>
		</div>
	</section>

	<MigrationProgress
		currentPhase={displayedPhase}
		failed={migration.state === "failed"}
		active={isActive}
		progress={latestProgress}
		source={progressSourceCounts}
		target={displayTargetCounts}
		showComparison={migration.state !== "succeeded"}
	/>

	{#if migration.state === "succeeded"}
		<section class="rounded-md border border-green-500/30 bg-green-500/5 p-5">
			<h2 class="flex items-center gap-2 text-lg font-semibold text-green-400">
				<Octicon name="check-circle" size={24} />Resource Verification
			</h2>
			<p class="mt-1 text-sm text-gray-400">Migration completed. Target resource totals are shown below.</p>
			<div class="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
				{#each completionResources as resource (resource[0])}
					<div class="rounded-md bg-gray-900 px-3 py-4 text-center">
						<div class="text-xl font-bold text-gray-50">{resource[1].toLocaleString()}</div>
						<div class="text-xs text-gray-500">{resource[0]}</div>
					</div>
				{/each}
			</div>
		</section>
	{/if}

	{#if migration.state === "failed" && failureDetail}
		<ErrorDetail detail={failureDetail} {migration} events={eventLog} />
	{/if}

	<section>
		<h2 class="mb-3 flex items-center gap-2 text-lg font-semibold text-gray-300">
			<Octicon name="log" size={16} />Event Log
		</h2>
		<div class="max-h-96 overflow-y-auto rounded-md border border-gray-700 bg-gray-900">
			{#each eventLog as event, index (event.id ?? index)}
				<div class="flex items-start gap-3 border-b border-gray-800/50 px-4 py-2.5 last:border-0">
					<span class="mt-0.5 rounded bg-gray-800 px-1.5 py-0.5 text-xs text-gray-400">{event.eventType}</span>
					<span class="text-sm text-gray-300">
						{#if event.eventType === "step"}
							{event.payload.message || ""}
						{:else if event.eventType === "phase_change"}
							{event.payload.from} to {event.payload.to}
						{:else if event.eventType === "snapshot"}
							{event.phase}: {event.payload.progress.current.commits.toLocaleString()} commits,
							{event.payload.progress.current.issues.toLocaleString()} issues
						{:else if event.eventType === "complete"}
							Migration succeeded in {formatElapsed(event.payload.elapsed)}
						{:else if event.eventType === "failure"}
							{event.payload.error || event.payload.detail?.failureReason || "Migration failed"}
						{:else if event.eventType === "restart"}
							{event.payload.message || "Migration restarted"}
						{:else}
							{JSON.stringify(event.payload)}
						{/if}
					</span>
					<span class="ml-auto shrink-0 text-xs text-gray-600">{new Date(event.createdAt).toLocaleTimeString()}</span>
				</div>
			{/each}
			{#if eventLog.length === 0}
				<div class="px-4 py-8 text-center text-sm text-gray-500">{isActive ? "Waiting for events..." : "No events recorded"}</div>
			{/if}
		</div>
	</section>
</div>

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
			<p>This records your review and makes the migration eligible for restart. It does not start a migration.</p>
		</div>
	{/snippet}
</ConfirmDialog>