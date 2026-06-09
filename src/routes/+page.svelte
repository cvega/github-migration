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
		if (searchDebounce) clearTimeout(searchDebounce);
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

	// ── Search ──────────────────────────────────────────────────────────────
	// `data.q` is the server-applied query; when present the page renders a
	// filtered Results view instead of the three-section overview.
	const q = $derived(data.q ?? '');
	const searching = $derived(q.length > 0);
	// Writable $derived: seeded from the URL query and auto-reset when it changes
	// (e.g. back/forward nav), but locally reassignable as the user types.
	let searchInput = $derived(data.q ?? '');
	let searchDebounce: ReturnType<typeof setTimeout> | null = null;

	function navigateSearch(value: string) {
		const params = new URLSearchParams(page.url.searchParams);
		const trimmed = value.trim();
		if (trimmed) params.set('q', trimmed);
		else params.delete('q');
		// A new query resets both paginators.
		params.delete('page');
		params.delete('bp');
		const qs = params.toString();
		goto(qs ? `/?${qs}` : '/', { keepFocus: true, noScroll: true });
	}

	function onSearchInput() {
		if (searchDebounce) clearTimeout(searchDebounce);
		searchDebounce = setTimeout(() => navigateSearch(searchInput), 250);
	}

	function submitSearch(e: SubmitEvent) {
		e.preventDefault();
		if (searchDebounce) clearTimeout(searchDebounce);
		navigateSearch(searchInput);
	}

	function clearSearch() {
		if (searchDebounce) clearTimeout(searchDebounce);
		searchInput = '';
		navigateSearch('');
	}

	// Global state counts (whole dataset, not just this page) — power the
	// section-overview tiles so their totals match the real database, while the
	// card lists below remain paginated. Null while searching (tiles hidden).
	const counts = $derived(data.stateCounts);
	const activeTotal = $derived(counts ? counts.queued + counts.pending + counts.running : 0);
	const completedTotal = $derived(counts ? counts.succeeded + counts.failed + counts.cancelled : 0);

	// Most recent batch on this page (rows arrive newest-first), for recency metadata.
	const newestBatch = $derived(batchesResult.data[0] ?? null);

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
					{#if searching}
						{migrationsResult.total + batchesResult.total} result{migrationsResult.total + batchesResult.total === 1 ? '' : 's'} for “{q}”
					{:else}
						{migrationsResult.total} total · {active.length} active on this page
					{/if}
				</p>
			</div>
		</div>
		<div class="flex items-center gap-2">
			<AuthPill label="Source" isApp={auth.sourceApp} rateText={auth.sourceRateText} ratePct={auth.sourceRatePct} migrating={auth.migrating} />
			<AuthPill label="Target" isApp={auth.targetApp} rateText={auth.targetRateText} ratePct={auth.targetRatePct} migrating={auth.migrating} />
			<GitHubStatus status={ghStatusCtx.value} />
		</div>
	</div>

	<!-- Search -->
	<form role="search" onsubmit={submitSearch} class="relative">
		<span class="pointer-events-none absolute inset-y-0 left-3 flex items-center text-gray-500">
			<Octicon name="search" size={16} />
		</span>
		<input
			type="text"
			bind:value={searchInput}
			oninput={onSearchInput}
			placeholder="Search by repository, organization, or migration ID…"
			aria-label="Search migrations"
			autocomplete="off"
			spellcheck="false"
			class="w-full rounded-md border border-gray-700 bg-gray-900 py-2.5 pl-10 pr-10 text-sm text-gray-50 placeholder:text-gray-500 hover:border-gray-600 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 transition-colors"
		/>
		{#if searchInput}
			<button
				type="button"
				onclick={clearSearch}
				aria-label="Clear search"
				class="absolute inset-y-0 right-2 flex items-center rounded p-1 text-gray-500 hover:text-gray-200 transition-colors">
				<Octicon name="x-circle-fill" size={16} />
			</button>
		{/if}
	</form>

	<!-- Section overview — click a tile to jump to that section (hidden while searching) -->
	{#if !searching && (batchesResult.total > 0 || activeTotal > 0 || completedTotal > 0)}
		<div class="flex flex-col gap-3 sm:flex-row">
			{#if batchesResult.total > 0}
				<a href="#batches"
					class="group flex flex-1 items-center gap-3 rounded-md border border-gray-700 bg-gray-900 px-4 py-3 hover:border-gray-600 hover:bg-gray-800 transition-all">
					<span class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-blue-500/10 text-blue-400">
						<Octicon name="stack" size={16} />
					</span>
					<span class="min-w-0 flex-1">
						<span class="flex items-baseline gap-1.5">
							<span class="text-2xl font-bold leading-none text-gray-50 tabular-nums">{batchesResult.total}</span>
							<span class="text-sm font-medium text-gray-400">{batchesResult.total === 1 ? 'Batch' : 'Batches'}</span>
						</span>
						<span class="mt-1.5 flex items-center gap-1 text-xs text-gray-500">
							<Octicon name="clock" size={12} />
							{#if newestBatch}newest {timeAgo(newestBatch.startedAt)}{:else}all repos{/if}
						</span>
					</span>
					<span class="flex shrink-0 items-center gap-1 text-xs font-medium text-gray-600 transition-colors group-hover:text-blue-400">
						View
						<Octicon name="arrow-down" size={12} class="transition-transform group-hover:translate-y-0.5" />
					</span>
				</a>
			{/if}
			{#if activeTotal > 0}
				<a href="#active"
					class="group flex flex-1 items-center gap-3 rounded-md border border-gray-700 bg-gray-900 px-4 py-3 hover:border-gray-600 hover:bg-gray-800 transition-all">
					<span class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-green-600/15 text-green-400">
						<Octicon name="play" size={16} />
					</span>
					<span class="min-w-0 flex-1">
						<span class="flex items-baseline gap-1.5">
							<span class="text-2xl font-bold leading-none text-gray-50 tabular-nums">{activeTotal}</span>
							<span class="text-sm font-medium text-gray-400">Active</span>
						</span>
						<span class="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-xs">
							{#if (counts?.running ?? 0) > 0}<span class="inline-flex items-center gap-1 text-green-400" title="Running"><Octicon name="sync" size={12} />{counts?.running}</span>{/if}
							{#if (counts?.queued ?? 0) > 0}<span class="inline-flex items-center gap-1 text-blue-400" title="Queued"><Octicon name="hourglass" size={12} />{counts?.queued}</span>{/if}
							{#if (counts?.pending ?? 0) > 0}<span class="inline-flex items-center gap-1 text-yellow-400" title="Pending"><Octicon name="clock" size={12} />{counts?.pending}</span>{/if}
						</span>
					</span>
					<span class="flex shrink-0 items-center gap-1 text-xs font-medium text-gray-600 transition-colors group-hover:text-green-400">
						View
						<Octicon name="arrow-down" size={12} class="transition-transform group-hover:translate-y-0.5" />
					</span>
				</a>
			{/if}
			{#if completedTotal > 0}
				<a href="#completed"
					class="group flex flex-1 items-center gap-3 rounded-md border border-gray-700 bg-gray-900 px-4 py-3 hover:border-gray-600 hover:bg-gray-800 transition-all">
					<span class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-gray-700/50 text-gray-300">
						<Octicon name="check-circle" size={16} />
					</span>
					<span class="min-w-0 flex-1">
						<span class="flex items-baseline gap-1.5">
							<span class="text-2xl font-bold leading-none text-gray-50 tabular-nums">{completedTotal}</span>
							<span class="text-sm font-medium text-gray-400">Completed</span>
						</span>
						<span class="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-xs">
							{#if (counts?.succeeded ?? 0) > 0}<span class="inline-flex items-center gap-1 text-green-400" title="Succeeded"><Octicon name="check-circle-fill" size={12} />{counts?.succeeded}</span>{/if}
							{#if (counts?.failed ?? 0) > 0}<span class="inline-flex items-center gap-1 text-red-400" title="Failed"><Octicon name="x-circle-fill" size={12} />{counts?.failed}</span>{/if}
							{#if (counts?.cancelled ?? 0) > 0}<span class="inline-flex items-center gap-1 text-gray-400" title="Cancelled"><Octicon name="skip" size={12} />{counts?.cancelled}</span>{/if}
						</span>
					</span>
					<span class="flex shrink-0 items-center gap-1 text-xs font-medium text-gray-600 transition-colors group-hover:text-gray-300">
						View
						<Octicon name="arrow-down" size={12} class="transition-transform group-hover:translate-y-0.5" />
					</span>
				</a>
			{/if}
		</div>
	{/if}

	<!-- Reusable batch summary card (shared by the dashboard and search results) -->
	{#snippet batchCard(batch: BatchListItem)}
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
	{/snippet}

	{#if searching}
		<!-- ── Search results ──────────────────────────────────────────────── -->
		{#if migrationsResult.total === 0 && batchesResult.total === 0}
			<div class="flex flex-col items-center justify-center rounded-md border border-dashed border-gray-600 py-16">
				<Octicon name="search" size={24} class="text-gray-500 h-12 w-12" />
				<p class="mt-4 text-gray-400">No results for “{q}”</p>
				<button type="button" onclick={clearSearch}
					class="mt-4 flex items-center gap-1.5 rounded-md border border-gray-700 bg-gray-800 px-4 py-2 text-sm text-gray-300 hover:bg-gray-700 hover:text-gray-50 transition-colors">
					<Octicon name="x" size={16} />
					Clear search
				</button>
			</div>
		{/if}

		{#if batchesResult.total > 0}
			<section>
				<h2 class="mb-3 flex items-center gap-2 text-lg font-semibold text-gray-300">
					<Octicon name="stack" size={16} />
					Matching batches
					<span class="text-sm font-normal text-gray-500">({batchesResult.total})</span>
				</h2>
				<div class="space-y-2">
					{#each batchesResult.data as batch (batch.id)}
						{@render batchCard(batch)}
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

		{#if migrationsResult.total > 0}
			<section>
				<h2 class="mb-3 flex items-center gap-2 text-lg font-semibold text-gray-300">
					<Octicon name="repo" size={16} />
					Repositories
					<span class="text-sm font-normal text-gray-500">({migrationsResult.total})</span>
				</h2>
				<div class="space-y-3">
					{#each migrationsResult.data as migration (migration.id)}
						<MigrationCard {migration} live={liveById.get(migration.id)} {now} />
					{/each}
				</div>
				<Pagination
					page={migrationsResult.page}
					totalPages={migrationsResult.totalPages}
					total={migrationsResult.total}
					limit={migrationsResult.limit}
					onPageChange={goMigrationsPage}
				/>
			</section>
		{/if}
	{:else}
		<!-- ── Dashboard ───────────────────────────────────────────────────── -->
		{#if batchesResult.data.length > 0}
			<section id="batches" class="scroll-mt-6">
				<h2 class="mb-3 flex items-center gap-2 text-lg font-semibold text-gray-300">
					<Octicon name="stack" size={16} />
					Batches
				</h2>
				<div class="space-y-2">
					{#each batchesResult.data as batch (batch.id)}
						{@render batchCard(batch)}
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
	{/if}
</div>
