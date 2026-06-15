<!-- One profiling run: readiness summary + per-repo consideration matrix. Streams live progress while running. -->
<script lang="ts">
	import type { IconName } from '@primer/octicons';
	import { getContext } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import AuthPill from '$lib/components/AuthPill.svelte';
	import Octicon from '$lib/components/Octicon.svelte';
	import Pagination from '$lib/components/Pagination.svelte';
	import { AUTH_PILL_KEY, type AuthPillContext } from '$lib/context-keys';
	import { formatHours, formatRepoSize, timeAgo } from '$lib/format';
	import { MIGRATION_CONSIDERATIONS } from '$lib/profile/consideration-registry';
	import { createReconnectingEventSource } from '$lib/stores/sse-client';

	let { data } = $props();

	// Live source rate-limit, shared from the layout (same pill the Migrate pages
	// show). A crawl spends source API quota, so surfacing remaining quota here is
	// the relevant "are we close to the limit?" signal. Optional — null if the
	// layout context isn't present (e.g. an isolated render).
	const authPill = getContext<AuthPillContext>(AUTH_PILL_KEY);

	// Prefer freshly-polled data, but only when it's for the run currently shown
	// (on navigation `data.run.id` changes and we fall back to the new snapshot
	// until the next poll). Avoids resetting state from an effect.
	let polled = $state<typeof data | null>(null);
	const fresh = $derived(polled && polled.run.id === data.run.id ? polled : null);
	const run = $derived(fresh?.run ?? data.run);
	const repos = $derived(fresh?.repos ?? data.repos);
	const scale = $derived(fresh?.scale ?? data.scale);

	// Org-wide content-volume tiles (migration scale). `formatRepoSize` handles
	// the disk total; counts get thousands separators. Each gets a matching icon.
	const scaleTiles = $derived(
		[
			{ label: 'Issues', value: scale.issues.toLocaleString(), icon: 'issue-opened' },
			{ label: 'Pull requests', value: scale.pullRequests.toLocaleString(), icon: 'git-pull-request' },
			{ label: 'Commits', value: scale.commits.toLocaleString(), icon: 'git-commit' },
			{ label: 'Branches', value: scale.branches.toLocaleString(), icon: 'git-branch' },
			{ label: 'Tags', value: scale.tags.toLocaleString(), icon: 'tag' },
			{ label: 'Releases', value: scale.releases.toLocaleString(), icon: 'rocket' },
			{ label: 'Total size', value: formatRepoSize(scale.diskUsageKb), icon: 'database' }
		] satisfies Array<{ label: string; value: string; icon: IconName }>
	);

	// Preparation summary + duration estimate (org-level rollups from the server).
	const summary = $derived(fresh?.summary ?? data.summary);
	const estimate = $derived(fresh?.estimate ?? data.estimate);

	// Adjustable parallelism: how many migrations run at once. Seeded with the
	// migrate queue's documented cap (10); the user can tune it and the wall-clock
	// figures recompute live. Literal seed avoids `state_referenced_locally`.
	let parallelism = $state(10);
	const wallLow = $derived(parallelism > 0 ? estimate.totalRepoHoursLow / parallelism : estimate.totalRepoHoursLow);
	const wallHigh = $derived(parallelism > 0 ? estimate.totalRepoHoursHigh / parallelism : estimate.totalRepoHoursHigh);

	// Size-band breakdown tiles (S/M/L/XL repo counts).
	const bandTiles = $derived(
		[
			{ band: 'S', label: '< 100 MiB', value: estimate.bandCounts.S },
			{ band: 'M', label: '< 1 GiB', value: estimate.bandCounts.M },
			{ band: 'L', label: '< 5 GiB', value: estimate.bandCounts.L },
			{ band: 'XL', label: '≥ 5 GiB', value: estimate.bandCounts.XL }
		] as const
	);

	// Org-level resources to recreate on the target (run-level, not per-repo).
	// Only non-zero resources are shown.
	const orgResourceTiles = $derived(
		(
			[
				{ label: 'Actions secrets', value: run.orgResources.actionsSecrets, icon: 'key' },
				{ label: 'Actions variables', value: run.orgResources.actionsVariables, icon: 'note' },
				{ label: 'Dependabot secrets', value: run.orgResources.dependabotSecrets, icon: 'dependabot' },
				{ label: 'Codespaces secrets', value: run.orgResources.codespacesSecrets, icon: 'codespaces' },
				{ label: 'Self-hosted runners', value: run.orgResources.selfHostedRunners, icon: 'server' },
				{ label: 'Custom properties', value: run.orgResources.customProperties, icon: 'list-unordered' }
			] satisfies Array<{ label: string; value: number; icon: IconName }>
		).filter((t) => t.value > 0)
	);

	type RunState = 'running' | 'completed' | 'failed';

	// Registry lookup for consideration labels + severity (client-safe, pure data).
	const considerationMeta = new Map(
		MIGRATION_CONSIDERATIONS.map((c) => [c.id, { label: c.label, severity: c.severity }])
	);
	const sevClass: Record<string, string> = {
		blocker: 'bg-red-500/15 text-red-300 border-red-500/30',
		warn: 'bg-yellow-500/15 text-yellow-300 border-yellow-500/30',
		info: 'bg-gray-700/50 text-gray-300 border-gray-600'
	};
	const sevIcon: Record<string, 'stop' | 'alert' | 'info'> = {
		blocker: 'stop',
		warn: 'alert',
		info: 'info'
	};

	// Insight tone → styling + icon (client-safe literal maps).
	const toneClass: Record<string, string> = {
		opportunity: 'bg-green-500/15 text-green-300 border-green-500/30',
		caution: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
		note: 'bg-gray-700/50 text-gray-300 border-gray-600'
	};
	const toneIcon: Record<string, 'rocket' | 'alert' | 'info'> = {
		opportunity: 'rocket',
		caution: 'alert',
		note: 'info'
	};

	// Organization composition — what kind of repos make up the org, as a share
	// of the evaluated set. Counts reuse the per-repo insight ids (one source of
	// truth for the staleness rule), which are mutually exclusive per repo:
	// empty short-circuits, archived suppresses stale. So the buckets never
	// overlap and partition the org — `active` is the remainder (not empty, not
	// archived, pushed within the staleness window), so the four sum to 100%.
	const composition = $derived.by(() => {
		let empty = 0;
		let archived = 0;
		let stale = 0;
		for (const repo of repos) {
			for (const ins of repo.insights ?? []) {
				if (ins.id === 'empty-repo') empty += 1;
				else if (ins.id === 'archived-move-now') archived += 1;
				else if (ins.id === 'stale-confirm') stale += 1;
			}
		}
		const total = repos.length;
		const active = Math.max(0, total - empty - archived - stale);
		const pctOf = (n: number) => (total > 0 ? Math.round((n / total) * 100) : 0);
		return {
			total,
			active: { count: active, pct: pctOf(active) },
			stale: { count: stale, pct: pctOf(stale) },
			empty: { count: empty, pct: pctOf(empty) },
			archived: { count: archived, pct: pctOf(archived) }
		};
	});

	const stateBadge: Record<RunState, { label: string; cls: string; icon: 'sync' | 'check-circle-fill' | 'x-circle-fill' }> = {
		running: { label: 'Running', cls: 'bg-blue-500/15 text-blue-300', icon: 'sync' },
		completed: { label: 'Completed', cls: 'bg-green-500/15 text-green-300', icon: 'check-circle-fill' },
		failed: { label: 'Failed', cls: 'bg-red-500/15 text-red-300', icon: 'x-circle-fill' }
	};

	const badge = $derived(stateBadge[run.state]);

	// Per-repo drill-down: which repo rows are expanded to reveal their counts.
	// Keyed on the stable `nameWithOwner`, so expansion survives a live refresh.
	type RepoSignalsView = (typeof data)['repos'][number]['signals'];
	const expanded = new SvelteSet<string>();
	function toggleRepo(name: string) {
		if (expanded.has(name)) expanded.delete(name);
		else expanded.add(name);
	}

	// Repo name without the owner prefix — every row shares the org owner (shown
	// in the header), so `owner/` is redundant noise in the table.
	function shortRepoName(nameWithOwner: string): string {
		const slash = nameWithOwner.indexOf('/');
		return slash >= 0 ? nameWithOwner.slice(slash + 1) : nameWithOwner;
	}

	// One repo's individual signal counts, as labelled tiles for the detail row.
	function repoCounts(s: RepoSignalsView): Array<{ label: string; value: string; icon: IconName }> {
		return [
			{ label: 'Issues', value: s.issuesCount.toLocaleString(), icon: 'issue-opened' },
			{ label: 'Pull requests', value: s.pullRequestsCount.toLocaleString(), icon: 'git-pull-request' },
			{ label: 'Commits', value: s.commitsCount.toLocaleString(), icon: 'git-commit' },
			{ label: 'Branches', value: s.branchesCount.toLocaleString(), icon: 'git-branch' },
			{ label: 'Tags', value: s.tagsCount.toLocaleString(), icon: 'tag' },
			{ label: 'Releases', value: s.releasesCount.toLocaleString(), icon: 'rocket' },
			{ label: 'Discussions', value: s.discussionsCount.toLocaleString(), icon: 'comment-discussion' },
			{ label: 'Projects', value: s.projectsV2Count.toLocaleString(), icon: 'project' },
			{ label: 'Environments', value: s.environmentsCount.toLocaleString(), icon: 'server' },
			{ label: 'Stars', value: s.stargazerCount.toLocaleString(), icon: 'star' },
			{ label: 'Watchers', value: s.watcherCount.toLocaleString(), icon: 'eye' },
			{ label: 'Forks', value: s.forkCount.toLocaleString(), icon: 'repo-forked' },
			{ label: 'Protection rules', value: s.branchProtectionRuleCount.toLocaleString(), icon: 'shield' },
			{ label: 'Rulesets', value: s.rulesetCount.toLocaleString(), icon: 'law' },
			{ label: 'Webhooks', value: s.webhooksCount.toLocaleString(), icon: 'webhook' },
			{ label: 'Pages', value: s.hasPages ? 'Yes' : '—', icon: 'browser' },
			{ label: 'Code scanning', value: s.hasCodeScanningAlerts ? 'Yes' : '—', icon: 'codescan' },
			{ label: 'Size', value: formatRepoSize(s.diskUsageKb), icon: 'database' }
		];
	}

	// ── Repository list: client-side search + pagination ───────────────────────
	// Every repo is already loaded (and live-refreshed), so filtering and paging
	// run on the client for instant feedback. Search matches the owner/name.
	const REPOS_PER_PAGE = 25;
	let repoSearch = $state('');
	let repoPage = $state(1);

	const filteredRepos = $derived.by(() => {
		const q = repoSearch.trim().toLowerCase();
		return q ? repos.filter((r) => r.nameWithOwner.toLowerCase().includes(q)) : repos;
	});
	// Clamp the shown page when the filtered set shrinks (no effect needed): the
	// Pagination control sets `repoPage`, and `repoPageSafe` keeps it in range.
	const repoTotalPages = $derived(Math.max(1, Math.ceil(filteredRepos.length / REPOS_PER_PAGE)));
	const repoPageSafe = $derived(Math.min(repoPage, repoTotalPages));
	const pagedRepos = $derived(
		filteredRepos.slice((repoPageSafe - 1) * REPOS_PER_PAGE, repoPageSafe * REPOS_PER_PAGE)
	);

	const pct = $derived(run.totalRepos > 0 ? Math.round((run.profiledRepos / run.totalRepos) * 100) : 0);

	async function refresh() {
		try {
			const res = await fetch(`/api/profile/${data.run.id}`);
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
			url: () => `/api/profile/${id}/events`,
			onMessage: (e, controls) => {
				let msg: { type?: string };
				try {
					msg = JSON.parse(e.data);
				} catch {
					return;
				}
				refresh();
				if (msg.type === 'done') controls.destroy();
			}
		});
		return () => conn.destroy();
	});
