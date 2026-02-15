<!-- Batch detail page -->
<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import Pagination from '$lib/components/Pagination.svelte';
	import Octicon from '$lib/components/Octicon.svelte';
	import type { IconName } from '@primer/octicons';
	import type { BatchListItem, Migration, PaginatedResult } from '$lib/types';

	let { data } = $props();

	let polledBatch = $state<BatchListItem | null>(null);
	let polledMigrations = $state<PaginatedResult<Migration> | null>(null);

	let batch = $derived<BatchListItem>(polledBatch ?? data.batch);
	let migrationsResult = $derived<PaginatedResult<Migration>>(polledMigrations ?? data.migrations);

	// Poll for updates.
	let interval: ReturnType<typeof setInterval>;
	const currentPage = $derived(migrationsResult.page);

	onMount(() => {
		interval = setInterval(async () => {
			const res = await fetch(`/api/batches/${batch.id}?page=${currentPage}&limit=${migrationsResult.limit}`);
			if (res.ok) {
				const result = await res.json();
				polledBatch = result.summary;
				polledMigrations = result.migrations;
			}
			// Stop polling when all done.
			if (batch.pendingCount === 0 && batch.runningCount === 0) {
				clearInterval(interval);
			}
		}, 3000);
	});

	onDestroy(() => {
		clearInterval(interval);
	});

	const isActive = $derived(batch.pendingCount > 0 || batch.runningCount > 0);
	const pctComplete = $derived(
		batch.totalCount > 0
			? Math.round(((batch.succeededCount + batch.failedCount + batch.cancelledCount) / batch.totalCount) * 100)
			: 0
	);

	const stateStyles: Record<string, string> = {
		pending: 'bg-yellow-500/15 text-yellow-400',
		running: 'bg-green-600/15 text-green-400',
		succeeded: 'bg-green-600/15 text-green-400',
		failed: 'bg-red-500/15 text-red-400',
		cancelled: 'bg-gray-500/15 text-gray-400'
	};

	const stateIcons: Record<string, IconName> = {
		pending: 'clock',
		running: 'sync',
		succeeded: 'check-circle',
		failed: 'x-circle-fill',
		cancelled: 'skip'
	};

	function formatElapsed(seconds: number | null): string {
		if (!seconds) return '—';
		const m = Math.floor(seconds / 60);
		const s = Math.round(seconds % 60);
		if (m >= 60) {
			const h = Math.floor(m / 60);
			return `${h}h ${m % 60}m`;
		}
		return m > 0 ? `${m}m ${s}s` : `${s}s`;
	}

	async function handleCancelAll() {
		if (!confirm(`Cancel all ${batch.pendingCount + batch.runningCount} active migrations?`)) return;
		const cancelRes = await fetch(`/api/batches/${batch.id}`, { method: 'DELETE' });
		if (!cancelRes.ok) {
			alert(`Failed to cancel batch: HTTP ${cancelRes.status}`);
			return;
		}
		// Refresh
		const res = await fetch(`/api/batches/${batch.id}?page=${currentPage}&limit=${migrationsResult.limit}`);
		if (res.ok) {
			const result = await res.json();
			polledBatch = result.summary;
			polledMigrations = result.migrations;
		}
	}

	// Sort: running first, then pending, then failed, then succeeded, then cancelled.
	const sortOrder: Record<string, number> = { running: 0, pending: 1, failed: 2, succeeded: 3, cancelled: 4 };
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
	<!-- Header -->
	<div class="flex items-start justify-between">
		<div>
			<div class="flex items-center gap-3">
				<Octicon name="stack" size={16} class="text-gray-400" />
				<h1 class="text-2xl font-bold text-gray-50">Batch Migration</h1>
				{#if isActive}
					<span class="inline-flex items-center gap-1 rounded-full bg-green-600/15 px-2.5 py-0.5 text-xs font-medium text-green-400 animate-pulse">
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
		{#if isActive}
			<button onclick={handleCancelAll}
				class="flex items-center gap-1.5 rounded-md border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-400 hover:bg-red-500/20 transition-colors">
				<Octicon name="x-circle" size={16} />
				Cancel All
			</button>
		{/if}
	</div>

	<!-- Overall progress -->
	<div class="rounded-md border border-gray-700 bg-gray-900 p-5">
		<div class="flex items-center justify-between mb-3">
			<span class="text-sm font-medium text-gray-300">Overall Progress</span>
			<span class="text-sm text-gray-400">{pctComplete}% complete</span>
		</div>

		<!-- Stacked progress bar -->
		<div class="h-4 overflow-hidden rounded-full bg-gray-800 flex">
			{#if batch.succeededCount > 0}
				<div class="bg-green-500 transition-all duration-500"
					style="width: {(batch.succeededCount / batch.totalCount) * 100}%"></div>
			{/if}
			{#if batch.runningCount > 0}
				<div class="bg-green-500 animate-pulse transition-all duration-500"
					style="width: {(batch.runningCount / batch.totalCount) * 100}%"></div>
			{/if}
			{#if batch.pendingCount > 0}
				<div class="bg-yellow-500/50 transition-all duration-500"
					style="width: {(batch.pendingCount / batch.totalCount) * 100}%"></div>
			{/if}
			{#if batch.failedCount > 0}
				<div class="bg-red-500 transition-all duration-500"
					style="width: {(batch.failedCount / batch.totalCount) * 100}%"></div>
			{/if}
			{#if batch.cancelledCount > 0}
				<div class="bg-gray-600 transition-all duration-500"
					style="width: {(batch.cancelledCount / batch.totalCount) * 100}%"></div>
			{/if}
		</div>

		<!-- Stats row -->
		<div class="mt-3 flex flex-wrap gap-4 text-sm">
			{#if batch.succeededCount > 0}
				<span class="inline-flex items-center gap-1 text-green-400"><Octicon name="check-circle" size={12} />{batch.succeededCount} succeeded</span>
			{/if}
			{#if batch.runningCount > 0}
				<span class="inline-flex items-center gap-1 text-green-400"><Octicon name="sync" size={12} />{batch.runningCount} running</span>
			{/if}
			{#if batch.pendingCount > 0}
				<span class="inline-flex items-center gap-1 text-yellow-400"><Octicon name="clock" size={12} />{batch.pendingCount} pending</span>
			{/if}
			{#if batch.failedCount > 0}
				<span class="inline-flex items-center gap-1 text-red-400"><Octicon name="x-circle-fill" size={12} />{batch.failedCount} failed</span>
			{/if}
			{#if batch.cancelledCount > 0}
				<span class="inline-flex items-center gap-1 text-gray-400"><Octicon name="skip" size={12} />{batch.cancelledCount} cancelled</span>
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
							<a href="/{migration.id}" class="text-gray-50 hover:text-blue-400 transition-colors">
								{migration.sourceOrg}/{migration.sourceRepo}
							</a>
						</td>
						<td class="px-4 py-3 text-gray-400">
							{migration.targetOrg}/{migration.targetRepo}
						</td>
						<td class="px-4 py-3 text-center">
							<span class="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium {stateStyles[migration.state]}">
								<Octicon name={stateIcons[migration.state] || 'clock'} size={12} />
								{migration.state}
							</span>
						</td>
						<td class="px-4 py-3 text-right text-gray-400">
							{formatElapsed(migration.elapsedSeconds)}
						</td>
						<td class="px-4 py-3 text-right">
							{#if migration.warningsCount > 0}
								<span class="text-yellow-400">{migration.warningsCount}</span>
							{:else}
								<span class="text-gray-600">0</span>
							{/if}
						</td>
					</tr>
					{#if migration.failureReason}
						<tr class="border-b border-gray-800/50">
							<td colspan="5" class="px-4 py-2">
								<span class="text-xs text-red-400/80">{migration.failureReason}</span>
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
		<a href="/" class="inline-flex items-center gap-1.5 text-sm text-gray-400 hover:text-gray-50 transition-colors">
			<Octicon name="arrow-left" size={16} />
			Back to Dashboard
		</a>
	</div>
</div>
