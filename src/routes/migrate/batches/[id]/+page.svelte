<!-- Batch detail page -->
<script lang="ts">
	import { getContext, onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import AuthPill from '$lib/components/AuthPill.svelte';
	import CancelConfirmModal from '$lib/components/CancelConfirmModal.svelte';
	import GitHubStatus from '$lib/components/GitHubStatus.svelte';
	import Octicon from '$lib/components/Octicon.svelte';
	import Pagination from '$lib/components/Pagination.svelte';
	import RestartModal from '$lib/components/RestartModal.svelte';
	import { AUTH_PILL_KEY, type AuthPillContext, GH_STATUS_KEY, type GhStatusContext } from '$lib/context-keys';
	import { formatDateTime, formatElapsed } from '$lib/format';
	import { isGitHubCloud, STATE_ICONS, STATE_STYLES } from '$lib/migration-display';
	import { createMigrationForm } from '$lib/migration-form.svelte';
	import type { BatchListItem, Migration, PaginatedResult } from '$lib/types';

	const ghStatusCtx = getContext<GhStatusContext>(GH_STATUS_KEY);
	const auth = getContext<AuthPillContext>(AUTH_PILL_KEY);

	let { data } = $props();

	let polledBatch = $state<BatchListItem | null>(null);
	let polledMigrations = $state<PaginatedResult<Migration> | null>(null);

	let batch = $derived<BatchListItem>(polledBatch ?? data.batch);
	let migrationsResult = $derived<PaginatedResult<Migration>>(polledMigrations ?? data.migrations);

	// Poll for updates.
	let interval: ReturnType<typeof setInterval>;
	const currentPage = $derived(migrationsResult.page);

	// ── Restart modal state ────────────────────────────────────────────────
	let showRestartModal = $state(false);
	let restartSubmitting = $state(false);
	let restartError = $state('');
	let restartResult = $state<{ restarted: number; errors: Array<{ id: string; error: string }> } | null>(null);

	// ── Cancel-all modal state ─────────────────────────────────────────────
	let showCancelModal = $state(false);
	let cancelSubmitting = $state(false);
	let cancelError = $state('');
	const activeCount = $derived(batch.queuedCount + batch.pendingCount + batch.runningCount);
	// Bulk cancel spans many repos (and the batch id is a UUID), so confirm with
	// a fixed keyword rather than a repo name.
	const cancelPhrase = 'cancel';

	const sourceEnvApp = $derived(page.data.sourceAuth?.mode === 'github-app');
	const targetEnvApp = $derived(page.data.targetAuth?.mode === 'github-app');
	const sourceEnvPat = $derived(!!page.data.sourceAuth?.hasEnvPat);
	const targetEnvPat = $derived(!!page.data.targetAuth?.hasEnvPat);

	const restart = createMigrationForm(() => ({
		sourceEnvApp,
		sourceEnvPat,
		targetEnvApp,
		targetEnvPat,
	}));

	const restartableCount = $derived(batch.failedCount + batch.cancelledCount);
	const restartLabel = $derived.by(() => {
		if (batch.failedCount > 0 && batch.cancelledCount > 0)
			return `Restart ${restartableCount} Failed/Cancelled`;
		if (batch.cancelledCount > 0)
			return `Restart ${restartableCount} Cancelled`;
		return `Restart ${restartableCount} Failed`;
	});

	onMount(() => {
		refreshBatch();   // immediate fetch so we never show stale SSR data
		startPolling();

		restart.initAuthModes();

		// Refresh when user returns to this tab (e.g. after restarting from detail page).
		document.addEventListener('visibilitychange', onVisible);

		return () => {
			if (interval) clearInterval(interval);
			document.removeEventListener('visibilitychange', onVisible);
		};
	});

	function onVisible() {
		if (document.visibilityState === 'visible') {
			refreshBatch();
			if (batch.queuedCount > 0 || batch.pendingCount > 0 || batch.runningCount > 0) {
				startPolling();
			}
		}
	}

	async function refreshBatch() {
		const res = await fetch(`/api/migrate/batches/${batch.id}?page=${currentPage}&limit=${migrationsResult.limit}`);
		if (res.ok) {
			const result = await res.json();
			polledBatch = result.summary;
			polledMigrations = result.migrations;
		}
	}

	function startPolling() {
		if (interval) clearInterval(interval);
		interval = setInterval(async () => {
			const res = await fetch(`/api/migrate/batches/${batch.id}?page=${currentPage}&limit=${migrationsResult.limit}`);
			if (res.ok) {
				const result = await res.json();
				polledBatch = result.summary;
				polledMigrations = result.migrations;
			}
			if (batch.queuedCount === 0 && batch.pendingCount === 0 && batch.runningCount === 0) {
				clearInterval(interval);
			}
		}, 3000);
	}

	const isActive = $derived(batch.queuedCount > 0 || batch.pendingCount > 0 || batch.runningCount > 0);
	const barTotal = $derived(batch.totalCount || 1);
	const pctComplete = $derived(
		batch.totalCount > 0
			? Math.round(((batch.succeededCount + batch.failedCount + batch.cancelledCount) / batch.totalCount) * 100)
			: 0
	);
	const barSegments = $derived.by(() => {
		const segs: Array<{ key: string; color: string; pct: number; topInset: string; bottomInset: string }> = [];
		if (batch.succeededCount > 0) segs.push({ key: 'succeeded', color: '#22c55e', pct: (batch.succeededCount / barTotal) * 100, topInset: '1px', bottomInset: '1px' });
		if (batch.runningCount > 0)   segs.push({ key: 'running', color: '#3b82f6', pct: (batch.runningCount / barTotal) * 100, topInset: '1px', bottomInset: '1px' });
		if (batch.pendingCount > 0)   segs.push({ key: 'pending', color: '#facc15', pct: (batch.pendingCount / barTotal) * 100, topInset: '2px', bottomInset: '1px' });
		if (batch.queuedCount > 0)    segs.push({ key: 'queued', color: '#8b5cf6', pct: (batch.queuedCount / barTotal) * 100, topInset: '1px', bottomInset: '1px' });
		if (batch.failedCount > 0)    segs.push({ key: 'failed', color: '#ef4444', pct: (batch.failedCount / barTotal) * 100, topInset: '2px', bottomInset: '1px' });
		if (batch.cancelledCount > 0) segs.push({ key: 'cancelled', color: '#4b5563', pct: (batch.cancelledCount / barTotal) * 100, topInset: '1px', bottomInset: '1px' });
		let left = 0;
		return segs.map(s => { const seg = { ...s, left }; left += s.pct; return seg; });
	});

	function openCancelModal() {
		cancelError = '';
		cancelSubmitting = false;
		showCancelModal = true;
	}

	async function confirmCancelAll() {
		cancelError = '';
		cancelSubmitting = true;
		try {
			const cancelRes = await fetch(`/api/migrate/batches/${batch.id}`, { method: 'DELETE' });
			if (!cancelRes.ok) {
				cancelError = `Failed to cancel batch: HTTP ${cancelRes.status}`;
				return;
			}
			// Refresh
			const res = await fetch(`/api/migrate/batches/${batch.id}?page=${currentPage}&limit=${migrationsResult.limit}`);
			if (res.ok) {
				const result = await res.json();
				polledBatch = result.summary;
				polledMigrations = result.migrations;
			}
			showCancelModal = false;
		} catch (err) {
			cancelError = err instanceof Error ? err.message : 'Unknown error';
		} finally {
			cancelSubmitting = false;
		}
	}

	function openRestartModal() {
		restartError = '';
		restartResult = null;
		restartSubmitting = false;
		restart.reset();
		showRestartModal = true;
	}

	async function handleBatchRestart(e: Event) {
		e.preventDefault();
		restartError = '';
		restartResult = null;
		restartSubmitting = true;

		try {
			const res = await fetch(`/api/migrate/batches/${batch.id}/restart`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(restart.buildPayload()),
			});

			if (!res.ok) {
				const data = await res.json();
				restartError = data.error || `HTTP ${res.status}`;
				return;
			}

			restartResult = await res.json();

			// Refresh batch data and restart polling.
			const refreshRes = await fetch(`/api/migrate/batches/${batch.id}?page=${currentPage}&limit=${migrationsResult.limit}`);
			if (refreshRes.ok) {
				const result = await refreshRes.json();
				polledBatch = result.summary;
				polledMigrations = result.migrations;
			}
			startPolling();

			// Auto-close if no errors.
			if (!restartResult?.errors?.length) {
				showRestartModal = false;
			}
		} catch (err) {
			restartError = err instanceof Error ? err.message : 'Unknown error';
		} finally {
			restartSubmitting = false;
		}
	}

	// Sort: running first, then pending, then queued, then failed, then succeeded, then cancelled.
	const sortOrder: Record<string, number> = { running: 0, pending: 1, queued: 2, failed: 3, succeeded: 4, cancelled: 5 };
	const sortedMigrations = $derived(
		[...migrationsResult.data].sort((a, b) => (sortOrder[a.state] ?? 5) - (sortOrder[b.state] ?? 5))
	);

	function goPage(p: number) {
		polledBatch = null;
		polledMigrations = null;
		const params = new URLSearchParams(page.url.searchParams);
		params.set('page', String(p));
		goto(`?${params.toString()}`, { keepFocus: true, noScroll: false });
	}
