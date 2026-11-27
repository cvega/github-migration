<script lang="ts">
	import { onDestroy, onMount } from "svelte";
	import { goto, invalidateAll } from "$app/navigation";
	import { page } from "$app/state";
	import CompactButton from "$lib/components/CompactButton.svelte";
	import ConfirmDialog from "$lib/components/ConfirmDialog.svelte";
	import MigrationCard from "$lib/components/migrate/MigrationCard.svelte";
	import MigrationForm from "$lib/components/migrate/MigrationForm.svelte";
	import MigrationRouteStatus from "$lib/components/migrate/MigrationRouteStatus.svelte";
	import Octicon from "$lib/components/Octicon.svelte";
	import Pagination from "$lib/components/Pagination.svelte";
	import { formatDateTime } from "$lib/format";
	import { createGlobalEventSource } from "$lib/migrate/live.svelte";
	import { STATE_LABELS } from "$lib/migrate/migration-display";
	import { createMigrationForm } from "$lib/migrate/migration-form.svelte";
	import { pollScopedPage } from "$lib/migrate/scoped-poll";
	import type { Counts, Migration, Snapshot } from "$lib/migrate/types";
	import { getTargetPlatformPresentation } from "$lib/migration-target";
	import { getSourceProviderAdapter } from "$lib/source-provider";

	let { data } = $props();

	const batch = $derived(data.batch);
	const migrationsResult = $derived(data.migrations);
	const queueBlocked = $derived(
		!batch.mixedRoute && batch.sourceProvider === "bitbucket-server" && batch.targetPlatform === "ghes" &&
			batch.queuedCount > 0 && (batch.failedCount > 0 || batch.reconciliationRequiredCount > 0),
	);
	const isActive = $derived(
		batch.queuedCount > 0 ||
			batch.pendingCount > 0 ||
			batch.runningCount > 0 ||
			batch.cancellingCount > 0,
	);
	const activeCount = $derived(
		batch.queuedCount + batch.pendingCount + batch.runningCount + batch.cancellingCount,
	);
	const resolvedCount = $derived(
		batch.succeededCount +
			batch.failedCount +
			batch.cancelledCount +
			batch.reconciliationRequiredCount,
	);
	const percentComplete = $derived(
		batch.totalCount > 0 ? Math.round((resolvedCount / batch.totalCount) * 100) : 0,
	);
	const restartableCount = $derived(data.restartableCount);
	const restartLabel = $derived(
		batch.failedCount > 0 && batch.cancelledCount > 0
			? `Restart ${restartableCount} Failed/Cancelled`
			: batch.cancelledCount > 0
				? `Restart ${restartableCount} Cancelled`
				: `Restart ${restartableCount} Failed`,
	);
	const sourcePlatform = $derived(
		getSourceProviderAdapter(batch.sourceProvider).sourcePlatform(batch.sourceApiUrl),
	);
	const targetPlatform = $derived(getTargetPlatformPresentation(batch.targetPlatform));
	const sortOrder: Record<Migration["state"], number> = {
		running: 0,
		cancelling: 1,
		pending: 2,
		queued: 3,
		reconciliation_required: 4,
		failed: 5,
		succeeded: 6,
		cancelled: 7,
	};
	const sortedMigrations = $derived(
		[...migrationsResult.data].sort(
			(left, right) => sortOrder[left.state] - sortOrder[right.state],
		),
	);

	let globalSSE = $state.raw<ReturnType<typeof createGlobalEventSource> | null>(null);
	let refreshTimer: ReturnType<typeof setTimeout> | null = null;
	let now = $state(Date.now());

	const liveById = $derived.by(() => {
		const live: Record<string, { snapshot: Snapshot; sourceCounts: Counts | null }> = {};
		for (const event of globalSSE?.events ?? []) {
			if (event.eventType === "snapshot") {
				live[event.migrationId] = {
					snapshot: event.payload.progress.current,
					sourceCounts: event.payload.sourceCounts,
				};
			}
		}
		return live;
	});

	$effect(() => {
		const latestEvent = globalSSE?.events.at(-1);
		if (!latestEvent) return;
		if (refreshTimer) clearTimeout(refreshTimer);
		refreshTimer = setTimeout(() => {
			refreshTimer = null;
			void invalidateAll();
		}, 300);
	});

	let showCancelDialog = $state(false);
	let cancelSubmitting = $state(false);
	let cancelError = $state("");
	let showRestartForm = $state(false);
	let restartSubmitting = $state(false);
	let restartError = $state("");
	let restartResult = $state<{
		restarted: number;
		errors: Array<{ id: string; error: string }>;
	} | null>(null);

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

	onMount(() => {
		restart.initAuthModes();
		const stopPoll = data.scoped ? pollScopedPage() : undefined;
		if (!data.scoped) globalSSE = createGlobalEventSource();
		const tick = setInterval(() => {
			now = Date.now();
		}, 1000);
		return () => { clearInterval(tick); stopPoll?.(); };
	});

	onDestroy(() => {
		globalSSE?.destroy();
		if (refreshTimer) clearTimeout(refreshTimer);
	});

	function openCancelDialog() {
		cancelError = "";
		showCancelDialog = true;
	}

	async function confirmCancelAll() {
		cancelSubmitting = true;
		cancelError = "";
		try {
			const response = await fetch(`/api/migrate/batches/${batch.id}`, { method: "DELETE" });
			if (!response.ok) {
				const result = (await response.json().catch(() => null)) as { error?: string } | null;
				cancelError = result?.error ?? `Failed to cancel batch: HTTP ${response.status}`;
				return;
			}
			await invalidateAll();
			showCancelDialog = false;
		} catch (error) {
			cancelError = error instanceof Error ? error.message : "Unknown error";
		} finally {
			cancelSubmitting = false;
		}
	}

	function openRestartForm() {
		restartError = "";
		restartResult = null;
		restart.reset();
		showRestartForm = true;
	}

	async function handleBatchRestart(event: SubmitEvent) {
		event.preventDefault();
		restartSubmitting = true;
		restartError = "";
		restartResult = null;
		try {
			const response = await fetch(`/api/migrate/batches/${batch.id}/restart`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(restart.buildPayload()),
			});
			if (!response.ok) {
				const result = (await response.json().catch(() => null)) as { error?: string } | null;
				restartError = result?.error ?? `Failed to restart batch: HTTP ${response.status}`;
				return;
			}
			restartResult = await response.json();
			await invalidateAll();
			if (restartResult?.errors.length === 0) showRestartForm = false;
		} catch (error) {
			restartError = error instanceof Error ? error.message : "Unknown error";
		} finally {
			restartSubmitting = false;
		}
	}

	async function goPage(nextPage: number) {
		const params = new URLSearchParams(page.url.searchParams.toString());
		params.set("page", String(nextPage));
		await goto(`?${params.toString()}`, { reset: false });
		window.scrollTo(0, 0);
	}
