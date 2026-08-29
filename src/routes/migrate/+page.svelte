<script lang="ts">
	import { getContext, onDestroy, onMount, untrack } from "svelte";
	import { goto, invalidateAll } from "$app/navigation";
	import { page } from "$app/state";
	import AuthStatus from "$lib/components/AuthStatus.svelte";
	import GitHubStatus from "$lib/components/GitHubStatus.svelte";
	import MigrationCard from "$lib/components/migrate/MigrationCard.svelte";
	import Octicon from "$lib/components/Octicon.svelte";
	import Pagination from "$lib/components/Pagination.svelte";
	import {
		AUTH_PILL_KEY,
		type AuthPillContext,
		GH_STATUS_KEY,
		type GhStatusContext,
	} from "$lib/context-keys";
	import { timeAgo } from "$lib/format";
	import { eventChangesBatchSummary } from "$lib/migrate/events";
	import { createGlobalEventSource, migrations } from "$lib/migrate/live.svelte";
	import { STATE_LABELS } from "$lib/migrate/migration-display";
	import type {
		BatchListItem,
		Counts,
		Migration,
		PaginatedResult,
		Snapshot,
	} from "$lib/migrate/types";
	import { isActiveMigrationState } from "$lib/migration-state";
	import { getTargetPlatformPresentation } from "$lib/migration-target";
	import { getSourceProviderAdapter } from "$lib/source-provider";

	const ghStatusCtx = getContext<GhStatusContext>(GH_STATUS_KEY);
	const auth = getContext<AuthPillContext>(AUTH_PILL_KEY);
	let { data } = $props();

	$effect(() => {
		migrations.value = data.migrations.data;
	});

	let globalSSE = $state<ReturnType<typeof createGlobalEventSource> | null>(null);
	const migrationRows = $derived(globalSSE ? migrations.value : data.migrations.data);
	let migrationsResult = $derived<PaginatedResult<Migration>>({
		...data.migrations,
		data: migrationRows,
	});
	let batchesResult = $derived<PaginatedResult<BatchListItem>>(data.batches);
	let batchRefreshTimer: ReturnType<typeof setTimeout> | null = null;

	$effect(() => {
		const latestEvent = globalSSE?.events.at(-1);
		if (!latestEvent || !eventChangesBatchSummary(latestEvent)) return;
		if (batchRefreshTimer) clearTimeout(batchRefreshTimer);
		batchRefreshTimer = setTimeout(() => {
			batchRefreshTimer = null;
			void invalidateAll();
		}, 300);
	});

	let now = $state(Date.now());

	onMount(() => {
		globalSSE = createGlobalEventSource();
		const tick = setInterval(() => {
			now = Date.now();
		}, 1000);
		return () => clearInterval(tick);
	});

	onDestroy(() => {
		globalSSE?.destroy();
		if (batchRefreshTimer) clearTimeout(batchRefreshTimer);
		if (searchDebounce) clearTimeout(searchDebounce);
	});

	const liveById = $derived.by(() => {
		const map = new Map<string, { snapshot: Snapshot; sourceCounts: Counts | null }>();
		for (const event of globalSSE?.events ?? []) {
			if (event.eventType === "snapshot") {
				map.set(event.migrationId, {
					snapshot: event.payload.progress.current,
					sourceCounts: event.payload.sourceCounts,
				});
			}
		}
		return map;
	});

	const active = $derived(
		migrationRows.filter((migration: Migration) => isActiveMigrationState(migration.state)),
	);
	const completed = $derived(
		migrationRows.filter((migration: Migration) => !isActiveMigrationState(migration.state)),
	);
	const q = $derived(data.q ?? "");
	const searching = $derived(q.length > 0);
	let searchInput = $state(untrack(() => data.q ?? ""));
	let appliedSearchQuery = $state(untrack(() => data.q ?? ""));
	let searchDebounce: ReturnType<typeof setTimeout> | null = null;

	$effect(() => {
		const nextQuery = data.q ?? "";
		if (nextQuery !== appliedSearchQuery) {
			appliedSearchQuery = nextQuery;
			searchInput = nextQuery;
		}
	});

	function navigateSearch(value: string) {
		const params = new URLSearchParams(page.url.searchParams);
		const trimmed = value.trim();
		if (trimmed) params.set("q", trimmed);
		else params.delete("q");
		params.delete("page");
		params.delete("bp");
		const query = params.toString();
		goto(query ? `/migrate?${query}` : "/migrate", { keepFocus: true, noScroll: true });
	}

	function onSearchInput() {
		if (searchDebounce) clearTimeout(searchDebounce);
		searchDebounce = setTimeout(() => navigateSearch(searchInput), 250);
	}

	function submitSearch(event: SubmitEvent) {
		event.preventDefault();
		if (searchDebounce) clearTimeout(searchDebounce);
		navigateSearch(searchInput);
	}

	function clearSearch() {
		if (searchDebounce) clearTimeout(searchDebounce);
		searchInput = "";
		navigateSearch("");
	}

	const counts = $derived(data.stateCounts);
	const activeTotal = $derived(
		counts ? counts.queued + counts.pending + counts.running + counts.cancelling : 0,
	);
	const completedTotal = $derived(
		counts
			? counts.succeeded +
				counts.failed +
				counts.cancelled +
				counts.reconciliation_required
			: 0,
	);
	const newestBatch = $derived(batchesResult.data[0] ?? null);

	function batchStateBadge(batch: BatchListItem): {
		label: string;
		style: string;
		accent: string;
		live?: boolean;
	} {
		if (
			batch.runningCount > 0 ||
			batch.pendingCount > 0 ||
			batch.queuedCount > 0 ||
			batch.cancellingCount > 0
		) {
			return { label: "active", style: "text-green-400", accent: "bg-blue-500", live: true };
		}
		if (batch.reconciliationRequiredCount > 0) {
			return {
				label: "review required",
				style: "bg-orange-500/15 text-orange-400",
				accent: "bg-orange-500",
			};
		}
		if (batch.failedCount > 0 && batch.succeededCount > 0) {
			return {
				label: "partial",
				style: "bg-yellow-600/15 text-yellow-400",
				accent: "bg-yellow-500",
			};
		}
		if (batch.failedCount > 0) {
			return {
				label: "failed",
				style: "bg-red-500/15 text-red-400",
				accent: "bg-red-500",
			};
		}
		return {
			label: "done",
			style: "bg-green-600/15 text-green-400",
			accent: "bg-green-500",
		};
	}

	function batchRoute(batch: BatchListItem) {
		if (batch.mixedRoute) return null;
		return {
			source: getSourceProviderAdapter(batch.sourceProvider).sourcePlatform(batch.sourceApiUrl),
			target: getTargetPlatformPresentation(batch.targetPlatform),
		};
	}

	const pctOf = (value: number, total: number) => (total > 0 ? (value / total) * 100 : 0);

	function goMigrationsPage(nextPage: number) {
		const params = new URLSearchParams(page.url.searchParams);
		params.set("page", String(nextPage));
		goto(`/migrate?${params.toString()}`, { keepFocus: true, noScroll: false });
	}

	function goBatchesPage(nextPage: number) {
		const params = new URLSearchParams(page.url.searchParams);
		params.set("bp", String(nextPage));
		goto(`/migrate?${params.toString()}`, { keepFocus: true, noScroll: false });
	}