</script>

<svelte:head><title>{run.org} — Profile</title></svelte:head>

<div class="space-y-6">
	<header class="flex items-start justify-between">
		<div>
			<h1 class="flex items-center gap-2 text-xl font-semibold text-gray-50">
				<Octicon name="organization" size={24} class="text-gray-500" />
				{run.org}
				<span class="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium {badge.cls}">
					<Octicon name={badge.icon} size={12} class={run.state === 'running' ? 'animate-spin' : ''} />
					{badge.label}
				</span>
			</h1>
			<p class="mt-1 font-mono text-xs text-gray-500">
				{run.sourceApiUrl} · started {timeAgo(run.startedAt)}
				{#if run.apiCalls > 0}· <span title="GitHub API requests this crawl made (REST + GraphQL)">{run.apiCalls.toLocaleString()} API calls</span>{/if}
			</p>
		</div>
		<div class="flex items-center gap-2">
			{#if authPill}
				<AuthPill
					label="Source"
					isApp={authPill.sourceApp}
					rateText={authPill.sourceRateText}
					ratePct={authPill.sourceRatePct}
					migrating={run.state === 'running'}
				/>
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

	<!-- Summary tiles: org composition (readiness/severity lives in Migration summary) -->
	<section class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
		<div class="rounded-lg border border-gray-700 bg-gray-900 p-4">
			<div class="text-2xl font-semibold text-gray-50">{run.profiledRepos}<span class="text-base text-gray-500">/{run.totalRepos}</span></div>
			<div class="mt-1 flex items-center gap-1.5 text-xs text-gray-400">
				<Octicon name="repo" size={12} class="text-gray-500" />
				Repositories profiled
			</div>
			{#if run.state === 'running'}
				<div class="mt-2 h-1.5 overflow-hidden rounded-full bg-gray-800">
					<div class="h-full bg-violet-500 transition-all" style="width: {pct}%"></div>
				</div>
			{/if}
		</div>
		<div class="rounded-lg border border-gray-700 bg-gray-900 p-4">
			<div class="text-2xl font-semibold tabular-nums text-green-400">{composition.active.pct}%</div>
			<div class="mt-1 flex items-center gap-1.5 text-xs text-gray-400">
				<Octicon name="pulse" size={12} class="text-gray-500" />
				Active <span class="text-gray-500">· {composition.active.count.toLocaleString()}</span>
			</div>
		</div>
		<div class="rounded-lg border border-gray-700 bg-gray-900 p-4">
			<div class="text-2xl font-semibold tabular-nums text-amber-400">{composition.stale.pct}%</div>
			<div class="mt-1 flex items-center gap-1.5 text-xs text-gray-400">
				<Octicon name="history" size={12} class="text-gray-500" />
				Stale <span class="text-gray-500">· {composition.stale.count.toLocaleString()}</span>
			</div>
		</div>
		<div class="rounded-lg border border-gray-700 bg-gray-900 p-4">
			<div class="text-2xl font-semibold tabular-nums text-gray-300">{composition.empty.pct}%</div>
			<div class="mt-1 flex items-center gap-1.5 text-xs text-gray-400">
				<Octicon name="circle-slash" size={12} class="text-gray-500" />
				Empty <span class="text-gray-500">· {composition.empty.count.toLocaleString()}</span>
			</div>
		</div>
		<div class="rounded-lg border border-gray-700 bg-gray-900 p-4">
			<div class="text-2xl font-semibold tabular-nums text-sky-400">{composition.archived.pct}%</div>
			<div class="mt-1 flex items-center gap-1.5 text-xs text-gray-400">
				<Octicon name="archive" size={12} class="text-gray-500" />
				Archived <span class="text-gray-500">· {composition.archived.count.toLocaleString()}</span>
			</div>
		</div>
	</section>

	<!-- Migration scale: org-wide content volume -->
	<section>
		<h2 class="mb-3 flex items-center gap-2 text-lg font-semibold text-gray-300">
			<Octicon name="graph" size={16} />
			Migration scale
		</h2>
		<div class="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
			{#each scaleTiles as tile (tile.label)}
				<div class="rounded-lg border border-gray-700 bg-gray-900 p-4">
					<div class="text-xl font-semibold tabular-nums text-gray-50">{tile.value}</div>
					<div class="mt-1 flex items-center gap-1.5 text-xs text-gray-400">
						<Octicon name={tile.icon} size={12} class="text-gray-500" />
						{tile.label}
					</div>
				</div>
			{/each}
		</div>
	</section>

	<!-- Migration summary: preparation checklist + duration estimate -->
	{#if repos.length > 0}
		<section class="space-y-4">
			<h2 class="flex items-center gap-2 text-lg font-semibold text-gray-300">
				<Octicon name="tasklist" size={16} />
				Migration summary
			</h2>

			{#if run.orgRulesetCount > 0}
				<div class="flex items-start gap-2 rounded-md border border-yellow-500/30 bg-yellow-500/10 p-3 text-sm text-yellow-200">
					<Octicon name="law" size={16} class="mt-0.5 shrink-0" />
					<span>
						<span class="font-semibold">{run.orgRulesetCount} organization ruleset{run.orgRulesetCount === 1 ? '' : 's'}</span>
						— not migrated, and an org ruleset (e.g. a commit-author email rule) can fail the migration. Review before migrating.
					</span>
				</div>
			{/if}

			{#if orgResourceTiles.length > 0}
				<div class="rounded-lg border border-gray-700 bg-gray-900 p-4">
					<div class="mb-2 flex items-center gap-1.5 text-sm font-medium text-gray-300">
						<Octicon name="organization" size={16} class="text-gray-500" />
						Organization-level resources to recreate
					</div>
					<div class="grid grid-cols-2 gap-2 sm:grid-cols-3">
						{#each orgResourceTiles as t (t.label)}
							<div class="flex items-center gap-2 rounded-md border border-gray-700/60 bg-gray-950/40 px-2.5 py-2">
								<Octicon name={t.icon} size={16} class="shrink-0 text-gray-500" />
								<div class="min-w-0">
									<div class="text-sm font-semibold tabular-nums text-gray-100">{t.value.toLocaleString()}</div>
									<div class="truncate text-[11px] text-gray-400">{t.label}</div>
								</div>
							</div>
						{/each}
					</div>
					<p class="mt-2 text-[11px] text-gray-500">Org-scoped and not migrated — recreate on the target. Secret values are never exported.</p>
				</div>
			{/if}

			<!-- Readiness rollup -->
			<div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
				<div class="rounded-lg border border-gray-700 bg-gray-900 p-4">
					<div class="flex items-center gap-1.5 text-2xl font-semibold text-red-400"><Octicon name="stop" size={16} />{summary.blockerRepos}</div>
					<div class="mt-1 text-xs text-gray-400">Repos with blockers</div>
				</div>
				<div class="rounded-lg border border-gray-700 bg-gray-900 p-4">
					<div class="flex items-center gap-1.5 text-2xl font-semibold text-yellow-400"><Octicon name="alert" size={16} />{summary.warnRepos}</div>
					<div class="mt-1 text-xs text-gray-400">Repos with warnings</div>
				</div>
				<div class="rounded-lg border border-gray-700 bg-gray-900 p-4">
					<div class="flex items-center gap-1.5 text-2xl font-semibold text-green-400"><Octicon name="check-circle" size={16} />{summary.cleanRepos}</div>
					<div class="mt-1 text-xs text-gray-400">Clean repos</div>
				</div>
				<div class="rounded-lg border border-gray-700 bg-gray-900 p-4">
					<div class="flex items-center gap-1.5 text-2xl font-semibold text-gray-50"><Octicon name="tools" size={16} class="text-gray-500" />{summary.items.length}</div>
					<div class="mt-1 text-xs text-gray-400">Prep items</div>
				</div>
			</div>

			<!-- Duration estimate -->
			<div class="rounded-lg border border-gray-700 bg-gray-900 p-5">
				<div class="flex flex-wrap items-start justify-between gap-4">
					<div>
						<div class="flex items-center gap-2 text-sm font-medium text-gray-300">
							<Octicon name="clock" size={16} class="text-gray-500" />
							Estimated migration time
						</div>
						<div class="mt-2 text-3xl font-semibold tabular-nums text-gray-50">
							{formatHours(wallLow)} – {formatHours(wallHigh)}
						</div>
						<div class="mt-1 text-xs text-gray-500">
							wall-clock at {parallelism} concurrent · {formatHours(estimate.totalRepoHoursLow)} – {formatHours(estimate.totalRepoHoursHigh)} total work
						</div>
					</div>
					<label class="flex flex-col gap-1 text-xs text-gray-400">
						Parallel migrations
						<input
							type="number"
							min="1"
							max="100"
							bind:value={parallelism}
							class="w-24 rounded-md border border-gray-700 bg-gray-950 px-2 py-1 text-sm tabular-nums text-gray-100 focus:border-violet-500 focus:outline-none"
						/>
					</label>
				</div>
				<div class="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
					{#each bandTiles as b (b.band)}
						<div class="flex items-center justify-between rounded-md border border-gray-700/60 bg-gray-950/40 px-3 py-2">
							<div>
								<div class="text-sm font-semibold text-gray-200">{b.band}</div>
								<div class="text-[11px] text-gray-500">{b.label}</div>
							</div>
							<div class="text-lg font-semibold tabular-nums text-gray-100">{b.value}</div>
						</div>
					{/each}
				</div>
				<p class="mt-3 text-[11px] text-gray-500">Rough estimate from repository sizes — calibrate as real migration timings accumulate.</p>
			</div>

			<!-- Preparation checklist -->
			{#if summary.items.length > 0}
				<div class="overflow-hidden rounded-lg border border-gray-700">
					<table class="w-full text-sm">
						<thead class="bg-gray-900 text-left text-xs uppercase tracking-wide text-gray-500">
							<tr>
								<th class="px-4 py-2 font-medium">Consideration</th>
								<th class="px-4 py-2 font-medium">Prepare</th>
								<th class="px-4 py-2 text-right font-medium">Repos</th>
							</tr>
						</thead>
						<tbody class="divide-y divide-gray-800">
							{#each summary.items as item (item.considerationId)}
								<tr class="bg-gray-950/40">
									<td class="px-4 py-2.5">
										<span class="inline-flex items-center gap-1.5">
											<Octicon
												name={sevIcon[item.severity] ?? 'info'}
												size={12}
												class={item.severity === 'blocker' ? 'text-red-400' : item.severity === 'warn' ? 'text-yellow-400' : 'text-gray-500'}
											/>
											<span class="font-medium text-gray-100">{item.label}</span>
										</span>
									</td>
									<td class="px-4 py-2.5 text-gray-400">{item.routesTo ?? '—'}</td>
									<td class="px-4 py-2.5 text-right font-semibold tabular-nums text-gray-200">{item.affectedRepos}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}

			<!-- Coverage honesty: considerations whose signal isn't gathered yet -->
			{#if summary.notYetCrawled.length > 0}
				<details class="rounded-lg border border-gray-800 bg-gray-900/50 px-4 py-3 text-sm">
					<summary class="cursor-pointer text-gray-400">
						Not yet evaluated ({summary.notYetCrawled.length}) — signals these need aren't gathered yet
					</summary>
					<div class="mt-2 flex flex-wrap gap-1.5">
						{#each summary.notYetCrawled as c (c.considerationId)}
							<span class="inline-flex items-center rounded-full border border-gray-700 px-2 py-0.5 text-xs text-gray-500">{c.label}</span>
						{/each}
					</div>
				</details>
			{/if}
		</section>
	{/if}

	<!-- Per-repo readiness -->
	<section>
		<div class="mb-3 flex flex-wrap items-center justify-between gap-3">
			<h2 class="flex items-center gap-2 text-lg font-semibold text-gray-300">
				<Octicon name="repo" size={16} />
				Repositories
				{#if repos.length > 0}<span class="text-sm font-normal text-gray-500">({filteredRepos.length.toLocaleString()})</span>{/if}
			</h2>
			{#if repos.length > 0}
				<div class="relative">
					<Octicon
						name="search"
						size={16}
						class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500"
					/>
					<input
						type="search"
						bind:value={repoSearch}
						oninput={() => (repoPage = 1)}
						placeholder="Filter repositories…"
						aria-label="Filter repositories"
						class="w-64 rounded-md border border-gray-700 bg-gray-950 py-1.5 pl-9 pr-3 text-sm text-gray-100 placeholder:text-gray-500 focus:border-violet-500 focus:outline-none"
					/>
				</div>
			{/if}
		</div>

		{#if repos.length === 0}
			<div class="flex flex-col items-center justify-center rounded-md border border-dashed border-gray-600 py-12 text-gray-400">
				<Octicon name={run.state === 'running' ? 'sync' : 'inbox'} size={24} class="h-10 w-10 text-gray-500 {run.state === 'running' ? 'animate-spin' : ''}" />
				<p class="mt-3">
					{#if run.state !== 'running'}
						No repositories profiled
					{:else if run.totalRepos > 0}
						Profiling {run.totalRepos.toLocaleString()} repositories… ({run.profiledRepos.toLocaleString()} done)
					{:else}
						Discovering repositories…
					{/if}
				</p>
			</div>
		{:else if filteredRepos.length === 0}
			<div class="flex flex-col items-center justify-center rounded-md border border-dashed border-gray-600 py-12 text-gray-400">
				<Octicon name="search" size={24} class="h-10 w-10 text-gray-500" />
				<p class="mt-3">No repositories match <span class="font-medium text-gray-300">“{repoSearch}”</span></p>
			</div>
		{:else}
			<div class="overflow-hidden rounded-lg border border-gray-700">
				<table class="w-full text-sm">
					<thead class="bg-gray-900 text-left text-xs uppercase tracking-wide text-gray-500">
						<tr>
							<th class="px-4 py-2 font-medium">Repository</th>
							<th class="px-4 py-2 text-center font-medium">Severity</th>
							<th class="px-4 py-2 font-medium">Considerations</th>
							<th class="px-4 py-2 font-medium">Insights</th>
						</tr>
					</thead>
					<tbody class="divide-y divide-gray-800">
						{#each pagedRepos as repo (repo.nameWithOwner)}
							<tr class="bg-gray-950/40 align-top transition-colors hover:bg-gray-900/60">
								<td class="px-4 py-3">
									<button
										type="button"
										onclick={() => toggleRepo(repo.nameWithOwner)}
										aria-expanded={expanded.has(repo.nameWithOwner)}
										title={repo.nameWithOwner}
										class="flex items-center gap-1.5 text-left font-medium text-gray-50 transition-colors hover:text-violet-300"
									>
										<Octicon name={expanded.has(repo.nameWithOwner) ? 'chevron-down' : 'chevron-right'} size={12} class="shrink-0 text-gray-500" />
										{shortRepoName(repo.nameWithOwner)}
									</button>
								</td>
								<td class="px-4 py-3 text-center">
									<span class="inline-flex items-center gap-2 text-xs">
										{#if repo.blockers > 0}<span class="inline-flex items-center gap-0.5 text-red-400"><Octicon name="stop" size={12} />{repo.blockers}</span>{/if}
										{#if repo.warnings > 0}<span class="inline-flex items-center gap-0.5 text-yellow-400"><Octicon name="alert" size={12} />{repo.warnings}</span>{/if}
										{#if repo.infos > 0}<span class="inline-flex items-center gap-0.5 text-gray-400"><Octicon name="info" size={12} />{repo.infos}</span>{/if}
										{#if repo.blockers + repo.warnings + repo.infos === 0}<span class="inline-flex items-center gap-0.5 text-green-400"><Octicon name="check" size={12} />clear</span>{/if}
									</span>
								</td>
								<td class="px-4 py-3">
									{#if repo.applyingConsiderations.length === 0}
										<span class="text-gray-600">—</span>
									{:else}
										<div class="flex flex-wrap gap-1.5">
											{#each repo.applyingConsiderations as item (item.considerationId)}
												{@const meta = considerationMeta.get(item.considerationId)}
												<span
													class="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs {sevClass[meta?.severity ?? 'info']}"
													title={item.evidence}
												>
													{meta?.label ?? item.considerationId}
												</span>
											{/each}
										</div>
									{/if}
								</td>
								<td class="px-4 py-3">
									{#if (repo.insights ?? []).length === 0}
										<span class="text-gray-600">—</span>
									{:else}
										<div class="flex flex-wrap gap-1.5">
											{#each repo.insights as insight (insight.id)}
												<span
													class="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs {toneClass[insight.tone]}"
													title={insight.detail}
												>
													<Octicon name={toneIcon[insight.tone] ?? 'info'} size={12} />
													{insight.label}
												</span>
											{/each}
										</div>
									{/if}
								</td>
							</tr>
							{#if expanded.has(repo.nameWithOwner)}
								<tr class="bg-gray-900/40">
									<td colspan="4" class="px-4 py-4">
										<div class="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
											{#each repoCounts(repo.signals) as c (c.label)}
												<div class="flex items-center gap-2 rounded-md border border-gray-700/60 bg-gray-950/40 px-2.5 py-2">
													<Octicon name={c.icon} size={16} class="shrink-0 text-gray-500" />
													<div class="min-w-0">
														<div class="text-sm font-semibold tabular-nums text-gray-100">{c.value}</div>
														<div class="truncate text-[11px] text-gray-400">{c.label}</div>
													</div>
												</div>
											{/each}
										</div>
										<div class="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500 [&>*:not(:first-child)]:before:mr-3 [&>*:not(:first-child)]:before:text-gray-600 [&>*:not(:first-child)]:before:content-['·']">
											<span class="lowercase">{repo.signals.visibility}</span>
											{#if repo.signals.defaultBranch}<span>default <span class="text-gray-400">{repo.signals.defaultBranch}</span></span>{/if}
											{#if repo.signals.pushedAt}<span>pushed {timeAgo(repo.signals.pushedAt)}</span>{/if}
											{#if repo.signals.isArchived}<span class="text-amber-400">archived</span>{/if}
											{#if repo.signals.isFork}<span>fork</span>{/if}
											{#if repo.signals.isEmpty}<span>empty</span>{/if}
										</div>
									</td>
								</tr>
							{/if}
						{/each}
					</tbody>
				</table>
			</div>
			<Pagination
				page={repoPageSafe}
				totalPages={repoTotalPages}
				total={filteredRepos.length}
				limit={REPOS_PER_PAGE}
				onPageChange={(p) => (repoPage = p)}
			/>
		{/if}
	</section>
</div>
