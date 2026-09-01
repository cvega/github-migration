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
	import type { UsedIconName } from "$lib/icons.generated";
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
	const finished = $derived(
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
	const finishedTotal = $derived(
		counts
			? counts.succeeded +
				counts.failed +
				counts.cancelled +
				counts.reconciliation_required
			: 0,
	);
	function batchStateBadge(batch: BatchListItem): {
		label: string;
		style: string;
		icon: UsedIconName;
		live?: boolean;
	} {
		if (
			batch.runningCount > 0 ||
			batch.pendingCount > 0 ||
			batch.queuedCount > 0 ||
			batch.cancellingCount > 0
		) {
			return { label: "Active", style: "text-blue-400", icon: "sync", live: true };
		}
		if (batch.reconciliationRequiredCount > 0) {
			return {
				label: "Review required",
				style: "text-orange-400",
				icon: "alert",
			};
		}
		if (batch.failedCount > 0 && batch.succeededCount > 0) {
			return {
				label: "Partial",
				style: "text-yellow-400",
				icon: "alert",
			};
		}
		if (batch.failedCount > 0) {
			return {
				label: "Failed",
				style: "text-red-400",
				icon: "x-circle-fill",
			};
		}
		return {
			label: "Complete",
			style: "text-green-400",
			icon: "check-circle-fill",
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

<div class="space-y-6">
	<div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
		<div class="flex items-center gap-3">
			{#if data.logoUrl}
				<img src={data.logoUrl} alt="" class="h-12 w-12 rounded-md border border-gray-700" />
			{/if}
			<div>
				<h1 class="text-2xl font-semibold text-gray-50">Migrations</h1>
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
		<div class="flex flex-wrap items-center gap-x-4 gap-y-2 sm:justify-end">
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

	<search>
		<form onsubmit={submitSearch} class="relative">
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
				class="h-11 w-full rounded-md border border-gray-700 bg-gray-900 pr-10 pl-10 text-sm text-gray-50 transition-colors placeholder:text-gray-500 hover:border-gray-600 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none sm:h-10"
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
	</search>

	{#if !searching && (batchesResult.total > 0 || activeTotal > 0 || finishedTotal > 0)}
		<nav aria-label="Migration views" class="grid min-w-0 grid-cols-3 border-b border-gray-700 sm:flex">
			{#if batchesResult.total > 0}
				<a
					href="#batches"
					class="inline-flex h-12 min-w-0 items-center justify-center gap-1 border-b-2 border-transparent px-0.5 text-xs font-medium text-gray-300 transition-colors hover:border-gray-500 hover:text-gray-50 sm:shrink-0 sm:gap-2 sm:px-3 sm:text-sm"
				>
					<Octicon name="list-unordered" size={16} class="text-gray-400" />
					<span>Batches</span>
					<span class="min-w-5 rounded-full bg-gray-800 px-1 py-0.5 text-center text-xs font-medium tabular-nums text-gray-400 sm:px-2"
						>{batchesResult.total}</span
					>
				</a>
			{/if}
			{#if activeTotal > 0}
				<a
					href="#active"
					class="inline-flex h-12 min-w-0 items-center justify-center gap-1 border-b-2 border-transparent px-0.5 text-xs font-medium text-gray-300 transition-colors hover:border-gray-500 hover:text-gray-50 sm:shrink-0 sm:gap-2 sm:px-3 sm:text-sm"
				>
					<Octicon name="pulse" size={16} class="text-green-400" />
					<span>Active</span>
					<span class="min-w-5 rounded-full bg-gray-800 px-1 py-0.5 text-center text-xs font-medium tabular-nums text-gray-400 sm:px-2"
						>{activeTotal}</span
					>
				</a>
			{/if}
			{#if finishedTotal > 0}
				<a
					href="#finished"
					class="inline-flex h-12 min-w-0 items-center justify-center gap-1 border-b-2 border-transparent px-0.5 text-xs font-medium text-gray-300 transition-colors hover:border-gray-500 hover:text-gray-50 sm:shrink-0 sm:gap-2 sm:px-3 sm:text-sm"
				>
					<Octicon name="check-circle-fill" size={16} class="text-green-400" />
					<span>Finished</span>
					<span class="min-w-5 rounded-full bg-gray-800 px-1 py-0.5 text-center text-xs font-medium tabular-nums text-gray-400 sm:px-2"
						>{finishedTotal}</span
					>
				</a>
			{/if}
		</nav>
	{/if}

	{#snippet batchCard(batch: BatchListItem)}
		{@const badge = batchStateBadge(batch)}
		{@const route = batchRoute(batch)}
		{@const donePct = Math.round(pctOf(batch.succeededCount, batch.totalCount))}
		<div
			class="relative block overflow-hidden border-b border-gray-700 bg-gray-950/40 transition-colors last:border-b-0 hover:bg-gray-900/60"
		>
			<div class="p-3">
				<div
					class="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-2 md:grid-cols-[minmax(12rem,0.8fr)_minmax(16rem,1.2fr)_8rem] md:items-center md:gap-4"
				>
					<div class="min-w-0">
						<a
							href="/migrate/batches/{batch.id}"
							class="text-sm font-semibold text-blue-400 after:absolute after:inset-0 hover:underline focus-visible:outline-2 focus-visible:outline-blue-500"
						>
							{batch.totalCount} {batch.totalCount === 1 ? "repository" : "repositories"} batch
						</a>
						<div class="mt-1 flex items-center gap-2 text-xs">
							<span class="inline-flex items-center gap-1 font-medium text-gray-400">
								<Octicon
									name={badge.icon}
									size={12}
									class="{badge.style} {badge.live ? 'animate-spin' : ''}"
								/>{badge.label}
							</span>
							<span class="font-mono text-xs text-gray-600">{batch.id.slice(0, 8)}</span>
						</div>
					</div>

					<div class="col-span-2 row-start-2 min-w-0 md:col-span-1 md:row-auto">
						{#if route}
							<div
								class="flex min-w-0 items-center gap-2 text-sm text-gray-400"
								title={`${route.source.displayName} to ${route.target.displayName}`}
							>
								<Octicon name={route.source.icon} size={16} class="shrink-0" />
								<span class="truncate font-medium text-gray-300">{route.source.label}</span>
								<Octicon name="arrow-right" size={16} class="shrink-0 text-gray-600" />
								<Octicon name={route.target.icon} size={16} class="shrink-0" />
								<span class="truncate font-medium text-gray-300">{route.target.label}</span>
							</div>
						{:else}
							<div class="flex items-center gap-2 text-sm font-medium text-yellow-400">
								<Octicon name="arrow-switch" size={16} />Mixed migration paths
							</div>
						{/if}
						<div class="mt-1 flex flex-wrap items-center gap-x-2 text-xs tabular-nums">
							{#if batch.succeededCount > 0}<span class="text-green-400">{batch.succeededCount} succeeded</span>{/if}
							{#if batch.runningCount > 0}<span class="text-blue-400">{batch.runningCount} running</span>{/if}
							{#if batch.cancellingCount > 0}<span class="text-cyan-400">{batch.cancellingCount} {STATE_LABELS.cancelling.toLowerCase()}</span>{/if}
							{#if batch.pendingCount > 0}<span class="text-yellow-400">{batch.pendingCount} {STATE_LABELS.pending.toLowerCase()}</span>{/if}
							{#if batch.queuedCount > 0}<span class="text-violet-400">{batch.queuedCount} {STATE_LABELS.queued.toLowerCase()}</span>{/if}
							{#if batch.failedCount > 0}<span class="text-red-400">{batch.failedCount} failed</span>{/if}
							{#if batch.cancelledCount > 0}<span class="text-gray-400">{batch.cancelledCount} cancelled</span>{/if}
							{#if batch.reconciliationRequiredCount > 0}<span class="text-orange-400">{batch.reconciliationRequiredCount} to review</span>{/if}
						</div>
					</div>

					<div class="col-start-2 row-start-1 flex items-center justify-end md:col-auto md:row-auto">
						<div class="w-16 shrink-0 md:w-20" role="img" aria-label={`${donePct}% complete`}>
							<div class="text-right text-xs font-semibold tabular-nums text-gray-200">{donePct}%</div>
							<div class="mt-1 h-1 overflow-hidden rounded-full bg-gray-700">
								<div class="h-full bg-green-500" style:width={`${donePct}%`}></div>
							</div>
							<div class="mt-1 text-right text-xs text-gray-500">{timeAgo(batch.startedAt)}</div>
						</div>
					</div>
				</div>
			</div>
		</div>
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
					<Octicon name="list-unordered" size={16} />Matching batches
					<span class="text-sm font-normal text-gray-500">({batchesResult.total})</span>
				</h2>
				<div class="overflow-hidden rounded-md border border-gray-700">
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
				<div class="overflow-hidden rounded-md border border-gray-700">
					{#each migrationsResult.data as migration (migration.id)}
						<MigrationCard {migration} live={liveById.get(migration.id)} {now} grouped />
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
					<Octicon name="list-unordered" size={16} />Batches
				</h2>
				<div class="overflow-hidden rounded-md border border-gray-700">
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
					<Octicon name="pulse" size={16} class="text-green-400" />Active
				</h2>
				<div class="overflow-hidden rounded-md border border-gray-700">
					{#each active as migration (migration.id)}
						<MigrationCard {migration} live={liveById.get(migration.id)} {now} grouped />
					{/each}
				</div>
			</section>
		{/if}

		{#if finished.length > 0}
			<section id="finished" class="scroll-mt-6">
				<h2 class="mb-3 flex items-center gap-2 text-lg font-semibold text-gray-300">
					<Octicon name="check-circle-fill" size={16} class="text-green-400" />Finished
				</h2>
				<div class="overflow-hidden rounded-md border border-gray-700">
					{#each finished as migration (migration.id)}
						<MigrationCard {migration} grouped />
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