</script>

<div class="space-y-8">
	<div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
		<div class="flex items-center gap-3">
			{#if data.logoUrl}
				<img src={data.logoUrl} alt="" class="h-14 w-14 rounded-lg border border-gray-700" />
			{/if}
			<div>
				<h1 class="text-2xl font-bold text-gray-50">Migrations</h1>
				<p class="mt-1 text-sm text-gray-400">
					{#if searching}
						{migrationsResult.total + batchesResult.total} result{migrationsResult.total +
							batchesResult.total ===
						1
							? ""
							: "s"} for “{q}”
					{:else}
						{migrationsResult.total} total · {active.length} active on this page
					{/if}
				</p>
			</div>
		</div>
		<div class="flex flex-wrap items-center gap-2 sm:justify-end">
			<AuthStatus
				label="Source"
				isApp={auth.sourceApp}
				rateText={auth.sourceRateText}
				ratePct={auth.sourceRatePct}
				migrating={auth.migrating}
			/>
			<AuthStatus
				label="Target"
				isApp={auth.targetApp}
				rateText={auth.targetRateText}
				ratePct={auth.targetRatePct}
				migrating={auth.migrating}
			/>
			<GitHubStatus status={ghStatusCtx.value} />
		</div>
	</div>

	{#if globalSSE?.stale}
		<div
			role="status"
			class="flex items-center justify-between gap-3 rounded-md border border-yellow-500/30 bg-yellow-500/10 px-4 py-3 text-sm text-yellow-200"
		>
			<span>Live updates are disconnected. Showing the latest saved migration data.</span>
			<button
				type="button"
				onclick={() => globalSSE?.retry()}
				class="shrink-0 rounded-md border border-yellow-400/30 px-3 py-1.5 font-medium text-yellow-100 transition-colors hover:bg-yellow-400/10"
			>
				Retry
			</button>
		</div>
	{/if}

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
			class="w-full rounded-md border border-gray-700 bg-gray-900 py-2.5 pr-10 pl-10 text-sm text-gray-50 transition-colors placeholder:text-gray-500 hover:border-gray-600 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
		/>
		{#if searchInput}
			<button
				type="button"
				onclick={clearSearch}
				aria-label="Clear search"
				class="absolute inset-y-0 right-2 flex items-center rounded p-1 text-gray-500 transition-colors hover:text-gray-200"
			>
				<Octicon name="x-circle-fill" size={16} />
			</button>
		{/if}
	</form>

	{#if !searching && (batchesResult.total > 0 || activeTotal > 0 || completedTotal > 0)}
		<div class="grid gap-3 md:grid-cols-3">
			{#if batchesResult.total > 0}
				<a
					href="#batches"
					class="group relative overflow-hidden rounded-md border border-gray-700 bg-gray-900 transition-all hover:border-gray-600 hover:bg-gray-800"
				>
					<span class="absolute inset-x-0 top-0 h-0.5 bg-blue-500"></span>
					<span class="block p-4">
						<span class="flex items-start justify-between gap-3">
							<span class="flex min-w-0 items-center gap-3">
								<span
									class="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-blue-500/10 text-blue-400"
									><Octicon name="stack" size={16} /></span
								>
								<span>
									<span class="block text-[10px] font-semibold uppercase text-gray-500"
										>Migration batches</span
									>
									<span class="mt-1 flex items-baseline gap-1.5">
										<span class="text-3xl leading-none font-semibold text-gray-50 tabular-nums"
											>{batchesResult.total}</span
										><span class="text-xs text-gray-500">total</span>
									</span>
								</span>
							</span>
							<Octicon name="arrow-down" size={16} class="text-gray-500" />
						</span>
						<span
							class="mt-4 flex items-center gap-1.5 border-t border-gray-700/70 pt-3 text-xs text-gray-500"
						>
							<Octicon name="clock" size={12} />
							{#if newestBatch}Newest batch started {timeAgo(newestBatch.startedAt)}{:else}All repositories{/if}
						</span>
					</span>
				</a>
			{/if}
			{#if activeTotal > 0}
				<a
					href="#active"
					class="group relative overflow-hidden rounded-md border border-gray-700 bg-gray-900 transition-all hover:border-gray-600 hover:bg-gray-800"
				>
					<span class="absolute inset-x-0 top-0 h-0.5 bg-green-500"></span>
					<span class="block p-4">
						<span class="flex items-center justify-between gap-3">
							<span class="flex items-center gap-3">
								<span
									class="flex h-10 w-10 items-center justify-center rounded-md bg-green-500/10 text-green-400"
									><Octicon name="play" size={16} /></span
								>
								<span>
									<span class="block text-[10px] font-semibold uppercase text-gray-500"
										>Active migrations</span
									>
									<span class="mt-1 flex items-baseline gap-1.5"
										><span class="text-3xl leading-none font-semibold text-gray-50 tabular-nums"
											>{activeTotal}</span
										><span class="text-xs text-gray-500">in progress</span></span
									>
								</span>
							</span>
							<Octicon name="arrow-down" size={16} class="text-gray-500" />
						</span>
						<span class="mt-4 flex flex-wrap gap-2 border-t border-gray-700/70 pt-3 text-xs">
							{#if (counts?.running ?? 0) > 0}<span class="text-green-400"
								>{counts?.running} running</span
							>{/if}
							{#if (counts?.queued ?? 0) > 0}<span class="text-violet-400"
								>{counts?.queued} {STATE_LABELS.queued.toLowerCase()}</span
							>{/if}
							{#if (counts?.pending ?? 0) > 0}<span class="text-yellow-400"
								>{counts?.pending} {STATE_LABELS.pending.toLowerCase()}</span
							>{/if}
							{#if (counts?.cancelling ?? 0) > 0}<span class="text-cyan-400"
								>{counts?.cancelling} {STATE_LABELS.cancelling.toLowerCase()}</span
							>{/if}
						</span>
					</span>
				</a>
			{/if}
			{#if completedTotal > 0}
				<a
					href="#completed"
					class="group relative overflow-hidden rounded-md border border-gray-700 bg-gray-900 transition-all hover:border-gray-600 hover:bg-gray-800"
				>
					<span class="absolute inset-x-0 top-0 h-0.5 bg-gray-500"></span>
					<span class="block p-4">
						<span class="flex items-center justify-between gap-3">
							<span class="flex items-center gap-3">
								<span
									class="flex h-10 w-10 items-center justify-center rounded-md bg-gray-700/60 text-gray-300"
									><Octicon name="check-circle" size={16} /></span
								>
								<span>
									<span class="block text-[10px] font-semibold uppercase text-gray-500"
										>Completed migrations</span
									>
									<span class="mt-1 flex items-baseline gap-1.5"
										><span class="text-3xl leading-none font-semibold text-gray-50 tabular-nums"
											>{completedTotal}</span
										><span class="text-xs text-gray-500">total</span></span
									>
								</span>
							</span>
							<Octicon name="arrow-down" size={16} class="text-gray-500" />
						</span>
						<span class="mt-4 flex flex-wrap gap-2 border-t border-gray-700/70 pt-3 text-xs">
							{#if (counts?.succeeded ?? 0) > 0}<span class="text-green-400"
								>{counts?.succeeded} succeeded</span
							>{/if}
							{#if (counts?.failed ?? 0) > 0}<span class="text-red-400"
								>{counts?.failed} failed</span
							>{/if}
							{#if (counts?.cancelled ?? 0) > 0}<span class="text-gray-400"
								>{counts?.cancelled} cancelled</span
							>{/if}
							{#if (counts?.reconciliation_required ?? 0) > 0}<span class="text-orange-400"
								>{counts?.reconciliation_required} to review</span
							>{/if}
						</span>
					</span>
				</a>
			{/if}
		</div>
	{/if}

	{#snippet batchCard(batch: BatchListItem)}
		{@const badge = batchStateBadge(batch)}
		{@const route = batchRoute(batch)}
		{@const donePct = Math.round(pctOf(batch.succeededCount, batch.totalCount))}
		<a
			href="/migrate/batches/{batch.id}"
			class="group relative block overflow-hidden rounded-md border border-gray-700 bg-gray-900 transition-all hover:border-gray-600 hover:bg-gray-800"
		>
			<span class="absolute inset-y-0 left-0 w-1 {badge.accent}"></span>
			<div class="p-4 pl-5">
				<div
					class="grid grid-cols-[minmax(0,1fr)_auto] gap-4 md:grid-cols-[9rem_minmax(18rem,1fr)_5.5rem] md:items-center md:gap-5"
				>
					<div
						class="flex items-center justify-between gap-3 md:block md:border-r md:border-gray-700/80 md:pr-5"
					>
						<div>
							<div class="text-[10px] font-semibold uppercase text-gray-500">Batch size</div>
							<div class="mt-1 flex items-baseline gap-1.5">
								<span class="text-3xl leading-none font-semibold text-gray-50 tabular-nums"
									>{batch.totalCount}</span
								><span class="text-xs text-gray-500">repositories</span>
							</div>
						</div>
						{#if badge.live}
							<span class="inline-flex items-center gap-1.5 text-xs font-medium {badge.style}">
								<span class="relative flex h-2 w-2" aria-hidden="true">
									<span
										class="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-40 motion-reduce:animate-none"
									></span>
									<span class="relative inline-flex h-2 w-2 rounded-full bg-green-400"></span>
								</span>
								{badge.label}
							</span>
						{:else}
							<span class="rounded-full px-2 py-0.5 text-xs font-medium {badge.style}"
								>{badge.label}</span
							>
						{/if}
					</div>

					{#if route}
						<div
							class="col-span-2 grid min-w-0 grid-cols-[minmax(0,1fr)_3rem_minmax(0,1fr)] items-center md:col-span-1"
							title={`${route.source.displayName} to ${route.target.displayName}`}
						>
							<div class="min-w-0">
								<div class="text-[10px] font-semibold uppercase text-gray-500">Source</div>
								<div class="mt-1.5 flex items-center gap-2 text-sm font-semibold text-gray-200">
									<Octicon name={route.source.icon} size={16} />
									<span class="truncate">{route.source.label}</span>
								</div>
							</div>
							<div class="flex items-center px-1 text-gray-600">
								<span class="h-px flex-1 bg-gray-700"></span>
								<Octicon name="chevron-right" size={16} />
							</div>
							<div class="min-w-0">
								<div class="text-[10px] font-semibold uppercase text-gray-500">Target</div>
								<div class="mt-1.5 flex items-center gap-2 text-sm font-semibold text-gray-200">
									<Octicon name={route.target.icon} size={16} />
									<span class="truncate">{route.target.label}</span>
								</div>
							</div>
						</div>
					{:else}
						<div
							class="col-span-2 flex min-h-12 items-center justify-center gap-2 rounded-md border border-yellow-500/20 bg-yellow-500/5 px-3 text-sm font-medium text-yellow-400 md:col-span-1"
						>
							<Octicon name="arrow-switch" size={16} />Mixed migration paths
						</div>
					{/if}

					<div class="col-start-2 row-start-1 flex items-center gap-3 md:col-auto md:row-auto">
						<div
							class="relative flex h-16 w-16 shrink-0 items-center justify-center rounded-full"
							style={`background: conic-gradient(var(--color-green-500) ${donePct}%, var(--color-gray-700) 0)`}
							role="img"
							aria-label={`${donePct}% complete`}
						>
							<span
								class="absolute inset-1 rounded-full bg-gray-900 transition-colors group-hover:bg-gray-800"
							></span>
							<span class="relative text-sm font-semibold text-gray-100 tabular-nums">{donePct}%</span>
						</div>
						<Octicon name="chevron-right" size={16} class="text-gray-600" />
					</div>
				</div>

				<div
					class="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-gray-700/70 pt-3"
				>
					<div class="flex flex-wrap items-center gap-1.5 text-xs tabular-nums">
						{#if batch.succeededCount > 0}<span class="text-green-400"
							>{batch.succeededCount} succeeded</span
						>{/if}
						{#if batch.runningCount > 0}<span class="text-blue-400"
							>{batch.runningCount} running</span
						>{/if}
						{#if batch.cancellingCount > 0}<span class="text-cyan-400"
							>{batch.cancellingCount} {STATE_LABELS.cancelling.toLowerCase()}</span
						>{/if}
						{#if batch.pendingCount > 0}<span class="text-yellow-400"
							>{batch.pendingCount} {STATE_LABELS.pending.toLowerCase()}</span
						>{/if}
						{#if batch.queuedCount > 0}<span class="text-violet-400"
							>{batch.queuedCount} {STATE_LABELS.queued.toLowerCase()}</span
						>{/if}
						{#if batch.failedCount > 0}<span class="text-red-400"
							>{batch.failedCount} failed</span
						>{/if}
						{#if batch.cancelledCount > 0}<span class="text-gray-400"
							>{batch.cancelledCount} cancelled</span
						>{/if}
						{#if batch.reconciliationRequiredCount > 0}<span class="text-orange-400"
							>{batch.reconciliationRequiredCount} to review</span
						>{/if}
					</div>
					<div class="flex items-center gap-2.5 text-xs text-gray-500">
						<span class="inline-flex items-center gap-1"
							><Octicon name="clock" size={12} />Started {timeAgo(batch.startedAt)}</span
						>
						<span class="hidden font-mono text-[10px] text-gray-600 sm:inline"
							>{batch.id.slice(0, 8)}</span
						>
					</div>
				</div>
			</div>
		</a>
	{/snippet}

	{#if searching}
		{#if migrationsResult.total === 0 && batchesResult.total === 0}
			<div
				class="flex flex-col items-center justify-center rounded-md border border-dashed border-gray-600 py-16"
			>
				<Octicon name="search" size={24} class="h-12 w-12 text-gray-500" />
				<p class="mt-4 text-gray-400">No results for “{q}”</p>
				<button
					type="button"
					onclick={clearSearch}
					class="mt-4 flex items-center gap-1.5 rounded-md border border-gray-700 bg-gray-800 px-4 py-2 text-sm text-gray-300 transition-colors hover:bg-gray-700 hover:text-gray-50"
				>
					<Octicon name="x" size={16} />Clear search
				</button>
			</div>
		{/if}

		{#if batchesResult.total > 0}
			<section>
				<h2 class="mb-3 flex items-center gap-2 text-lg font-semibold text-gray-300">
					<Octicon name="stack" size={16} />Matching batches
					<span class="text-sm font-normal text-gray-500">({batchesResult.total})</span>
				</h2>
				<div class="space-y-2">
					{#each batchesResult.data as batch (batch.id)}{@render batchCard(batch)}{/each}
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
					<Octicon name="repo" size={16} />Repositories
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
		{#if batchesResult.data.length > 0}
			<section id="batches" class="scroll-mt-6">
				<h2 class="mb-3 flex items-center gap-2 text-lg font-semibold text-gray-300">
					<Octicon name="stack" size={16} />Batches
				</h2>
				<div class="space-y-2">
					{#each batchesResult.data as batch (batch.id)}{@render batchCard(batch)}{/each}
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

		{#if active.length > 0}
			<section id="active" class="scroll-mt-6">
				<h2 class="mb-3 flex items-center gap-2 text-lg font-semibold text-gray-300">
					<Octicon name="play" size={16} class="text-green-400" />Active
				</h2>
				<div class="space-y-3">
					{#each active as migration (migration.id)}
						<MigrationCard {migration} live={liveById.get(migration.id)} {now} />
					{/each}
				</div>
			</section>
		{/if}

		{#if completed.length > 0}
			<section id="completed" class="scroll-mt-6">
				<h2 class="mb-3 flex items-center gap-2 text-lg font-semibold text-gray-300">
					<Octicon name="check-circle" size={16} class="text-gray-400" />Completed
				</h2>
				<div class="space-y-3">
					{#each completed as migration (migration.id)}
						<MigrationCard {migration} />
					{/each}
				</div>
			</section>
		{/if}

		<Pagination
			page={migrationsResult.page}
			totalPages={migrationsResult.totalPages}
			total={migrationsResult.total}
			limit={migrationsResult.limit}
			onPageChange={goMigrationsPage}
		/>

		{#if migrationsResult.total === 0 && batchesResult.total === 0}
			<div
				class="flex flex-col items-center justify-center rounded-md border border-dashed border-gray-600 py-16"
			>
				<Octicon name="arrow-switch" size={24} class="h-12 w-12 text-gray-500" />
				<p class="mt-4 text-gray-400">No migrations yet</p>
				<a
					href="/migrate/new"
					class="mt-4 flex items-center gap-1.5 rounded-md bg-green-600 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-green-500"
				>
					<Octicon name="rocket" size={16} />Start your first migration
				</a>
			</div>
		{/if}
	{/if}
</div>