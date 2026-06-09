<!-- Migration analytics dashboard -->
<script lang="ts">
	import { formatElapsed, formatRepoSize } from '$lib/format';
	import Octicon from '$lib/components/Octicon.svelte';
	import SegmentBar from '$lib/components/SegmentBar.svelte';
	import type { IconName } from '@primer/octicons';
	import type { MigrationState } from '$lib/types';

	let { data } = $props();
	const stats = $derived(data.stats);

	// State badge styling, shared with the dashboard cards.
	const stateMeta: Record<MigrationState, { label: string; icon: IconName; bar: string; text: string }> = {
		succeeded: { label: 'Succeeded', icon: 'check-circle', bar: '#22c55e', text: 'text-green-400' },
		running: { label: 'Running', icon: 'sync', bar: '#22c55e', text: 'text-green-400' },
		pending: { label: 'Pending', icon: 'clock', bar: '#facc15', text: 'text-yellow-400' },
		queued: { label: 'Queued', icon: 'hourglass', bar: '#3b82f6', text: 'text-blue-400' },
		failed: { label: 'Failed', icon: 'x-circle-fill', bar: '#ef4444', text: 'text-red-400' },
		cancelled: { label: 'Cancelled', icon: 'skip', bar: '#4b5563', text: 'text-gray-400' }
	};

	const stateOrder: MigrationState[] = ['succeeded', 'running', 'pending', 'queued', 'failed', 'cancelled'];

	// Segments for the state distribution bar (only non-zero states).
	const stateSegments = $derived(
		stateOrder
			.filter((s) => stats.byState[s] > 0)
			.map((s) => ({
				state: s,
				count: stats.byState[s],
				pct: stats.total > 0 ? (stats.byState[s] / stats.total) * 100 : 0,
				...stateMeta[s]
			}))
	);

	// Resource cards (target totals across succeeded migrations).
	const resourceCards: { label: string; icon: IconName; value: number }[] = $derived([
		{ label: 'Commits', icon: 'git-commit', value: stats.resources.commits },
		{ label: 'Pull Requests', icon: 'git-pull-request', value: stats.resources.pullRequests },
		{ label: 'Issues', icon: 'issue-opened', value: stats.resources.issues },
		{ label: 'Branches', icon: 'git-branch', value: stats.resources.branches },
		{ label: 'Tags', icon: 'tag', value: stats.resources.tags },
		{ label: 'Releases', icon: 'package', value: stats.resources.releases }
	]);

	const platformTotal = $derived(stats.platforms.ghes + stats.platforms.ghec);

	// Throughput chart geometry.
	const maxDay = $derived(Math.max(1, ...stats.throughput.map((d) => d.succeeded + d.failed)));

	function fmtNum(n: number): string {
		return n.toLocaleString();
	}
	// Average a total across succeeded migrations (the rows resource counts come from).
	function avgPerSucceeded(total: number): number {
		return stats.byState.succeeded > 0 ? Math.round(total / stats.byState.succeeded) : 0;
	}
	function shortDate(iso: string): string {
		const d = new Date(`${iso}T00:00:00Z`);
		return Number.isNaN(d.getTime())
			? iso
			: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
	}
</script>

