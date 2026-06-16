<!-- One enterprise profiling run: aggregate rollup + its child organization runs. Streams live progress while running. -->
<script lang="ts">
	import { getContext } from 'svelte';
	import AuthPill from '$lib/components/AuthPill.svelte';
	import Octicon from '$lib/components/Octicon.svelte';
	import Pagination from '$lib/components/Pagination.svelte';
	import { AUTH_PILL_KEY, type AuthPillContext } from '$lib/context-keys';
	import { timeAgo } from '$lib/format';
	import { createReconnectingEventSource } from '$lib/stores/sse-client';

	let { data } = $props();

	type RunState = 'running' | 'paused' | 'completed' | 'failed';

	// Live source rate-limit, shared from the layout (same pill the Migrate and
	// org pages show). An enterprise crawl spends source API quota across every
	// org, so remaining quota is the relevant "are we close to the limit?" signal.
	const authPill = getContext<AuthPillContext>(AUTH_PILL_KEY);

	// Prefer freshly-polled data, but only when it's for the run currently shown.
	let polled = $state<typeof data | null>(null);
	const fresh = $derived(polled && polled.run.id === data.run.id ? polled : null);
	const run = $derived(fresh?.run ?? data.run);
	const orgs = $derived(fresh?.orgs ?? data.orgs);

	const stateBadge: Record<
		RunState,
		{ label: string; cls: string; icon: 'sync' | 'pause' | 'check-circle-fill' | 'x-circle-fill' }
	> = {
		running: { label: 'Running', cls: 'bg-blue-500/15 text-blue-300', icon: 'sync' },
		paused: { label: 'Paused', cls: 'bg-amber-500/15 text-amber-300', icon: 'pause' },
		completed: { label: 'Completed', cls: 'bg-green-500/15 text-green-300', icon: 'check-circle-fill' },
		failed: { label: 'Failed', cls: 'bg-red-500/15 text-red-300', icon: 'x-circle-fill' }
	};

	const badge = $derived(stateBadge[run.state]);
	const orgPct = $derived(
		run.totalOrgs > 0 ? Math.round((run.profiledOrgs / run.totalOrgs) * 100) : 0
	);

	async function refresh(id: string) {
		try {
			const res = await fetch(`/api/profile/enterprise/${id}`);
			if (res.ok) polled = await res.json();
		} catch {
			// Non-fatal — keep the last good snapshot.
		}
	}

	// Live updates over SSE while the run is in progress. Keyed on the loaded run
	// id so navigating between runs tears down the old stream and re-subscribes;
	// reads only the loader prop (never `polled`) so a refresh can't re-subscribe.
	$effect(() => {
		const id = data.run.id;
		if (data.run.state !== 'running') return;
		const conn = createReconnectingEventSource({
			url: () => `/api/profile/enterprise/${id}/events`,
			onMessage: (e, controls) => {
				let msg: { type?: string };
				try {
					msg = JSON.parse(e.data);
				} catch {
					return;
				}
				refresh(id);
				if (msg.type === 'done') controls.destroy();
			}
		});
		return () => conn.destroy();
	});

	const tiles = $derived([
		{ label: 'Repositories', value: run.totalRepos.toLocaleString(), icon: 'repo' as const },
		{ label: 'Blockers', value: run.blockers.toLocaleString(), icon: 'stop' as const, tone: 'text-red-400' },
		{ label: 'Warnings', value: run.warnings.toLocaleString(), icon: 'alert' as const, tone: 'text-yellow-400' }
	]);

	// ── Organization list: client-side search + pagination ─────────────────────
	// Every child org is already loaded (and live-refreshed), so filtering and
	// paging run on the client for instant feedback. Search matches the org login.
	const ORGS_PER_PAGE = 25;
	let orgSearch = $state('');
	let orgPage = $state(1);

	const filteredOrgs = $derived.by(() => {
		const q = orgSearch.trim().toLowerCase();
		return q ? orgs.filter((o) => o.org.toLowerCase().includes(q)) : orgs;
	});
	// Clamp the shown page when the filtered set shrinks: the Pagination control
	// sets `orgPage`, and `orgPageSafe` keeps it in range.
	const orgTotalPages = $derived(Math.max(1, Math.ceil(filteredOrgs.length / ORGS_PER_PAGE)));
	const orgPageSafe = $derived(Math.min(orgPage, orgTotalPages));
	const pagedOrgs = $derived(
		filteredOrgs.slice((orgPageSafe - 1) * ORGS_PER_PAGE, orgPageSafe * ORGS_PER_PAGE)
	);
</script>

<svelte:head><title>{run.enterpriseSlug} — Enterprise Profile</title></svelte:head>

