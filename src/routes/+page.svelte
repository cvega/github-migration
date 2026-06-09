<!-- Dashboard page -->
<script lang="ts">
	import { onMount, onDestroy, getContext } from 'svelte';
	import { GH_STATUS_KEY, AUTH_PILL_KEY, type GhStatusContext, type AuthPillContext } from '$lib/context-keys';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { createGlobalEventSource, migrations } from '$lib/stores/migrations.svelte';
	import MigrationCard from '$lib/components/MigrationCard.svelte';
	import Pagination from '$lib/components/Pagination.svelte';
	import Octicon from '$lib/components/Octicon.svelte';
	import GitHubStatus from '$lib/components/GitHubStatus.svelte';
	import AuthPill from '$lib/components/AuthPill.svelte';
	import type { Migration, BatchListItem, PaginatedResult, Snapshot, Counts } from '$lib/types';

	const ghStatusCtx = getContext<GhStatusContext>(GH_STATUS_KEY);
	const auth = getContext<AuthPillContext>(AUTH_PILL_KEY);

	let { data } = $props();

	// Seed the migration store with this page of data for SSE updates.
	$effect(() => {
		migrations.value = data.migrations.data;
	});

	let migrationsResult = $derived<PaginatedResult<Migration>>(data.migrations);
	let batchesResult = $derived<PaginatedResult<BatchListItem>>(data.batches);

	let globalSSE = $state<ReturnType<typeof createGlobalEventSource> | null>(null);

	// Ticking clock so active cards show a live-updating elapsed timer.
	let now = $state(Date.now());

	onMount(() => {
		globalSSE = createGlobalEventSource();
		const tick = setInterval(() => { now = Date.now(); }, 1000);
		return () => clearInterval(tick);
	});

	onDestroy(() => {
		globalSSE?.destroy();
	});

	// Latest live snapshot per migration id, derived from the global SSE stream.
	const liveById = $derived.by(() => {
		const map = new Map<string, { snapshot: Snapshot; sourceCounts: Counts | null }>();
		for (const ev of globalSSE?.events ?? []) {
			if (ev.eventType === 'snapshot') {
				map.set(ev.migrationId, { snapshot: ev.payload.progress.current, sourceCounts: ev.payload.sourceCounts });
			}
		}
		return map;
	});

	const active = $derived(migrations.value.filter((m: Migration) => m.state === 'queued' || m.state === 'pending' || m.state === 'running'));
	const completed = $derived(migrations.value.filter((m: Migration) => m.state !== 'queued' && m.state !== 'pending' && m.state !== 'running'));

	function batchStateBadge(b: BatchListItem): { label: string; style: string } {
		if (b.runningCount > 0 || b.pendingCount > 0 || b.queuedCount > 0) return { label: 'active', style: 'bg-green-600/15 text-green-400' };
		if (b.failedCount > 0 && b.succeededCount > 0) return { label: 'partial', style: 'bg-yellow-600/15 text-yellow-400' };
		if (b.failedCount > 0) return { label: 'failed', style: 'bg-red-500/15 text-red-400' };
		return { label: 'done', style: 'bg-green-600/15 text-green-400' };
	}

	function timeAgo(dateStr: string): string {
		const diff = Date.now() - new Date(dateStr).getTime();
		const mins = Math.floor(diff / 60_000);
		if (mins < 1) return 'just now';
		if (mins < 60) return `${mins}m ago`;
		const hrs = Math.floor(mins / 60);
		if (hrs < 24) return `${hrs}h ago`;
		return `${Math.floor(hrs / 24)}d ago`;
	}

	const pctOf = (n: number, total: number) => (total > 0 ? (n / total) * 100 : 0);

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
		<div class="flex items-center gap-3">
			{#if data.logoUrl}
				<img
					src={data.logoUrl}
					alt=""
					class="h-14 w-14 rounded-lg border border-gray-700"
				/>
			{/if}
			<div>
				<h1 class="text-2xl font-bold text-gray-50">Migrations</h1>
				<p class="mt-1 text-sm text-gray-400">
					{migrationsResult.total} total · {active.length} active on this page
				</p>
			</div>
		</div>
		<div class="flex items-center gap-2">
			<AuthPill label="Source" isApp={auth.sourceApp} rateText={auth.sourceRateText} ratePct={auth.sourceRatePct} migrating={auth.migrating} />
			<AuthPill label="Target" isApp={auth.targetApp} rateText={auth.targetRateText} ratePct={auth.targetRatePct} migrating={auth.migrating} />
			<GitHubStatus status={ghStatusCtx.value} />
		</div>
	</div>

	<!-- Section overview — click a tile to jump to that section -->
	{#if batchesResult.data.length > 0 || active.length > 0 || completed.length > 0}
		<div class="flex flex-col gap-3 sm:flex-row">
			{#if batchesResult.data.length > 0}
				<a href="#batches"
					class="group flex flex-1 items-center gap-3 rounded-md border border-gray-700 bg-gray-900 px-4 py-3 hover:border-gray-600 hover:bg-gray-800 transition-all">
					<span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-blue-500/10 text-blue-400">
						<Octicon name="stack" size={16} />
					</span>
					<span class="min-w-0">
						<span class="block text-xl font-bold leading-none text-gray-50">{batchesResult.total}</span>
						<span class="mt-1 block text-xs text-gray-500">{batchesResult.total === 1 ? 'Batch' : 'Batches'}</span>
					</span>
					<Octicon name="chevron-down" size={16} class="ml-auto shrink-0 text-gray-600 transition-colors group-hover:text-gray-400" />
				</a>
			{/if}
			{#if active.length > 0}
				<a href="#active"
					class="group flex flex-1 items-center gap-3 rounded-md border border-gray-700 bg-gray-900 px-4 py-3 hover:border-gray-600 hover:bg-gray-800 transition-all">
					<span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-green-600/15 text-green-400">
						<Octicon name="play" size={16} />
					</span>
					<span class="min-w-0">
						<span class="block text-xl font-bold leading-none text-gray-50">{active.length}</span>
						<span class="mt-1 block text-xs text-gray-500">Active</span>
					</span>
					<Octicon name="chevron-down" size={16} class="ml-auto shrink-0 text-gray-600 transition-colors group-hover:text-gray-400" />
				</a>
			{/if}
			{#if completed.length > 0}
				<a href="#completed"
					class="group flex flex-1 items-center gap-3 rounded-md border border-gray-700 bg-gray-900 px-4 py-3 hover:border-gray-600 hover:bg-gray-800 transition-all">
					<span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-gray-700/50 text-gray-300">
						<Octicon name="check-circle" size={16} />
					</span>
					<span class="min-w-0">
						<span class="block text-xl font-bold leading-none text-gray-50">{completed.length}</span>
						<span class="mt-1 block text-xs text-gray-500">Completed</span>
					</span>
					<Octicon name="chevron-down" size={16} class="ml-auto shrink-0 text-gray-600 transition-colors group-hover:text-gray-400" />
				</a>
			{/if}
		</div>
	{/if}

	<!-- Batches -->
	{#if batchesResult.data.length > 0}
		<section id="batches" class="scroll-mt-6">
			<h2 class="mb-3 flex items-center gap-2 text-lg font-semibold text-gray-300">
				<Octicon name="stack" size={16} />
				Batches
			</h2>
			<div class="space-y-2">
				{#each batchesResult.data as batch (batch.id)}
					{@const badge = batchStateBadge(batch)}
					{@const donePct = Math.round(pctOf(batch.succeededCount, batch.totalCount))}
					<a href="/batches/{batch.id}"
					class="block rounded-md border border-gray-700 bg-gray-900 p-3 hover:border-gray-600 hover:bg-gray-800 transition-all">
						<div class="flex items-center justify-between gap-3">
							<div class="flex min-w-0 items-center gap-2.5">
								<Octicon name="repo" size={16} class="text-gray-500" />
								<span class="text-sm font-medium text-gray-50">{batch.totalCount} repos</span>
								<span class="rounded-full px-2 py-0.5 text-xs font-medium {badge.style}">{badge.label}</span>
							</div>
							<div class="flex shrink-0 items-center gap-3 text-xs">
								{#if batch.succeededCount > 0}<span class="inline-flex items-center gap-1 text-green-400"><Octicon name="check-circle-fill" size={12} />{batch.succeededCount}</span>{/if}
								{#if batch.runningCount > 0}<span class="inline-flex items-center gap-1 text-green-400"><Octicon name="sync" size={12} />{batch.runningCount}</span>{/if}
								{#if batch.pendingCount > 0}<span class="inline-flex items-center gap-1 text-yellow-400"><Octicon name="clock" size={12} />{batch.pendingCount}</span>{/if}
								{#if batch.queuedCount > 0}<span class="inline-flex items-center gap-1 text-blue-400"><Octicon name="hourglass" size={12} />{batch.queuedCount}</span>{/if}
								{#if batch.failedCount > 0}<span class="inline-flex items-center gap-1 text-red-400"><Octicon name="x-circle-fill" size={12} />{batch.failedCount}</span>{/if}
								{#if batch.cancelledCount > 0}<span class="inline-flex items-center gap-1 text-gray-400"><Octicon name="skip" size={12} />{batch.cancelledCount}</span>{/if}
							</div>
						</div>
						<div class="mt-2.5 flex items-center gap-3">
							<div class="flex h-1.5 flex-1 overflow-hidden rounded-full bg-gray-800">
								<div class="h-full bg-green-500" style="width: {pctOf(batch.succeededCount, batch.totalCount)}%"></div>
								<div class="h-full bg-red-500" style="width: {pctOf(batch.failedCount, batch.totalCount)}%"></div>
								<div class="h-full bg-gray-500" style="width: {pctOf(batch.cancelledCount, batch.totalCount)}%"></div>
							</div>
							<span class="shrink-0 text-[11px] tabular-nums text-gray-500">{donePct}%</span>
							<span class="inline-flex shrink-0 items-center gap-1 text-[11px] text-gray-500">
								<Octicon name="clock" size={12} />{timeAgo(batch.startedAt)}
							</span>
							<span class="shrink-0 font-mono text-[10px] text-gray-600">{batch.id.slice(0, 8)}</span>
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
		<section id="active" class="scroll-mt-6">
			<h2 class="mb-3 flex items-center gap-2 text-lg font-semibold text-gray-300">
				<Octicon name="play" size={16} class="text-green-400" />
				Active
			</h2>
			<div class="space-y-3">
				{#each active as migration (migration.id)}
					<MigrationCard {migration} live={liveById.get(migration.id)} {now} />
				{/each}
			</div>
		</section>
	{/if}

	<!-- Completed migrations -->
	{#if completed.length > 0}
		<section id="completed" class="scroll-mt-6">
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
