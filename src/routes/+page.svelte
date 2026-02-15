<!-- Dashboard page -->
<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { createGlobalEventSource, migrations } from '$lib/stores/migrations.svelte';
	import MigrationCard from '$lib/components/MigrationCard.svelte';
	import Pagination from '$lib/components/Pagination.svelte';
	import Octicon from '$lib/components/Octicon.svelte';
	import type { Migration, BatchListItem, PaginatedResult } from '$lib/types';

	let { data } = $props();

	// Seed the migration store with this page of data for SSE updates.
	$effect(() => {
		migrations.value = data.migrations.data;
	});

	let migrationsResult = $derived<PaginatedResult<Migration>>(data.migrations);
	let batchesResult = $derived<PaginatedResult<BatchListItem>>(data.batches);

	let globalSSE: ReturnType<typeof createGlobalEventSource> | null = null;

	onMount(() => {
		globalSSE = createGlobalEventSource();
	});

	onDestroy(() => {
		globalSSE?.destroy();
	});

	const active = $derived(migrations.value.filter((m: Migration) => m.state === 'pending' || m.state === 'running'));
	const completed = $derived(migrations.value.filter((m: Migration) => m.state !== 'pending' && m.state !== 'running'));

	function batchStateBadge(b: BatchListItem): { label: string; style: string } {
		if (b.runningCount > 0 || b.pendingCount > 0) return { label: 'active', style: 'bg-green-600/15 text-green-400' };
		if (b.failedCount > 0 && b.succeededCount > 0) return { label: 'partial', style: 'bg-yellow-600/15 text-yellow-400' };
		if (b.failedCount > 0) return { label: 'failed', style: 'bg-red-500/15 text-red-400' };
		return { label: 'done', style: 'bg-green-600/15 text-green-400' };
	}

	function goMigrationsPage(p: number) {
		const params = new URLSearchParams(page.url.searchParams);
		params.set('page', String(p));
		goto(`/?${params.toString()}`, { keepFocus: true, noScroll: false });
	}

	function goBatchesPage(p: number) {
		const params = new URLSearchParams(page.url.searchParams);
		params.set('bp', String(p));
		goto(`/?${params.toString()}`, { keepFocus: true, noScroll: false });
	}
</script>

<div class="space-y-8">
	<!-- Header -->
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-2xl font-bold text-gray-50">Migrations</h1>
			<p class="mt-1 text-sm text-gray-400">
				{migrationsResult.total} total · {active.length} active on this page
			</p>
		</div>

	</div>

	<!-- Batches -->
	{#if batchesResult.data.length > 0}
		<section>
			<h2 class="mb-3 flex items-center gap-2 text-lg font-semibold text-gray-300">
				<Octicon name="stack" size={16} />
				Batches
			</h2>
			<div class="space-y-2">
				{#each batchesResult.data as batch (batch.id)}
					{@const badge = batchStateBadge(batch)}
					<a href="/batches/{batch.id}"
					class="flex items-center justify-between rounded-md border border-gray-700 bg-gray-900 p-3 hover:border-gray-600 hover:bg-gray-800 transition-all">
						<div class="flex items-center gap-3">
							<span class="text-sm font-medium text-gray-50">{batch.totalCount} repos</span>
							<span class="rounded-full px-2 py-0.5 text-xs font-medium {badge.style}">{badge.label}</span>
						</div>
						<div class="flex items-center gap-4 text-xs text-gray-500">
							{#if batch.succeededCount > 0}<span class="text-green-400">{batch.succeededCount} ok</span>{/if}
							{#if batch.runningCount > 0}<span class="text-green-400">{batch.runningCount} running</span>{/if}
							{#if batch.pendingCount > 0}<span class="text-yellow-400">{batch.pendingCount} pending</span>{/if}
							{#if batch.failedCount > 0}<span class="text-red-400">{batch.failedCount} failed</span>{/if}
							<span class="text-gray-600 font-mono text-[10px]">{batch.id.slice(0, 8)}</span>
						</div>
					</a>
				{/each}
			</div>
			<Pagination
				page={batchesResult.page}
				totalPages={batchesResult.totalPages}
				total={batchesResult.total}
				limit={batchesResult.limit}
				onPageChange={goBatchesPage}
			/>
		</section>
	{/if}

	<!-- Active migrations -->
	{#if active.length > 0}
		<section>
			<h2 class="mb-3 flex items-center gap-2 text-lg font-semibold text-gray-300">
				<Octicon name="play" size={16} class="text-green-400" />
				Active
			</h2>
			<div class="space-y-3">
				{#each active as migration (migration.id)}
					<MigrationCard {migration} />
				{/each}
			</div>
		</section>
	{/if}

	<!-- Completed migrations -->
	{#if completed.length > 0}
		<section>
			<h2 class="mb-3 flex items-center gap-2 text-lg font-semibold text-gray-300">
				<Octicon name="check-circle" size={16} class="text-gray-400" />
				Completed
			</h2>
			<div class="space-y-3">
				{#each completed as migration (migration.id)}
					<MigrationCard {migration} />
				{/each}
			</div>
		</section>
	{/if}

	<!-- Migration pagination -->
	<Pagination
		page={migrationsResult.page}
		totalPages={migrationsResult.totalPages}
		total={migrationsResult.total}
		limit={migrationsResult.limit}
		onPageChange={goMigrationsPage}
	/>

	<!-- Empty state -->
	{#if migrationsResult.total === 0 && batchesResult.total === 0}
		<div class="flex flex-col items-center justify-center rounded-md border border-dashed border-gray-600 py-16">
			<Octicon name="arrow-switch" size={24} class="text-gray-500 h-12 w-12" />
			<p class="mt-4 text-gray-400">No migrations yet</p>
			<a href="/new"
				class="mt-4 flex items-center gap-1.5 rounded-md bg-green-600 px-5 py-2 text-sm font-medium text-white hover:bg-green-500 transition-colors">
				<Octicon name="rocket" size={16} />
				Start your first migration
			</a>
		</div>
	{/if}
</div>