<div class="space-y-6">
	<!-- Header -->
	<div class="flex items-center gap-3">
		<Octicon name="graph" size={24} class="text-gray-400" />
		<h1 class="text-2xl font-bold text-gray-50">Migration Statistics</h1>
		<span class="ml-1 rounded-full bg-gray-500/15 px-2.5 py-0.5 text-xs font-medium text-gray-400">
			{fmtNum(stats.total)} total
		</span>
	</div>

	{#if stats.total === 0}
		<div class="rounded-md border border-gray-700 bg-gray-900 p-10 text-center text-gray-400">
			<Octicon name="graph" size={24} class="mx-auto mb-2 text-gray-600" />
			<p>No migrations yet. Stats will appear here once migrations run.</p>
		</div>
	{:else}
		<!-- KPI cards -->
		<div class="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
			<div class="rounded-md border border-gray-700 bg-gray-900 p-4">
				<div class="flex items-center gap-1.5 text-xs text-gray-500"><Octicon name="check-circle" size={12} />Success rate</div>
				<div class="mt-1 text-2xl font-bold text-green-400">{stats.successRate}%</div>
				<div class="mt-0.5 text-xs text-gray-500">{fmtNum(stats.byState.succeeded)} of {fmtNum(stats.finished)} finished</div>
			</div>
			<div class="rounded-md border border-gray-700 bg-gray-900 p-4">
				<div class="flex items-center gap-1.5 text-xs text-gray-500"><Octicon name="stopwatch" size={12} />Avg duration</div>
				<div class="mt-1 text-2xl font-bold text-gray-50">{formatElapsed(stats.duration.avgSeconds)}</div>
				<div class="mt-0.5 text-xs text-gray-500">{formatElapsed(stats.duration.totalSeconds)} total</div>
			</div>
			<div class="rounded-md border border-gray-700 bg-gray-900 p-4">
				<div class="flex items-center gap-1.5 text-xs text-gray-500"><Octicon name="database" size={12} />Data migrated</div>
				<div class="mt-1 text-2xl font-bold text-gray-50">{formatRepoSize(stats.data.totalKb)}</div>
				<div class="mt-0.5 text-xs text-gray-500">{formatRepoSize(stats.data.avgKb)} avg / repo</div>
			</div>
			<div class="rounded-md border border-gray-700 bg-gray-900 p-4">
				<div class="flex items-center gap-1.5 text-xs text-gray-500"><Octicon name="sync" size={12} />In progress</div>
				<div class="mt-1 text-2xl font-bold text-gray-50">{fmtNum(stats.byState.running + stats.byState.pending + stats.byState.queued)}</div>
				<div class="mt-0.5 text-xs text-gray-500">{fmtNum(stats.byState.running)} running</div>
			</div>
			<div class="rounded-md border border-gray-700 bg-gray-900 p-4">
				<div class="flex items-center gap-1.5 text-xs text-gray-500"><Octicon name="stack" size={12} />Batches</div>
				<div class="mt-1 text-2xl font-bold text-gray-50">{fmtNum(stats.batches)}</div>
				<div class="mt-0.5 text-xs text-gray-500">{fmtNum(stats.byState.failed)} failed migrations</div>
			</div>
		</div>

		<!-- State distribution -->
		<div class="rounded-md border border-gray-700 bg-gray-900 p-5">
			<h2 class="mb-3 text-sm font-medium text-gray-300">Status Distribution</h2>
			<SegmentBar segments={stateSegments.map((s) => ({ value: s.count, color: s.bar }))} />
			<div class="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm">
				{#each stateSegments as seg (seg.state)}
					<span class="inline-flex items-center gap-1 {seg.text}">
						<Octicon name={seg.icon} size={12} />{fmtNum(seg.count)} {seg.label.toLowerCase()}
					</span>
				{/each}
			</div>
		</div>

		<!-- Resources moved -->
		<div class="rounded-md border border-gray-700 bg-gray-900 p-5">
			<h2 class="mb-3 text-sm font-medium text-gray-300">Resources Migrated</h2>
			<div class="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
				{#each resourceCards as r (r.label)}
					<div class="flex flex-col items-center rounded-md bg-gray-800/40 p-3 text-center">
						<Octicon name={r.icon} size={16} class="text-gray-500" />
						<div class="mt-1.5 text-lg font-semibold text-gray-50">{fmtNum(r.value)}</div>
						<div class="text-xs text-gray-500">{r.label}</div>
					</div>
				{/each}
			</div>
		</div>

		<!-- Highlights -->
		<div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
			<div class="rounded-md border border-gray-700 bg-gray-900 p-4">
				<div class="flex items-center gap-1.5 text-xs text-gray-500"><Octicon name="zap" size={12} />Fastest</div>
				{#if stats.records.fastest}
					<div class="mt-1 text-lg font-semibold text-green-400">{formatElapsed(stats.records.fastest.seconds)}</div>
					<div class="mt-0.5 truncate text-xs text-gray-500" title={stats.records.fastest.repo}>{stats.records.fastest.repo}</div>
				{:else}
					<div class="mt-1 text-lg font-semibold text-gray-500">—</div>
				{/if}
			</div>
			<div class="rounded-md border border-gray-700 bg-gray-900 p-4">
				<div class="flex items-center gap-1.5 text-xs text-gray-500"><Octicon name="hourglass" size={12} />Slowest</div>
				{#if stats.records.slowest}
					<div class="mt-1 text-lg font-semibold text-yellow-400">{formatElapsed(stats.records.slowest.seconds)}</div>
					<div class="mt-0.5 truncate text-xs text-gray-500" title={stats.records.slowest.repo}>{stats.records.slowest.repo}</div>
				{:else}
					<div class="mt-1 text-lg font-semibold text-gray-500">—</div>
				{/if}
			</div>
			<div class="rounded-md border border-gray-700 bg-gray-900 p-4">
				<div class="flex items-center gap-1.5 text-xs text-gray-500"><Octicon name="database" size={12} />Largest repo</div>
				{#if stats.data.largestRepo}
					<div class="mt-1 text-lg font-semibold text-gray-50">{formatRepoSize(stats.data.largestKb)}</div>
					<div class="mt-0.5 truncate text-xs text-gray-500" title={stats.data.largestRepo}>{stats.data.largestRepo}</div>
				{:else}
					<div class="mt-1 text-lg font-semibold text-gray-500">—</div>
				{/if}
			</div>
			<div class="rounded-md border border-gray-700 bg-gray-900 p-4">
				<div class="flex items-center gap-1.5 text-xs text-gray-500"><Octicon name="alert" size={12} />Warnings</div>
				<div class="mt-1 text-lg font-semibold text-gray-50">{fmtNum(stats.warnings.total)}</div>
				<div class="mt-0.5 text-xs text-gray-500">across {fmtNum(stats.warnings.withWarnings)} migrations</div>
			</div>
		</div>

		<div class="grid gap-6 lg:grid-cols-2">
			<!-- Platforms -->
			<div class="rounded-md border border-gray-700 bg-gray-900 p-5">
				<h2 class="mb-3 flex items-center gap-2 text-sm font-medium text-gray-300">
					<Octicon name="arrow-switch" size={16} class="text-gray-500" />Source Platform
				</h2>
				{#if platformTotal > 0}
					<SegmentBar
						segments={[
							{ value: stats.platforms.ghes, color: '#a855f7' },
							{ value: stats.platforms.ghec, color: '#3b82f6' }
						]}
					/>
					<div class="mt-1.5 flex items-center justify-between text-xs text-gray-500">
						<span>{platformTotal > 0 ? Math.round((stats.platforms.ghes / platformTotal) * 100) : 0}% GHES</span>
						<span>{platformTotal > 0 ? Math.round((stats.platforms.ghec / platformTotal) * 100) : 0}% GHEC</span>
					</div>
					<div class="mt-4 grid grid-cols-2 gap-3">
						<div class="rounded-md border border-purple-500/20 bg-purple-500/5 p-3">
							<div class="inline-flex items-center gap-1.5 text-sm font-medium text-purple-400">
								<Octicon name="server" size={16} />GHES
							</div>
							<div class="mt-2 space-y-1 text-xs">
								<div class="flex justify-between text-gray-400"><span>Total</span><span class="font-medium text-gray-200">{fmtNum(stats.platforms.ghes)}</span></div>
								<div class="flex justify-between text-gray-400"><span>Finished</span><span class="font-medium text-gray-200">{fmtNum(stats.platformSuccess.ghes.finished)}</span></div>
								<div class="flex justify-between text-gray-400"><span>Succeeded</span><span class="font-medium text-green-400">{fmtNum(stats.platformSuccess.ghes.succeeded)}</span></div>
								<div class="flex justify-between text-gray-400"><span>Success rate</span><span class="font-medium text-gray-200">{stats.platformSuccess.ghes.rate}%</span></div>
							</div>
						</div>
						<div class="rounded-md border border-blue-500/20 bg-blue-500/5 p-3">
							<div class="inline-flex items-center gap-1.5 text-sm font-medium text-blue-400">
								<Octicon name="cloud" size={16} />GHEC
							</div>
							<div class="mt-2 space-y-1 text-xs">
								<div class="flex justify-between text-gray-400"><span>Total</span><span class="font-medium text-gray-200">{fmtNum(stats.platforms.ghec)}</span></div>
								<div class="flex justify-between text-gray-400"><span>Finished</span><span class="font-medium text-gray-200">{fmtNum(stats.platformSuccess.ghec.finished)}</span></div>
								<div class="flex justify-between text-gray-400"><span>Succeeded</span><span class="font-medium text-green-400">{fmtNum(stats.platformSuccess.ghec.succeeded)}</span></div>
								<div class="flex justify-between text-gray-400"><span>Success rate</span><span class="font-medium text-gray-200">{stats.platformSuccess.ghec.rate}%</span></div>
							</div>
						</div>
					</div>
				{:else}
					<p class="text-sm text-gray-500">No data.</p>
				{/if}
			</div>

			<!-- Top source orgs -->
			<div class="rounded-md border border-gray-700 bg-gray-900 p-5">
				<h2 class="mb-1 flex items-center gap-2 text-sm font-medium text-gray-300">
					<Octicon name="organization" size={16} class="text-gray-500" />Top Source Organizations
				</h2>
				<p class="mb-3 text-xs text-gray-500">Repositories migrated, by source org</p>
				{#if stats.topOrgs.length > 0}
					{@const maxOrgCount = Math.max(...stats.topOrgs.map((o) => o.count))}
					<ul class="space-y-2">
						{#each stats.topOrgs.slice(0, 5) as o (o.org)}
							{@const pct = maxOrgCount > 0 ? (o.count / maxOrgCount) * 100 : 0}
							<li class="text-sm">
								<div class="mb-1 flex items-center justify-between">
									<span class="inline-flex items-center gap-1.5 text-gray-300"><Octicon name="repo" size={12} class="text-gray-500" />{o.org}</span>
									<span class="text-xs text-gray-500">{fmtNum(o.count)} repos</span>
								</div>
								<div class="h-1.5 overflow-hidden rounded-full bg-gray-800">
									<div class="h-full rounded-full bg-blue-500/70" style="width: {pct}%"></div>
								</div>
							</li>
						{/each}
					</ul>
				{:else}
					<p class="text-sm text-gray-500">No data.</p>
				{/if}
			</div>
		</div>

		<div class="grid gap-6 lg:grid-cols-2">
			<!-- Failures by reason -->
			<div class="rounded-md border border-gray-700 bg-gray-900 p-5">
				<h2 class="mb-3 flex items-center gap-2 text-sm font-medium text-gray-300">
					<Octicon name="alert" size={16} class="text-red-400" />Top Failure Reasons
				</h2>
				{#if stats.failuresByReason.length > 0}
					<ul class="space-y-2">
						{#each stats.failuresByReason.slice(0, 5) as f (f.reason)}
							<li class="flex items-start justify-between gap-3">
								<span class="rounded bg-gray-950 px-1.5 py-0.5 font-mono text-[9px] leading-3 text-red-300 ring-1 ring-inset ring-red-500/20">{f.reason}</span>
								<span class="shrink-0 rounded-full bg-red-500/15 px-2 py-0.5 text-xs font-medium text-red-400">{fmtNum(f.count)}</span>
							</li>
						{/each}
					</ul>
				{:else}
					<p class="inline-flex items-center gap-1.5 text-sm text-green-400"><Octicon name="check-circle" size={12} />No failures recorded.</p>
				{/if}
			</div>

			<!-- Resource averages -->
			<div class="rounded-md border border-gray-700 bg-gray-900 p-5">
				<h2 class="mb-3 flex items-center gap-2 text-sm font-medium text-gray-300">
					<Octicon name="pulse" size={16} class="text-gray-500" />Per-Migration Averages
				</h2>
				<dl class="space-y-2 text-sm">
					<div class="flex items-center justify-between">
						<dt class="inline-flex items-center gap-1.5 text-gray-400"><Octicon name="stopwatch" size={12} />Duration</dt>
						<dd class="text-gray-50">{formatElapsed(stats.duration.avgSeconds)}</dd>
					</div>
					<div class="flex items-center justify-between">
						<dt class="inline-flex items-center gap-1.5 text-gray-400"><Octicon name="database" size={12} />Repo size</dt>
						<dd class="text-gray-50">{formatRepoSize(stats.data.avgKb)}</dd>
					</div>
					<div class="flex items-center justify-between">
						<dt class="inline-flex items-center gap-1.5 text-gray-400"><Octicon name="git-commit" size={12} />Commits</dt>
						<dd class="text-gray-50">{fmtNum(avgPerSucceeded(stats.resources.commits))}</dd>
					</div>
					<div class="flex items-center justify-between">
						<dt class="inline-flex items-center gap-1.5 text-gray-400"><Octicon name="issue-opened" size={12} />Issues</dt>
						<dd class="text-gray-50">{fmtNum(avgPerSucceeded(stats.resources.issues))}</dd>
					</div>
					<div class="flex items-center justify-between">
						<dt class="inline-flex items-center gap-1.5 text-gray-400"><Octicon name="git-pull-request" size={12} />Pull requests</dt>
						<dd class="text-gray-50">{fmtNum(avgPerSucceeded(stats.resources.pullRequests))}</dd>
					</div>
				</dl>
			</div>
		</div>

		<!-- Throughput over time -->
		{#if stats.throughput.length > 0}
			{@const firstDay = stats.throughput[0]}
			{@const lastDay = stats.throughput[stats.throughput.length - 1]}
			<div class="rounded-md border border-gray-700 bg-gray-900 p-5">
				<h2 class="mb-4 text-sm font-medium text-gray-300">Completions Over Time</h2>
				<div class="flex items-end gap-1 overflow-x-auto pb-1" style="height: 140px;">
					{#each stats.throughput as day (day.date)}
						<div class="flex h-full min-w-3.5 flex-1 flex-col justify-end" title="{shortDate(day.date)}: {fmtNum(day.succeeded)} succeeded, {fmtNum(day.failed)} failed">
							<div class="flex flex-col-reverse">
								{#if day.succeeded > 0}
									<div style="height: {(day.succeeded / maxDay) * 110}px; background: #22c55e;" class="rounded-sm"></div>
								{/if}
								{#if day.failed > 0}
									<div style="height: {(day.failed / maxDay) * 110}px; background: #ef4444;" class="rounded-sm"></div>
								{/if}
							</div>
						</div>
					{/each}
				</div>
				<div class="mt-3 flex items-center justify-between text-xs text-gray-500">
					<span>{firstDay ? shortDate(firstDay.date) : ''}</span>
					<span class="flex items-center gap-3">
						<span class="inline-flex items-center gap-1"><span class="inline-block h-2 w-2 rounded-sm bg-green-500"></span>Succeeded</span>
						<span class="inline-flex items-center gap-1"><span class="inline-block h-2 w-2 rounded-sm bg-red-500"></span>Failed</span>
					</span>
					<span>{lastDay ? shortDate(lastDay.date) : ''}</span>
				</div>
			</div>
		{/if}

		<div class="flex justify-center">
			<a href="/" class="inline-flex items-center gap-1.5 text-sm text-gray-400 hover:text-gray-50 transition-colors">
				<Octicon name="arrow-left" size={16} />
				Back to Dashboard
			</a>
		</div>
	{/if}
</div>