</script>

<div class="space-y-6">
	{#snippet platformPill(apiUrl: string)}
		{@const isCloud = isGitHubCloud(apiUrl)}
		<span
			class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium align-middle {isCloud ? 'bg-blue-500/15 text-blue-400' : 'bg-purple-500/15 text-purple-400'}"
			title={isCloud ? 'GitHub Enterprise Cloud' : 'GitHub Enterprise Server'}>
			<Octicon name={isCloud ? 'cloud' : 'server'} size={12} />{isCloud ? 'GHEC' : 'GHES'}
		</span>
	{/snippet}
	<!-- Header -->
	<div class="flex items-start justify-between">
		<div>
			<div class="flex items-center gap-3">
				<Octicon name="stack" size={16} class="text-gray-400" />
				<h1 class="text-2xl font-bold text-gray-50">Batch Migration</h1>
				{#if isActive}
					<span class="inline-flex items-center gap-1 rounded-full bg-blue-500/15 px-2.5 py-0.5 text-xs font-medium text-blue-400 animate-pulse">
						<Octicon name="sync" size={12} />
						In Progress
					</span>
				{:else}
					<span class="inline-flex items-center gap-1 rounded-full bg-gray-500/15 px-2.5 py-0.5 text-xs font-medium text-gray-400">
						<Octicon name="check-circle" size={12} />
						Complete
					</span>
				{/if}
			</div>
			<p class="mt-1 text-sm text-gray-400">
				{batch.totalCount} repositories · started {new Date(batch.startedAt).toLocaleString()}
			</p>
		</div>
		<div class="flex items-center gap-2">
			<AuthPill label="Source" isApp={auth.sourceApp} rateText={auth.sourceRateText} ratePct={auth.sourceRatePct} migrating={auth.migrating} />
			<AuthPill label="Target" isApp={auth.targetApp} rateText={auth.targetRateText} ratePct={auth.targetRatePct} migrating={auth.migrating} />
			<GitHubStatus status={ghStatusCtx.value} />
		</div>
	</div>

	<!-- Overall progress -->
	<div class="rounded-md border border-gray-700 bg-gray-900 p-5">
		<div class="flex items-center justify-between mb-3">
			<span class="text-sm font-medium text-gray-300">Overall Progress</span>
			<span class="text-sm text-gray-400">{pctComplete}% complete</span>
		</div>

		<!-- Stacked progress bar -->
		<div style="position: relative; height: 16px; border-radius: 8px; overflow: hidden; background: #1f2937;">
			{#each barSegments as seg (seg.key)}
				<div style="position: absolute; top: {seg.topInset}; bottom: {seg.bottomInset}; left: {seg.left}%; width: {seg.pct}%; background: {seg.color};"></div>
			{/each}
		</div>

		<!-- Stats row -->
		<div class="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
			<div class="flex flex-wrap gap-4 text-sm">
				{#if batch.succeededCount > 0}
					<span class="inline-flex items-center gap-1 text-green-400"><Octicon name="check-circle" size={12} />{batch.succeededCount} succeeded</span>
				{/if}
				{#if batch.runningCount > 0}
					<span class="inline-flex items-center gap-1 text-blue-400"><Octicon name="sync" size={12} />{batch.runningCount} running</span>
				{/if}
				{#if batch.pendingCount > 0}
					<span class="inline-flex items-center gap-1 text-yellow-400"><Octicon name="clock" size={12} />{batch.pendingCount} pending</span>
				{/if}
				{#if batch.queuedCount > 0}
					<span class="inline-flex items-center gap-1 text-violet-400"><Octicon name="hourglass" size={12} />{batch.queuedCount} queued</span>
				{/if}
				{#if batch.failedCount > 0}
					<span class="inline-flex items-center gap-1 text-red-400"><Octicon name="x-circle-fill" size={12} />{batch.failedCount} failed</span>
				{/if}
				{#if batch.cancelledCount > 0}
					<span class="inline-flex items-center gap-1 text-gray-400"><Octicon name="skip" size={12} />{batch.cancelledCount} cancelled</span>
				{/if}
			</div>
			{#if restartableCount > 0 || isActive}
				<div class="flex items-center gap-2">
					{#if restartableCount > 0}
						<button type="button" onclick={openRestartModal}
							class="flex items-center gap-1.5 rounded-md border border-blue-500/30 bg-blue-500/10 px-3 py-1.5 text-xs font-medium text-blue-400 hover:bg-blue-500/20 transition-colors">
							<Octicon name="sync" size={12} />
							{restartLabel}
						</button>
					{/if}
					{#if isActive}
						<button type="button" onclick={openCancelModal}
							class="flex items-center gap-1.5 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-xs font-medium text-red-400 hover:bg-red-500/20 transition-colors">
							<Octicon name="x-circle" size={12} />
							Cancel All
						</button>
					{/if}
				</div>
			{/if}
		</div>
	</div>


	<!-- Migrations table -->
	<div class="rounded-md border border-gray-700 bg-gray-900 overflow-hidden">
		<table class="w-full text-sm">
			<thead>
				<tr class="border-b border-gray-700 text-gray-400">
					<th class="px-4 py-3 text-left font-medium">Repository</th>
					<th class="px-4 py-3 text-left font-medium">Target</th>
					<th class="px-4 py-3 text-center font-medium">Status</th>
					<th class="px-4 py-3 text-right font-medium">Duration</th>
					<th class="px-4 py-3 text-right font-medium">Warnings</th>
				</tr>
			</thead>
			<tbody>
				{#each sortedMigrations as migration (migration.id)}
					<tr class="border-b border-gray-800/50 last:border-0 hover:bg-gray-800/30 transition-colors">
						<td class="px-4 py-3">
							<span class="inline-flex items-center gap-2">
								{@render platformPill(migration.sourceApiUrl)}
								<a href="/migrate/{migration.id}" class="text-gray-50 hover:text-blue-400 transition-colors">
									{migration.sourceOrg}/{migration.sourceRepo}
								</a>
							</span>
						</td>
						<td class="px-4 py-3 text-gray-400">
							<span class="inline-flex items-center gap-2">
								{@render platformPill('https://api.github.com')}
								<span>{migration.targetOrg}/{migration.targetRepo}</span>
							</span>
						</td>
						<td class="px-4 py-3 text-center">
							<span class="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium {STATE_STYLES[migration.state]}">
								<Octicon name={STATE_ICONS[migration.state]} size={12} class={migration.state === 'running' ? 'animate-spin' : ''} />
								{migration.state}
							</span>
						</td>
						<td class="px-4 py-3 text-right text-gray-400">
							<span class="inline-flex items-center gap-1.5" title={migration.completedAt
								? `Started ${formatDateTime(migration.startedAt)}\nFinished ${formatDateTime(migration.completedAt)}`
								: `Started ${formatDateTime(migration.startedAt)}`}>
								<Octicon name="stopwatch" size={12} class="text-gray-600" />
								{formatElapsed(migration.elapsedSeconds)}
							</span>
						</td>
						<td class="px-4 py-3 text-right">
							{#if migration.warningsCount > 0}
								<span class="inline-flex items-center gap-1 text-yellow-400"><Octicon name="alert" size={12} />{migration.warningsCount}</span>
							{:else}
								<span class="text-gray-600">0</span>
							{/if}
						</td>
					</tr>
					{#if migration.failureReason}
						<tr class="border-b border-gray-800/50">
							<td colspan="5" class="px-4 py-2 pl-9">
								<span class="inline-flex items-start gap-1.5 text-xs text-red-400/80"><Octicon name="x-circle-fill" size={12} class="mt-0.5 shrink-0" />{migration.failureReason}</span>
							</td>
						</tr>
					{/if}
				{/each}
			</tbody>
		</table>
	</div>

	<!-- Pagination -->
	<Pagination
		page={migrationsResult.page}
		totalPages={migrationsResult.totalPages}
		total={migrationsResult.total}
		limit={migrationsResult.limit}
		onPageChange={goPage}
	/>

	<div class="flex justify-center">
		<a href="/migrate" class="inline-flex items-center gap-1.5 text-sm text-gray-400 hover:text-gray-50 transition-colors">
			<Octicon name="arrow-left" size={16} />
			Back to Dashboard
		</a>
	</div>
</div>

<!-- Restart modal -->
<RestartModal
	bind:open={showRestartModal}
	form={restart}
	submitting={restartSubmitting}
	error={restartError}
	title="Restart Failed Migrations"
	submitLabel={`Restart ${restartableCount} Migration${restartableCount === 1 ? '' : 's'}`}
	productionLockText="Source repositories will be locked during migration and archived after success."
	directPassthroughLabel="Direct passthrough (skip download/upload)"
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
		<!-- Batch info (read-only) -->
		<div class="rounded-md border border-gray-700/50 bg-gray-800/50 px-4 py-3">
			<p class="text-sm text-gray-300">
				Restarting <span class="font-medium text-gray-50">{restartableCount}</span> failed/cancelled migration{restartableCount === 1 ? '' : 's'} in this batch.
			</p>
		</div>

		{#if restartResult}
			<div class="rounded-md border border-green-500/30 bg-green-500/10 px-4 py-3 text-sm text-green-400">
				<p>{restartResult.restarted} migration(s) restarted successfully.</p>
				{#if restartResult.errors.length > 0}
					<p class="mt-1 text-red-400">{restartResult.errors.length} failed:</p>
					<ul class="mt-1 list-disc list-inside text-xs text-red-300">
						{#each restartResult.errors as err (err.id)}
							<li>{err.id}: {err.error}</li>
						{/each}
					</ul>
				{/if}
			</div>
		{/if}
	{/snippet}
</RestartModal>

<!-- Cancel-all confirmation modal -->
<CancelConfirmModal
	bind:open={showCancelModal}
	title="Cancel active migrations?"
	confirmPhrase={cancelPhrase}
	caseSensitive={false}
	submitLabel={`Cancel ${activeCount} Migration${activeCount === 1 ? '' : 's'}`}
	submitting={cancelSubmitting}
	error={cancelError}
	inputId="batch-cancel-confirm"
	onConfirm={confirmCancelAll}
>
	{#snippet body()}
		<p class="text-sm text-gray-300">
			This will cancel <span class="font-medium text-gray-50">{activeCount}</span> active migration{activeCount === 1 ? '' : 's'}
			(queued, pending, or running) in this batch. Already-completed migrations are not affected.
		</p>
	{/snippet}
</CancelConfirmModal>