<div class="space-y-6">
	<header class="flex items-start justify-between">
		<div>
			<h1 class="flex items-center gap-2 text-xl font-semibold text-gray-50">
				<Octicon name="stack" size={24} class="text-violet-400" />
				{run.enterpriseSlug}
				<span class="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium {badge.cls}">
					<Octicon name={badge.icon} size={12} class={run.state === 'running' ? 'animate-spin' : ''} />
					{badge.label}
				</span>
			</h1>
			<p class="mt-1 font-mono text-xs text-gray-500">{run.sourceApiUrl} · started {timeAgo(run.startedAt)}</p>
		</div>
		<div class="flex items-center gap-3">
			{#if authPill}
				<AuthPill
					label="Source"
					isApp={authPill.sourceApp}
					rateText={authPill.sourceRateText}
					ratePct={authPill.sourceRatePct}
					migrating={run.state === 'running'}
				/>
				<span class="h-4 w-px bg-gray-700" aria-hidden="true"></span>
			{/if}
			<a href="/profile" class="text-sm text-gray-400 transition-colors hover:text-gray-50">← All runs</a>
		</div>
	</header>

	{#if run.failureReason}
		<div class="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">
			<Octicon name="x-circle-fill" size={16} class="mt-0.5 shrink-0" />
			<span>{run.failureReason}</span>
		</div>
	{/if}

	<!-- Aggregate tiles -->
	<section class="grid grid-cols-2 gap-3 sm:grid-cols-4">
		<div class="rounded-lg border border-gray-700 bg-gray-900 p-4">
			<div class="text-2xl font-semibold text-gray-50">{run.profiledOrgs}<span class="text-base text-gray-500">/{run.totalOrgs}</span></div>
			<div class="mt-1 flex items-center gap-1.5 text-xs text-gray-400">
				<Octicon name="organization" size={12} class="text-gray-500" />
				Organizations profiled
			</div>
			{#if run.state === 'running'}
				<div class="mt-2 h-1.5 overflow-hidden rounded-full bg-gray-800">
					<div class="h-full bg-violet-500 transition-all" style="width: {orgPct}%"></div>
				</div>
			{/if}
		</div>
		{#each tiles as tile (tile.label)}
			<div class="rounded-lg border border-gray-700 bg-gray-900 p-4">
				<div class="text-2xl font-semibold tabular-nums {tile.tone ?? 'text-gray-50'}">{tile.value}</div>
				<div class="mt-1 flex items-center gap-1.5 text-xs text-gray-400">
					<Octicon name={tile.icon} size={12} class="text-gray-500" />
					{tile.label}
				</div>
			</div>
		{/each}
	</section>

	<!-- Child organizations -->
	<section>
		<div class="mb-3 flex flex-wrap items-center justify-between gap-3">
			<h2 class="flex items-center gap-2 text-lg font-semibold text-gray-300">
				<Octicon name="organization" size={16} />
				Organizations
				{#if orgs.length > 0}<span class="text-sm font-normal text-gray-500">({filteredOrgs.length.toLocaleString()})</span>{/if}
			</h2>
			{#if orgs.length > 0}
				<div class="relative">
					<Octicon
						name="search"
						size={16}
						class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500"
					/>
					<input
						type="search"
						bind:value={orgSearch}
						oninput={() => (orgPage = 1)}
						placeholder="Filter organizations…"
						aria-label="Filter organizations"
						class="w-64 rounded-md border border-gray-700 bg-gray-950 py-1.5 pl-9 pr-3 text-sm text-gray-100 placeholder:text-gray-500 focus:border-violet-500 focus:outline-none"
					/>
				</div>
			{/if}
		</div>

		{#if orgs.length === 0}
			<div class="flex flex-col items-center justify-center rounded-md border border-dashed border-gray-600 py-12">
				<Octicon name="organization" size={24} class="text-gray-500" />
				<p class="mt-3 text-sm text-gray-400">
					{run.state === 'running' ? 'Enumerating organizations…' : 'No organizations found'}
				</p>
			</div>
		{:else if filteredOrgs.length === 0}
			<div class="flex flex-col items-center justify-center rounded-md border border-dashed border-gray-600 py-12 text-gray-400">
				<Octicon name="search" size={24} class="h-10 w-10 text-gray-500" />
				<p class="mt-3">No organizations match <span class="font-medium text-gray-300">“{orgSearch}”</span></p>
			</div>
		{:else}
			<div class="space-y-2">
				{#each pagedOrgs as org (org.id)}
					{@const ob = stateBadge[org.state]}
					<a
						href="/profile/{org.id}"
						class="flex items-center justify-between rounded-md border border-gray-700 bg-gray-900 p-4 transition-all hover:border-gray-600 hover:bg-gray-800"
					>
						<div class="flex min-w-0 items-center gap-3">
							<Octicon name="organization" size={16} class="text-gray-500" />
							<span class="font-medium text-gray-50">{org.org}</span>
							<span class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium {ob.cls}">
								<Octicon name={ob.icon} size={12} class={org.state === 'running' ? 'animate-spin' : ''} />
								{ob.label}
							</span>
						</div>
						<div class="flex shrink-0 items-center gap-4 text-xs text-gray-400">
							<span>{org.profiledRepos}/{org.totalRepos} repos</span>
							{#if org.blockers > 0}<span class="inline-flex items-center gap-1 text-red-400"><Octicon name="stop" size={12} />{org.blockers}</span>{/if}
							{#if org.warnings > 0}<span class="inline-flex items-center gap-1 text-yellow-400"><Octicon name="alert" size={12} />{org.warnings}</span>{/if}
						</div>
					</a>
				{/each}
			</div>
			<Pagination
				page={orgPageSafe}
				totalPages={orgTotalPages}
				total={filteredOrgs.length}
				limit={ORGS_PER_PAGE}
				onPageChange={(p) => (orgPage = p)}
			/>
		{/if}
	</section>
</div>