</script>

<div class="space-y-6">
	<header class="flex flex-wrap items-start justify-between gap-4">
		<div>
			<div class="flex flex-wrap items-center gap-3">
				<Octicon name="stack" size={16} class="text-gray-400" />
				<h1 class="text-2xl font-bold text-gray-50">Batch Migration</h1>
				{#if queueBlocked}
					<span class="text-xs font-medium text-yellow-400">Queue paused</span>
				{:else if isActive}
					<span class="inline-flex items-center gap-1.5 text-xs font-medium text-green-400">
						<span class="relative flex h-2 w-2" aria-hidden="true">
							<span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-40 motion-reduce:animate-none"></span>
							<span class="relative inline-flex h-2 w-2 rounded-full bg-green-400"></span>
						</span>
						In Progress
					</span>
				{:else}
					<span class="inline-flex items-center gap-1 rounded-full bg-gray-500/15 px-2.5 py-0.5 text-xs font-medium text-gray-400">
						<Octicon name="check-circle" size={12} />Complete
					</span>
				{/if}
			</div>
			<div class="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-gray-500">
				<span class="inline-flex items-center gap-1.5">
					<Octicon name="repo" size={12} />
					<strong class="font-semibold tabular-nums text-gray-200">{batch.totalCount}</strong>
					{batch.totalCount === 1 ? "repository" : "repositories"}
				</span>
				<span class="inline-flex items-center gap-1.5" title="{sourcePlatform.displayName} to {targetPlatform.displayName}">
					<Octicon name={sourcePlatform.icon} size={12} />{sourcePlatform.label}
					<Octicon name="arrow-right" size={12} class="text-gray-600" />
					<Octicon name={targetPlatform.icon} size={12} />{targetPlatform.label}
				</span>
				<time datetime={batch.startedAt} class="inline-flex items-center gap-1.5">
					<Octicon name="clock" size={12} />Started {formatDateTime(batch.startedAt)}
				</time>
			</div>
		</div>
		<div class="flex flex-wrap items-center gap-x-4 gap-y-2">
			{#if !data.scoped}<MigrationRouteStatus routes={[batch]} />{/if}
		</div>
	</header>

	<section aria-labelledby="batch-progress-title" class="rounded-md border border-gray-700 bg-gray-950/40 p-4">
		<div class="flex items-center justify-between gap-4">
			<h2 id="batch-progress-title" class="text-sm font-semibold text-gray-200">Batch progress</h2>
			<strong class="text-sm tabular-nums text-gray-100">{percentComplete}%</strong>
		</div>
		{#if queueBlocked}
			<p class="mt-2 text-sm text-yellow-400">
				Queued repositories in this batch are waiting.
				{#if batch.reconciliationRequiredCount > 0}Review the migrations marked for reconciliation and confirm they are safe to restart.{/if}
				Restart failed migrations to resume the queue.
			</p>
		{/if}
		<div
			class="mt-2 h-2 overflow-hidden rounded-full bg-gray-800"
			role="progressbar"
			aria-label="Batch progress"
			aria-valuemin="0"
			aria-valuemax="100"
			aria-valuenow={percentComplete}
		>
			<div class="h-full rounded-full bg-green-500" style:width={`${percentComplete}%`}></div>
		</div>
		<div class="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
			<div class="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs tabular-nums">
				<span class="text-gray-400"><strong class="text-gray-200">{resolvedCount}</strong> of {batch.totalCount} resolved</span>
				{#if batch.succeededCount > 0}<span class="inline-flex items-center gap-1.5 text-green-400"><Octicon name="check-circle-fill" size={12} /><strong>{batch.succeededCount}</strong> succeeded</span>{/if}
				{#if batch.runningCount > 0}<span class="inline-flex items-center gap-1.5 text-green-400"><Octicon name="sync" size={12} /><strong>{batch.runningCount}</strong> running</span>{/if}
				{#if batch.cancellingCount > 0}<span class="inline-flex items-center gap-1.5 text-cyan-400"><Octicon name="stop" size={12} /><strong>{batch.cancellingCount}</strong> {STATE_LABELS.cancelling.toLowerCase()}</span>{/if}
				{#if batch.pendingCount > 0}<span class="inline-flex items-center gap-1.5 text-yellow-400"><Octicon name="clock" size={12} /><strong>{batch.pendingCount}</strong> {STATE_LABELS.pending.toLowerCase()}</span>{/if}
				{#if batch.queuedCount > 0}<span class="inline-flex items-center gap-1.5 text-violet-400"><Octicon name="hourglass" size={12} /><strong>{batch.queuedCount}</strong> {STATE_LABELS.queued.toLowerCase()}</span>{/if}
				{#if batch.failedCount > 0}<span class="inline-flex items-center gap-1.5 text-red-400"><Octicon name="x-circle-fill" size={12} /><strong>{batch.failedCount}</strong> failed</span>{/if}
				{#if batch.cancelledCount > 0}<span class="inline-flex items-center gap-1.5 text-gray-400"><Octicon name="skip" size={12} /><strong>{batch.cancelledCount}</strong> cancelled</span>{/if}
				{#if batch.reconciliationRequiredCount > 0}<span class="inline-flex items-center gap-1.5 text-orange-400"><Octicon name="alert" size={12} /><strong>{batch.reconciliationRequiredCount}</strong> review required</span>{/if}
			</div>

			{#if !data.scoped && (restartableCount > 0 || isActive)}
				<div class="flex shrink-0 flex-wrap items-center gap-2">
					{#if restartableCount > 0}
						<button type="button" onclick={openRestartForm} class="batch-action batch-action-default"><Octicon name="sync" size={16} />{restartLabel}</button>
					{/if}
					{#if isActive}
						<CompactButton aria-haspopup="dialog" aria-expanded={showCancelDialog} onclick={openCancelDialog}>Cancel all</CompactButton>
					{/if}
				</div>
			{/if}
		</div>
	</section>

	<section aria-labelledby="batch-repositories-title">
		<div class="mb-3 flex flex-wrap items-center justify-between gap-2">
			<h2 id="batch-repositories-title" class="flex items-center gap-2 text-lg font-semibold text-gray-100"><Octicon name="repo" size={16} />Repository migrations</h2>
			<span class="text-xs text-gray-500">{migrationsResult.total.toLocaleString()} total</span>
		</div>
		<div class="space-y-3">
			{#each sortedMigrations as migration (migration.id)}
				<MigrationCard migration={migration} live={liveById[migration.id]} {now} />
			{:else}
				<div class="rounded-md border border-gray-700 bg-gray-900 px-5 py-10 text-center text-sm text-gray-500">No migrations on this page.</div>
			{/each}
		</div>
		<Pagination page={migrationsResult.page} totalPages={migrationsResult.totalPages} total={migrationsResult.total} limit={migrationsResult.limit} onPageChange={goPage} />
	</section>

	<div class="flex justify-center">
		<CompactButton href="/migrate">Back to dashboard</CompactButton>
	</div>
</div>

<MigrationForm
	bind:open={showRestartForm}
	form={restart}
	submitting={restartSubmitting}
	error={restartError}
	title="Restart Failed Migrations"
	submitLabel={`Restart ${restartableCount} Migration${restartableCount === 1 ? "" : "s"}`}
	sourceProvider={data.sourceProvider}
	productionLockText="Source repositories will be locked during migration and archived after success."
	directPassthroughLabel="Direct transfer (skip download/upload)"
	sslVerifyLabel="Skip SSL verification (self-signed certs)"
	visibilityId="batch-restart-visibility"
	{sourceEnvApp}
	{sourceEnvPat}
	{targetEnvApp}
	{targetEnvPat}
	allowOverride={page.data.allowCredentialOverride ?? true}
	onsubmit={handleBatchRestart}
>
	{#snippet info()}
		<div class="rounded-md border border-gray-700/50 bg-gray-800/50 px-4 py-3 text-sm text-gray-300">
			Restarting <strong class="text-gray-50">{restartableCount}</strong> failed or cancelled migration{restartableCount === 1 ? "" : "s"} in this batch.
			{#if restart.state.useSavedOptions && data.savedInsecureSourceTls}<p class="mt-1 text-amber-300">Saved options disable source TLS certificate verification for one or more migrations.</p>{/if}
		</div>
		{#if restartResult}
			<div class="rounded-md border border-green-500/30 bg-green-500/10 px-4 py-3 text-sm text-green-400">
				<p>{restartResult.restarted} migration(s) restarted successfully.</p>
				{#if restartResult.errors.length > 0}
					<p class="mt-1 text-red-400">{restartResult.errors.length} failed:</p>
					<ul class="mt-1 list-inside list-disc text-xs text-red-300">
						{#each restartResult.errors as resultError (resultError.id)}
							<li>{resultError.id}: {resultError.error}</li>
						{/each}
					</ul>
				{/if}
			</div>
		{/if}
	{/snippet}
</MigrationForm>

<ConfirmDialog
	bind:open={showCancelDialog}
	title="Cancel active migrations?"
	confirmPhrase="cancel"
	caseSensitive={false}
	submitLabel={`Cancel ${activeCount} Migration${activeCount === 1 ? "" : "s"}`}
	submitting={cancelSubmitting}
	error={cancelError}
	inputId="batch-cancel-confirm"
	onConfirm={confirmCancelAll}
>
	{#snippet body()}
		<p class="text-sm text-gray-300">
			This will cancel <strong class="text-gray-50">{activeCount}</strong> active migration{activeCount === 1 ? "" : "s"} in this batch. Completed migrations are not affected.
		</p>
	{/snippet}
</ConfirmDialog>

<style>
	.batch-action {
		display: inline-flex;
		height: 2rem;
		align-items: center;
		justify-content: center;
		gap: 0.375rem;
		padding-inline: 0.75rem;
		border: 1px solid;
		border-radius: 0.375rem;
		box-shadow: var(--button-default-shadow-resting);
		font-size: 0.875rem;
		font-weight: 600;
		white-space: nowrap;
	}

	.batch-action:focus-visible {
		outline: 2px solid var(--fgColor-accent);
		outline-offset: 2px;
	}

	.batch-action-default {
		border-color: var(--button-default-borderColor-rest);
		background: var(--button-default-bgColor-rest);
		color: var(--button-default-fgColor-rest);
	}

	.batch-action-default:hover {
		background: var(--button-default-bgColor-hover);
	}

	.batch-action-default:active {
		background: var(--button-default-bgColor-active);
	}

</style>