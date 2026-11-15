<!-- Migration analytics dashboard -->
<script lang="ts">
	import Octicon from '$lib/components/Octicon.svelte';
	import { formatElapsed, formatRepoSize } from '$lib/format';
	import type { UsedIconName as IconName } from '$lib/icons.generated';
	import { STATE_LABELS } from '$lib/migrate/migration-display';
	import type { MigrationDirectionStats, MigrationState } from '$lib/migrate/types';
	import { getTargetPlatformPresentation } from '$lib/migration-target';
	import { REPOSITORY_SIZE_BANDS, type RepositorySizeBand } from '$lib/repository-size';
	import { getSourceProviderAdapter } from '$lib/source-provider';
	import FilterMenu from './FilterMenu.svelte';

	let { data } = $props();
	const stats = $derived(data.stats);
	const filters = $derived(data.filters);
	const hasActiveFilters = $derived(
		filters.period !== 'all' ||
			filters.sourceProvider !== 'all' ||
			filters.targetPlatform !== 'all' ||
			filters.mode !== 'all',
	);
	const periodOptions = [
		{ value: '30d', label: '30 days' },
		{ value: '90d', label: '90 days' },
		{ value: 'all', label: 'All time' },
	] as const;
	const modeOptions = [
		{ value: 'all', label: 'All modes', icon: null },
		{ value: 'single', label: 'Single', icon: 'repo' },
		{ value: 'batch', label: 'Batch', icon: 'stack' },
	] as const;
	const sourceFilterOptions = $derived([
		{ value: 'all', label: 'All sources', href: statsFilterHref({ source: 'all' }) },
		{ value: 'github', label: 'GitHub', href: statsFilterHref({ source: 'github' }) },
		{ value: 'gitlab', label: 'GitLab', href: statsFilterHref({ source: 'gitlab' }) },
		{
			value: 'bitbucket-server',
			label: 'Bitbucket Server',
			href: statsFilterHref({ source: 'bitbucket-server' }),
		},
	]);
	const targetFilterOptions = $derived([
		{ value: 'all', label: 'All targets', href: statsFilterHref({ target: 'all' }) },
		{
			value: 'ghec',
			label: 'GitHub Enterprise Cloud',
			href: statsFilterHref({ target: 'ghec' }),
		},
		{
			value: 'ghes',
			label: 'GitHub Enterprise Server',
			href: statsFilterHref({ target: 'ghes' }),
		},
	]);

	const stateMeta: Record<MigrationState, { label: string; icon: IconName; text: string; live?: boolean }> = {
		succeeded: { label: STATE_LABELS.succeeded, icon: 'check-circle-fill', text: 'text-green-400' },
		running: { label: STATE_LABELS.running, icon: 'sync', text: 'text-green-400', live: true },
		cancelling: { label: STATE_LABELS.cancelling, icon: 'stopwatch', text: 'text-cyan-400', live: true },
		pending: { label: STATE_LABELS.pending, icon: 'clock', text: 'text-yellow-400' },
		queued: { label: STATE_LABELS.queued, icon: 'hourglass', text: 'text-violet-400' },
		failed: { label: STATE_LABELS.failed, icon: 'x-circle-fill', text: 'text-red-400' },
		cancelled: { label: STATE_LABELS.cancelled, icon: 'skip', text: 'text-gray-400' },
		reconciliation_required: {
			label: STATE_LABELS.reconciliation_required,
			icon: 'alert',
			text: 'text-orange-300',
		},
	};

	const stateOrder: MigrationState[] = [
		'succeeded',
		'running',
		'cancelling',
		'pending',
		'queued',
		'failed',
		'reconciliation_required',
		'cancelled',
	];

	const stateSegments = $derived(
		stateOrder
			.filter((state) => stats.byState[state] > 0)
			.map((state) => ({
				state,
				count: stats.byState[state],
				pct: stats.total > 0 ? (stats.byState[state] / stats.total) * 100 : 0,
				...stateMeta[state],
			})),
	);

	const resourceCards: { label: string; icon: IconName; value: number }[] = $derived([
		{ label: 'Commits', icon: 'git-commit', value: stats.resources.commits },
		{ label: 'Pull Requests', icon: 'git-pull-request', value: stats.resources.pullRequests },
		{ label: 'Issues', icon: 'issue-opened', value: stats.resources.issues },
		{ label: 'Branches', icon: 'git-branch', value: stats.resources.branches },
		{ label: 'Tags', icon: 'tag', value: stats.resources.tags },
		{ label: 'Releases', icon: 'package', value: stats.resources.releases },
	]);

	const directionTotal = $derived(
		stats.directions.reduce((total, direction) => total + direction.total, 0),
	);
	function directionSource(direction: MigrationDirectionStats) {
		if (direction.sourceProvider === 'github') {
			return getTargetPlatformPresentation(direction.githubSourcePlatform ?? 'ghes');
		}
		return getSourceProviderAdapter(direction.sourceProvider).sourcePlatform(null);
	}

	const directions = $derived(
		stats.directions.map((direction) => {
			const source = directionSource(direction);
			const target = getTargetPlatformPresentation(direction.targetPlatform);
			return {
				key: `${direction.sourceProvider}:${direction.githubSourcePlatform ?? 'native'}:${direction.targetPlatform}`,
				label: `${source.label} → ${target.label}`,
				sourceLabel: source.label,
				targetLabel: target.label,
				sourceIcon: source.icon,
				targetIcon: target.icon,
				total: direction.total,
				success: direction,
			};
		}),
	);
	const visibleTopOrgs = $derived(
		stats.topOrgs.slice(0, Math.min(stats.topOrgs.length, Math.max(3, directions.length))),
	);

	const chartDays = $derived(stats.throughput.slice(-30));
	const maxChartDay = $derived(Math.max(1, ...chartDays.map((day) => day.succeeded + day.failed)));
	const middleChartValue = $derived(Math.ceil(maxChartDay / 2));
	const recentDailyAverage = $derived(Math.round((stats.recentWindow.completed / 7) * 10) / 10);

	function fmtNum(value: number): string {
		return value.toLocaleString();
	}
	function statsFilterHref(overrides: { source?: string; target?: string }): string {
		const params = new URLSearchParams({
			source: overrides.source ?? filters.sourceProvider,
			target: overrides.target ?? filters.targetPlatform,
			period: filters.period,
			mode: filters.mode,
		});
		return `/migrate/stats?${params.toString()}`;
	}
	function avgPerCountedMigration(total: number): number {
		return stats.resources.migrationCount > 0
			? Math.round(total / stats.resources.migrationCount)
			: 0;
	}
	function shortDate(iso: string): string {
		const date = new Date(`${iso}T00:00:00Z`);
		return Number.isNaN(date.getTime())
			? iso
			: date.toLocaleDateString(undefined, {
					month: 'short',
					day: 'numeric',
					timeZone: 'UTC',
				});
	}
	function daySuccessRate(succeeded: number, failed: number): string {
		const total = succeeded + failed;
		return total > 0 ? `${Math.round((succeeded / total) * 1000) / 10}%` : 'No completions';
	}
	function sizeBandLabel(band: RepositorySizeBand): string {
		return REPOSITORY_SIZE_BANDS.find((definition) => definition.band === band)?.label ?? band;
	}
</script>

<div class="space-y-7">
	<div class="flex flex-wrap items-end justify-between gap-3 border-b border-gray-700 pb-4">
		<div>
			<h1 class="flex items-center gap-2 text-xl font-semibold text-gray-50"><Octicon name="graph" size={24} class="text-gray-500" />Migration statistics</h1>
			<p class="mt-1 text-sm text-gray-500">Outcomes, throughput, and performance across migration history</p>
		</div>
		<div class="flex items-baseline gap-2 tabular-nums">
			<span class="text-2xl font-semibold text-gray-100">{fmtNum(stats.total)}</span>
			<span class="text-sm text-gray-500">{hasActiveFilters ? 'matching migrations' : 'total migrations'}</span>
		</div>
	</div>

	<form
		method="GET"
		class="stats-filters"
		aria-label="Statistics filters"
	>
		<FilterMenu
			id="stats-source-filter"
			name="source"
			label="Source"
			icon="repo"
			value={filters.sourceProvider}
			options={sourceFilterOptions}
			minWidth="0"
		/>

		<FilterMenu
			id="stats-target-filter"
			name="target"
			label="Target"
			icon="repo-push"
			value={filters.targetPlatform}
			options={targetFilterOptions}
			minWidth="0"
		/>

		<fieldset class="min-w-0">
			<legend class="mb-1.5 text-xs font-medium text-gray-400">
				<span class="inline-flex items-center gap-1.5"
					><Octicon name="calendar" size={12} class="text-blue-400" />Started</span
				>
			</legend>
			<div class="stats-segmented">
				{#each periodOptions as option (option.value)}
					<label
						class="stats-segment"
					>
						<input
							class="sr-only"
							type="radio"
							name="period"
							value={option.value}
							checked={filters.period === option.value}
							onchange={(event) => event.currentTarget.form?.requestSubmit()}
						/>
						{option.label}
					</label>
				{/each}
			</div>
		</fieldset>

		<fieldset class="min-w-0">
			<legend class="mb-1.5 text-xs font-medium text-gray-400">
				<span class="inline-flex items-center gap-1.5"><Octicon name="stack" size={12} class="text-blue-400" />Mode</span>
			</legend>
			<div class="stats-segmented">
				{#each modeOptions as option (option.value)}
					<label
						class="stats-segment"
					>
						<input
							class="sr-only"
							type="radio"
							name="mode"
							value={option.value}
							checked={filters.mode === option.value}
							onchange={(event) => event.currentTarget.form?.requestSubmit()}
						/>
						{#if option.icon}<Octicon name={option.icon} size={16} />{/if}
						{option.label}
					</label>
				{/each}
			</div>
		</fieldset>
	</form>

	{#if stats.total === 0}
		<div class="rounded-md border border-gray-700 bg-gray-900 p-10 text-center text-gray-400">
			<Octicon name="graph" size={24} class="mx-auto mb-2 text-gray-600" />
			{#if hasActiveFilters}
				<p>No migrations match these filters.</p>
				<a
					href="/migrate/stats"
					class="mt-4 inline-flex items-center gap-1.5 rounded-md border border-gray-600 bg-gray-800 px-4 py-2 text-sm font-medium text-gray-200 outline-none hover:bg-gray-700 focus-visible:ring-2 focus-visible:ring-blue-400"
				>
					Reset filters
				</a>
			{:else}
				<p>No migrations yet. Stats will appear here once migrations run.</p>
				<a
					href="/migrate/new"
					class="mt-4 inline-flex items-center gap-1.5 rounded-md bg-green-600 px-4 py-2 text-sm font-medium text-white outline-none transition-colors hover:bg-green-500 focus-visible:ring-2 focus-visible:ring-green-300"
				>
					<Octicon name="repo-push" size={16} />
					Start a migration
				</a>
			{/if}
		</div>
	{:else}
		<dl class="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-gray-700 bg-gray-700 sm:grid-cols-3 lg:grid-cols-5">
			<div class="bg-gray-950 px-4 py-4">
				<dt class="flex items-center gap-1.5 text-xs text-gray-500"><Octicon name="check-circle" size={12} class="text-green-400" />Success rate</dt>
				<dd class="mt-1 text-2xl font-semibold tabular-nums text-green-400">{stats.successRate}%</dd>
				<p class="mt-0.5 text-xs text-gray-500">{fmtNum(stats.byState.succeeded)} succeeded · {fmtNum(stats.byState.failed)} failed</p>
			</div>
			<div class="bg-gray-950 px-4 py-4">
				<dt class="flex items-center gap-1.5 text-xs text-gray-500"><Octicon name="stopwatch" size={12} class="text-blue-400" />Duration</dt>
				<dd class="mt-1 flex items-baseline gap-1.5 text-2xl font-semibold tabular-nums text-gray-50">
					{formatElapsed(stats.duration.medianSeconds)} <span class="text-sm font-normal text-gray-400">median</span>
				</dd>
				<p class="mt-0.5 text-xs text-gray-500">
					{formatElapsed(stats.duration.p95Seconds)} p95 ·
					{#if stats.duration.timedCount === stats.duration.eligibleCount}
						{fmtNum(stats.duration.timedCount)} migrations
					{:else}
						{fmtNum(stats.duration.timedCount)} of {fmtNum(stats.duration.eligibleCount)} with duration
					{/if}
				</p>
			</div>
			<div class="bg-gray-950 px-4 py-4">
				<dt class="flex items-center gap-1.5 text-xs text-gray-500"><Octicon name="database" size={12} class="text-blue-400" />Data migrated</dt>
				<dd class="mt-1 text-2xl font-semibold tabular-nums text-gray-50">{formatRepoSize(stats.data.totalKb)}</dd>
				<p class="mt-0.5 text-xs text-gray-500">{formatRepoSize(stats.data.avgKb)} average per repository</p>
			</div>
			<div class="bg-gray-950 px-4 py-4">
				<dt class="flex items-center gap-1.5 text-xs text-gray-500"><Octicon name="sync" size={12} class="text-blue-400" />In progress</dt>
				<dd class="mt-1 text-2xl font-semibold tabular-nums text-gray-50">{fmtNum(stats.active)}</dd>
				<p class="mt-0.5 text-xs text-gray-500">{fmtNum(stats.byState.running)} currently running</p>
			</div>
			<div class="col-span-2 bg-gray-950 px-4 py-4 sm:col-span-1">
				<dt class="flex items-center gap-1.5 text-xs text-gray-500"><Octicon name="stack" size={12} class="text-blue-400" />Batches</dt>
				<dd class="mt-1 text-2xl font-semibold tabular-nums text-gray-50">{fmtNum(stats.batches)}</dd>
				<p class="mt-0.5 text-xs text-gray-500">{fmtNum(stats.byState.failed)} failed migrations</p>
			</div>
		</dl>

		{#if stats.throughput.length > 0}
			{@const firstDay = chartDays[0]}
			{@const middleDay = chartDays[Math.floor((chartDays.length - 1) / 2)]}
			{@const lastDay = chartDays[chartDays.length - 1]}
			<section class="border-y border-gray-700 py-5">
				<div class="flex flex-wrap items-start justify-between gap-3">
					<div>
						<h2 class="flex items-center gap-2 text-sm font-semibold text-gray-200"><Octicon name="graph" size={16} class="text-gray-500" />Completions over time</h2>
						<p class="mt-1 text-xs text-gray-500">{firstDay ? shortDate(firstDay.date) : ''}–{lastDay ? shortDate(lastDay.date) : ''} · daily outcomes</p>
					</div>
					<div class="inline-flex items-center gap-3 text-xs text-gray-500">
							<span class="inline-flex items-center gap-1"><span class="inline-block h-2 w-2 rounded-sm bg-green-500"></span>Succeeded</span>
							<span class="inline-flex items-center gap-1"><span class="inline-block h-2 w-2 rounded-sm bg-red-500"></span>Failed</span>
					</div>
				</div>
				<dl class="my-4 grid grid-cols-2 gap-x-6 gap-y-3 border-y border-gray-700/70 py-3 text-xs sm:grid-cols-4">
					<div><dt class="text-gray-500">Last 7 days</dt><dd class="mt-0.5 font-semibold tabular-nums text-gray-200">{fmtNum(stats.recentWindow.completed)} completed</dd></div>
					<div><dt class="text-gray-500">Previous 7 days</dt><dd class="mt-0.5 font-semibold tabular-nums text-gray-200">{fmtNum(stats.recentWindow.previousCompleted)} completed</dd></div>
					<div><dt class="text-gray-500">Success rate</dt><dd class="mt-0.5 font-semibold tabular-nums text-green-400">{stats.recentWindow.successRate}% <span class="font-normal text-gray-500">· {fmtNum(stats.recentWindow.failed)} failed</span></dd></div>
					<div><dt class="text-gray-500">Daily average</dt><dd class="mt-0.5 font-semibold tabular-nums text-gray-200">{fmtNum(recentDailyAverage)} completed</dd></div>
				</dl>
				<div class="grid grid-cols-[2.25rem_minmax(0,1fr)] gap-2">
					<div class="flex h-40 flex-col justify-between pb-px text-right text-xs tabular-nums text-gray-600" aria-hidden="true">
						<span>{fmtNum(maxChartDay)}</span>
						<span>{fmtNum(middleChartValue)}</span>
						<span>0</span>
					</div>
					<div class="relative h-40 min-w-0">
						<div class="pointer-events-none absolute inset-y-0 right-0 border-l border-dashed border-gray-500 bg-blue-500/5" style:width={`${(Math.min(7, chartDays.length) / chartDays.length) * 100}%`} aria-hidden="true">
							<span class="absolute top-1 right-1 text-xs text-gray-500">Latest 7 days</span>
						</div>
						<div class="pointer-events-none absolute inset-0 flex flex-col justify-between" aria-hidden="true">
							<span class="border-t border-gray-700/70"></span>
							<span class="border-t border-dashed border-gray-700/70"></span>
							<span class="border-t border-gray-700"></span>
						</div>
						<div class="absolute inset-0 flex items-end gap-1 overflow-x-auto">
					{#each chartDays as day, index (day.date)}
						<button type="button" class="group relative flex h-full min-w-2 flex-1 flex-col justify-end outline-none focus-visible:ring-2 focus-visible:ring-blue-400" aria-label="{shortDate(day.date)}: {fmtNum(day.succeeded)} succeeded, {fmtNum(day.failed)} failed, {daySuccessRate(day.succeeded, day.failed)} success rate">
							<span class="pointer-events-none absolute top-1 z-10 hidden w-max max-w-48 rounded-md border border-gray-600 bg-gray-800 px-2.5 py-2 text-left text-xs text-gray-300 shadow-lg group-hover:block group-focus:block {index < 4 ? 'left-0' : index >= chartDays.length - 4 ? 'right-0' : 'left-1/2 -translate-x-1/2'}">
								<strong class="block font-medium text-gray-100">{shortDate(day.date)}</strong>
								<span class="mt-1 block font-medium text-gray-200">{fmtNum(day.succeeded + day.failed)} completed · {daySuccessRate(day.succeeded, day.failed)}</span>
								<span class="block">{fmtNum(day.succeeded)} succeeded</span>
								<span class="block">{fmtNum(day.failed)} failed</span>
							</span>
							<div class="flex h-full w-full flex-col-reverse justify-start pt-2">
								{#if day.succeeded > 0}
									<div style:height={`${(day.succeeded / maxChartDay) * 100}%`} class="min-h-px rounded-b-sm bg-green-500"></div>
								{/if}
								{#if day.failed > 0}
									<div style:height={`${(day.failed / maxChartDay) * 100}%`} class="min-h-px rounded-t-sm bg-red-500"></div>
								{/if}
							</div>
						</button>
					{/each}
						</div>
					</div>
				</div>
				<div class="mt-2 ml-13 grid grid-cols-3 text-xs text-gray-500">
					<span>{firstDay ? shortDate(firstDay.date) : ''}</span>
					<span class="text-center">{middleDay ? shortDate(middleDay.date) : ''}</span>
					<span class="text-right">{lastDay ? shortDate(lastDay.date) : ''}</span>
				</div>
			</section>
		{/if}

		<section class="border-y border-gray-700">
			<div class="flex flex-wrap items-end justify-between gap-2 py-4">
				<div>
					<h2 class="flex items-center gap-2 text-sm font-semibold text-gray-200"><Octicon name="check-circle" size={16} class="text-gray-500" />Migration outcomes</h2>
					<p class="mt-1 text-xs text-gray-500">Current state across matching migrations</p>
				</div>
				<div class="text-right">
					<div class="text-lg font-semibold tabular-nums text-gray-100">{fmtNum(stats.total)}</div>
					<div class="text-xs text-gray-500">total migrations</div>
				</div>
			</div>
			<div class="status-grid grid grid-cols-2 border-t border-gray-700" style:--status-columns={stateSegments.length}>
				{#each stateSegments as seg, index (seg.state)}
					<div class="border-b border-r border-gray-700/70 px-3 py-3 last:border-r-0 lg:border-b-0 {stateSegments.length % 2 === 1 && index === stateSegments.length - 1 ? 'col-span-2 lg:col-span-1' : ''}">
						<div class="flex items-center gap-1.5 text-xs font-medium {seg.text}">
							{#if seg.live}
								<span class="relative flex h-2 w-2" aria-hidden="true">
									<span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-40 motion-reduce:animate-none"></span>
									<span class="relative inline-flex h-2 w-2 rounded-full bg-green-400"></span>
								</span>
							{:else}
								<Octicon name={seg.icon} size={12} />
							{/if}
							{seg.label}
						</div>
						<div class="mt-1.5 flex items-baseline gap-2">
							<span class="text-lg font-semibold tabular-nums text-gray-50">{fmtNum(seg.count)}</span>
							<span class="text-xs tabular-nums text-gray-500">{seg.pct < 0.1 ? '<0.1' : seg.pct.toFixed(1)}%</span>
						</div>
					</div>
				{/each}
			</div>
		</section>

		<section>
			<div class="mb-3 flex flex-wrap items-end justify-between gap-2">
				<div>
					<h2 class="flex items-center gap-2 text-sm font-semibold text-gray-200"><Octicon name="database" size={16} class="text-gray-500" />Resources migrated</h2>
					<p class="mt-1 text-xs text-gray-500">Repository contents moved successfully</p>
				</div>
				<span class="text-xs text-gray-500">
					{fmtNum(stats.resources.migrationCount)} migrations with final counts
				</span>
			</div>
			<dl class="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-gray-700 bg-gray-700 sm:grid-cols-3 lg:grid-cols-6">
				{#each resourceCards as resource (resource.label)}
					<div class="bg-gray-950 px-3 py-3">
						<dt class="flex items-center gap-1.5 text-xs text-gray-500"><Octicon name={resource.icon} size={12} class="text-blue-400" />{resource.label}</dt>
						<dd class="mt-1 text-base font-semibold tabular-nums text-gray-100">{fmtNum(resource.value)}</dd>
					</div>
				{/each}
			</dl>
		</section>

		<section>
			<h2 class="mb-3 flex items-center gap-2 text-sm font-semibold text-gray-200"><Octicon name="star" size={16} class="text-gray-500" />Highlights</h2>
			<dl class="grid grid-cols-1 gap-px overflow-hidden rounded-md border border-gray-700 bg-gray-700 sm:grid-cols-2 lg:grid-cols-4">
			<div class="bg-gray-950 px-4 py-3">
				<dt class="flex items-center gap-1.5 text-xs text-gray-500"><Octicon name="zap" size={12} class="text-blue-400" />Fastest</dt>
				{#if stats.records.fastest}
					<dd class="mt-1 text-lg font-semibold text-gray-100">{formatElapsed(stats.records.fastest.seconds)}</dd>
					<p class="mt-0.5 truncate text-xs text-gray-500" title={stats.records.fastest.repo}>{stats.records.fastest.repo}</p>
				{:else}
					<dd class="mt-1 text-lg font-semibold text-gray-500">—</dd>
				{/if}
			</div>
			<div class="bg-gray-950 px-4 py-3">
				<dt class="flex items-center gap-1.5 text-xs text-gray-500"><Octicon name="hourglass" size={12} class="text-blue-400" />Slowest</dt>
				{#if stats.records.slowest}
					<dd class="mt-1 text-lg font-semibold text-gray-100">{formatElapsed(stats.records.slowest.seconds)}</dd>
					<p class="mt-0.5 truncate text-xs text-gray-500" title={stats.records.slowest.repo}>{stats.records.slowest.repo}</p>
				{:else}
					<dd class="mt-1 text-lg font-semibold text-gray-500">—</dd>
				{/if}
			</div>
			<div class="bg-gray-950 px-4 py-3">
				<dt class="flex items-center gap-1.5 text-xs text-gray-500"><Octicon name="database" size={12} class="text-blue-400" />Largest repository</dt>
				{#if stats.data.largestRepo}
					<dd class="mt-1 text-lg font-semibold text-gray-100">{formatRepoSize(stats.data.largestKb)}</dd>
					<p class="mt-0.5 truncate text-xs text-gray-500" title={stats.data.largestRepo}>{stats.data.largestRepo}</p>
				{:else}
					<dd class="mt-1 text-lg font-semibold text-gray-500">—</dd>
				{/if}
			</div>
			<div class="bg-gray-950 px-4 py-3">
				<dt class="flex items-center gap-1.5 text-xs text-gray-500"><Octicon name="alert" size={12} class="text-blue-400" />Warnings</dt>
				<dd class="mt-1 text-lg font-semibold text-gray-100">{fmtNum(stats.warnings.total)}</dd>
				<p class="mt-0.5 text-xs text-gray-500">across {fmtNum(stats.warnings.withWarnings)} migrations</p>
			</div>
			</dl>
		</section>

		<div class="grid gap-6 lg:grid-cols-2">
			<section>
				<h2 class="mb-3 flex items-center gap-2 text-sm font-semibold text-gray-200">
					<Octicon name="arrow-switch" size={16} class="text-gray-500" />Migration direction
				</h2>
				{#if directionTotal > 0}
					<ul class="divide-y divide-gray-700 border-y border-gray-700">
						{#each directions as direction (direction.key)}
							<li class="flex items-center justify-between gap-4 py-3">
								<div class="min-w-0">
									<div class="inline-flex min-w-0 items-center gap-1 text-sm font-medium text-gray-200" title={direction.label}>
										<Octicon name={direction.sourceIcon} size={16} class="shrink-0 text-gray-500" />
										<span class="truncate">{direction.sourceLabel}</span>
										<Octicon name="arrow-right" size={12} class="shrink-0 text-gray-600" />
										<Octicon name={direction.targetIcon} size={16} class="shrink-0 text-gray-500" />
										<span class="shrink-0">{direction.targetLabel}</span>
									</div>
									<p class="mt-1 text-xs text-gray-500">{fmtNum(direction.success.succeeded)} succeeded of {fmtNum(direction.total)} total</p>
								</div>
								<div class="shrink-0 text-right tabular-nums">
									<div class="text-sm font-semibold text-gray-100">{direction.success.rate}%</div>
									<div class="mt-1 text-xs text-gray-500">{Math.round((direction.total / directionTotal) * 100)}% of volume</div>
								</div>
							</li>
						{/each}
					</ul>
				{:else}
					<p class="text-sm text-gray-500">No data.</p>
				{/if}
			</section>

			<section class="flex min-h-0 flex-col">
				<div class="mb-3 flex items-start justify-between gap-3">
					<div>
						<h2 class="flex items-center gap-2 text-sm font-semibold text-gray-200">
							<Octicon name="organization" size={16} class="text-gray-500" />Top source organizations
						</h2>
						<p class="mt-1 text-xs text-gray-500">Repository volume by source owner</p>
					</div>
					<span class="shrink-0 text-xs text-gray-500">Top {visibleTopOrgs.length}</span>
				</div>
				{#if stats.topOrgs.length > 0}
					<ul class="flex flex-1 flex-col border-y border-gray-700">
						{#each visibleTopOrgs as org, index (org.org)}
							<li class="flex min-h-14 flex-1 items-center gap-3 border-b border-gray-700/70 py-3 last:border-b-0">
								<span class="w-5 shrink-0 text-xs font-semibold tabular-nums text-gray-600">{String(index + 1).padStart(2, '0')}</span>
								<span class="flex size-8 shrink-0 items-center justify-center text-gray-500">
									<Octicon name="organization" size={16} />
								</span>
								<div class="min-w-0 flex-1">
									<div class="truncate text-sm font-medium text-gray-200" title={org.org}>{org.org}</div>
									<div class="mt-0.5 text-xs text-gray-500">Source owner</div>
								</div>
								<div class="shrink-0 text-right">
									<div class="text-base font-semibold tabular-nums text-gray-50">{fmtNum(org.count)}</div>
									<div class="text-xs text-gray-500">{stats.total > 0 ? ((org.count / stats.total) * 100).toFixed(1) : '0.0'}% of total</div>
								</div>
							</li>
						{/each}
					</ul>
				{:else}
					<p class="text-sm text-gray-500">No data.</p>
				{/if}
			</section>
		</div>

		<section>
			<div class="mb-3 flex flex-wrap items-start justify-between gap-2">
				<div>
					<h2 class="flex items-center gap-2 text-sm font-semibold text-gray-200">
						<Octicon name="arrow-switch" size={16} class="text-gray-500" />Migration paths
					</h2>
					<p class="mt-1 text-xs text-gray-500">Success and duration by migration path</p>
				</div>
			</div>
			<div class="hidden overflow-x-auto border-y border-gray-700 md:block">
				<table class="w-full border-collapse text-xs tabular-nums">
					<thead class="bg-gray-950/40 text-xs uppercase text-gray-500">
						<tr>
							<th class="px-5 py-2 text-left font-medium">Path</th>
							<th class="px-3 py-2 text-right font-medium">Total</th>
							<th class="px-3 py-2 text-right font-medium">Succeeded</th>
							<th class="px-3 py-2 text-right font-medium">Failed</th>
							<th class="px-3 py-2 text-right font-medium">Cancelled</th>
							<th class="px-3 py-2 text-right font-medium">Success</th>
							<th class="px-3 py-2 text-right font-medium">Median</th>
							<th class="px-3 py-2 text-right font-medium">P95</th>
							<th class="px-5 py-2 text-right font-medium">Duration data</th>
						</tr>
					</thead>
					<tbody class="divide-y divide-gray-700/70">
						{#each directions as direction (direction.key)}
							<tr class="hover:bg-gray-800/30">
								<td class="whitespace-nowrap px-5 py-3 text-left font-medium text-gray-200">{direction.label}</td>
								<td class="px-3 py-3 text-right text-gray-300">{fmtNum(direction.total)}</td>
								<td class="px-3 py-3 text-right text-green-400">{fmtNum(direction.success.succeeded)}</td>
								<td class="px-3 py-3 text-right {direction.success.failed > 0 ? 'text-red-400' : 'text-gray-500'}">{fmtNum(direction.success.failed)}</td>
								<td class="px-3 py-3 text-right text-gray-400">{fmtNum(direction.success.cancelled)}</td>
								<td class="px-3 py-3 text-right font-medium text-gray-200">{direction.success.outcomes > 0 ? `${direction.success.rate}%` : '—'}</td>
								<td class="px-3 py-3 text-right text-gray-300">{formatElapsed(direction.success.duration.medianSeconds)}</td>
								<td class="px-3 py-3 text-right text-gray-300">{formatElapsed(direction.success.duration.p95Seconds)}</td>
								<td class="whitespace-nowrap px-5 py-3 text-right text-gray-400">
									{#if direction.success.duration.eligibleCount > 0}
										{fmtNum(direction.success.duration.timedCount)} of {fmtNum(direction.success.duration.eligibleCount)}
									{:else}
										Not available
									{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
			<div class="divide-y divide-gray-700 border-y border-gray-700 md:hidden">
				{#each directions as direction (direction.key)}
					<div class="space-y-3 p-4 text-xs tabular-nums">
						<div class="font-medium text-gray-200">{direction.label}</div>
						<dl class="grid grid-cols-2 gap-x-5 gap-y-2">
							<div class="flex justify-between gap-2"><dt class="text-gray-500">Total</dt><dd class="text-gray-200">{fmtNum(direction.total)}</dd></div>
							<div class="flex justify-between gap-2"><dt class="text-gray-500">Success</dt><dd class="text-gray-200">{direction.success.outcomes > 0 ? `${direction.success.rate}%` : '—'}</dd></div>
							<div class="flex justify-between gap-2"><dt class="text-gray-500">Succeeded</dt><dd class="text-green-400">{fmtNum(direction.success.succeeded)}</dd></div>
							<div class="flex justify-between gap-2"><dt class="text-gray-500">Failed</dt><dd class="text-red-400">{fmtNum(direction.success.failed)}</dd></div>
							<div class="flex justify-between gap-2"><dt class="text-gray-500">Cancelled</dt><dd class="text-gray-300">{fmtNum(direction.success.cancelled)}</dd></div>
							<div class="flex justify-between gap-2"><dt class="text-gray-500">Median</dt><dd class="text-gray-300">{formatElapsed(direction.success.duration.medianSeconds)}</dd></div>
							<div class="flex justify-between gap-2"><dt class="text-gray-500">P95</dt><dd class="text-gray-300">{formatElapsed(direction.success.duration.p95Seconds)}</dd></div>
							<div class="flex justify-between gap-2"><dt class="text-gray-500">Duration data</dt><dd class="text-gray-300">{fmtNum(direction.success.duration.timedCount)} of {fmtNum(direction.success.duration.eligibleCount)}</dd></div>
						</dl>
					</div>
				{/each}
			</div>
		</section>

		<div class="space-y-6">
			<section>
				<h2 class="mb-3 flex items-center gap-2 text-sm font-semibold text-gray-200">
					<Octicon name="alert" size={16} class="text-red-400" />Top failure reasons
				</h2>
				{#if stats.failuresByReason.length > 0}
					<div class="hidden overflow-x-auto border-y border-gray-700 md:block">
						<table class="w-full border-collapse text-xs tabular-nums">
							<thead class="bg-gray-950/40 text-xs uppercase text-gray-500">
								<tr>
									<th class="px-5 py-2 text-left font-medium">Reason</th>
									<th class="px-3 py-2 text-right font-medium">Count</th>
									<th class="px-3 py-2 text-right font-medium">Share</th>
									<th class="px-3 py-2 text-right font-medium">Avg duration</th>
									<th class="px-3 py-2 text-right font-medium">Total duration</th>
									<th class="px-5 py-2 text-right font-medium">Duration data</th>
								</tr>
							</thead>
							<tbody class="divide-y divide-gray-700/70">
								{#each stats.failuresByReason.slice(0, 5) as failure (failure.reason)}
									<tr class="hover:bg-gray-800/30">
										<td class="text-machine max-w-md truncate px-5 py-3 text-red-300" title={failure.reason}>{failure.reason}</td>
										<td class="px-3 py-3 text-right font-medium text-red-400">{fmtNum(failure.count)}</td>
										<td class="px-3 py-3 text-right text-gray-300">{failure.share}%</td>
										<td class="px-3 py-3 text-right text-gray-300">{formatElapsed(failure.avgSeconds)}</td>
										<td class="px-3 py-3 text-right text-gray-300">{formatElapsed(failure.totalSeconds)}</td>
										<td class="whitespace-nowrap px-5 py-3 text-right text-gray-400">{fmtNum(failure.timedCount)} of {fmtNum(failure.count)}</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
					<ul class="divide-y divide-gray-700 border-y border-gray-700 md:hidden">
						{#each stats.failuresByReason.slice(0, 5) as failure (failure.reason)}
							<li class="space-y-3 p-4">
								<div class="text-machine truncate text-red-300" title={failure.reason}>{failure.reason}</div>
								<dl class="grid grid-cols-2 gap-x-5 gap-y-2 text-xs tabular-nums">
									<div class="flex justify-between gap-2"><dt class="text-gray-500">Count</dt><dd class="text-red-400">{fmtNum(failure.count)}</dd></div>
									<div class="flex justify-between gap-2"><dt class="text-gray-500">Share</dt><dd class="text-gray-300">{failure.share}%</dd></div>
									<div class="flex justify-between gap-2"><dt class="text-gray-500">Average</dt><dd class="text-gray-300">{formatElapsed(failure.avgSeconds)}</dd></div>
									<div class="flex justify-between gap-2"><dt class="text-gray-500">Total</dt><dd class="text-gray-300">{formatElapsed(failure.totalSeconds)}</dd></div>
								</dl>
							</li>
						{/each}
					</ul>
				{:else}
					<p class="inline-flex items-center gap-1.5 border-y border-gray-700 py-4 text-sm text-green-400"><Octicon name="check-circle" size={12} />No failures recorded.</p>
				{/if}
			</section>

			<section>
				<div class="mb-3">
					<h2 class="flex items-center gap-2 text-sm font-semibold text-gray-200"><Octicon name="stack" size={16} class="text-gray-500" />Batch details</h2>
					<p class="mt-1 text-xs text-gray-500">Batches needing attention, followed by recent completed batches</p>
				</div>
				{#if stats.batchStats.length > 0}
					<div class="hidden overflow-x-auto border-y border-gray-700 md:block">
						<table class="w-full border-collapse text-xs tabular-nums">
							<thead class="bg-gray-950/40 text-xs uppercase text-gray-500">
								<tr>
									<th class="px-5 py-2 text-left font-medium">Batch</th>
									<th class="px-3 py-2 text-right font-medium">Repositories</th>
									<th class="px-3 py-2 text-right font-medium">Complete</th>
									<th class="px-3 py-2 text-right font-medium">Succeeded</th>
									<th class="px-3 py-2 text-right font-medium">Failed</th>
									<th class="px-3 py-2 text-right font-medium">Cancelled</th>
									<th class="px-3 py-2 text-right font-medium">Needs review</th>
									<th class="px-5 py-2 text-right font-medium">Elapsed</th>
								</tr>
							</thead>
							<tbody class="divide-y divide-gray-700/70">
								{#each stats.batchStats as batch (batch.id)}
									<tr class="hover:bg-gray-800/30">
										<td class="px-5 py-3 text-left"><a class="font-medium text-blue-400 hover:text-blue-300" href="/migrate/batches/{batch.id}">{batch.id}</a>{#if batch.active}<span class="ml-2 rounded-full bg-blue-500/10 px-1.5 py-0.5 text-xs font-medium text-blue-400">Active</span>{/if}</td>
										<td class="px-3 py-3 text-right text-gray-300">{fmtNum(batch.total)}</td>
										<td class="px-3 py-3 text-right text-gray-300">{batch.completionRate}%</td>
										<td class="px-3 py-3 text-right text-green-400">{fmtNum(batch.succeeded)}</td>
										<td class="px-3 py-3 text-right {batch.failed > 0 ? 'text-red-400' : 'text-gray-500'}">{fmtNum(batch.failed)}</td>
										<td class="px-3 py-3 text-right text-gray-400">{fmtNum(batch.cancelled)}</td>
										<td class="px-3 py-3 text-right {batch.needsReview > 0 ? 'text-orange-300' : 'text-gray-500'}">{fmtNum(batch.needsReview)}</td>
										<td class="whitespace-nowrap px-5 py-3 text-right text-gray-300">{formatElapsed(batch.elapsedSeconds)}</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
					<div class="divide-y divide-gray-700 border-y border-gray-700 md:hidden">
						{#each stats.batchStats as batch (batch.id)}
							<a href="/migrate/batches/{batch.id}" class="block space-y-3 p-4 hover:bg-gray-800/30">
								<div class="flex items-center justify-between gap-3"><span class="truncate font-medium text-blue-400">{batch.id}</span>{#if batch.active}<span class="shrink-0 rounded-full bg-blue-500/10 px-1.5 py-0.5 text-xs text-blue-400">Active</span>{/if}</div>
								<dl class="grid grid-cols-2 gap-x-5 gap-y-2 text-xs tabular-nums">
									<div class="flex justify-between gap-2"><dt class="text-gray-500">Repositories</dt><dd class="text-gray-300">{fmtNum(batch.total)}</dd></div>
									<div class="flex justify-between gap-2"><dt class="text-gray-500">Complete</dt><dd class="text-gray-300">{batch.completionRate}%</dd></div>
									<div class="flex justify-between gap-2"><dt class="text-gray-500">Succeeded</dt><dd class="text-green-400">{fmtNum(batch.succeeded)}</dd></div>
									<div class="flex justify-between gap-2"><dt class="text-gray-500">Failed</dt><dd class="text-red-400">{fmtNum(batch.failed)}</dd></div>
									<div class="flex justify-between gap-2"><dt class="text-gray-500">Cancelled</dt><dd class="text-gray-300">{fmtNum(batch.cancelled)}</dd></div>
									<div class="flex justify-between gap-2"><dt class="text-gray-500">Elapsed</dt><dd class="text-gray-300">{formatElapsed(batch.elapsedSeconds)}</dd></div>
								</dl>
							</a>
						{/each}
					</div>
				{:else}
					<p class="border-y border-gray-700 py-4 text-sm text-gray-500">No batches match these filters.</p>
				{/if}
			</section>

			<section>
				<div class="mb-3 flex flex-wrap items-start justify-between gap-2">
					<div>
						<h2 class="flex items-center gap-2 text-sm font-semibold text-gray-200"><Octicon name="database" size={16} class="text-gray-500" />Performance by repository size</h2>
						<p class="mt-1 text-xs text-gray-500">Historical completion times, not an estimate</p>
					</div>
					{#if stats.sizeUnavailableCount > 0}<span class="text-xs text-gray-500">{fmtNum(stats.sizeUnavailableCount)} without size data</span>{/if}
				</div>
				<div class="overflow-x-auto border-y border-gray-700">
					<table class="w-full min-w-160 border-collapse text-xs tabular-nums">
						<thead class="bg-gray-950/40 text-xs uppercase text-gray-500"><tr><th class="px-5 py-2 text-left font-medium">Size</th><th class="px-3 py-2 text-right font-medium">Succeeded</th><th class="px-3 py-2 text-right font-medium">Failed</th><th class="px-3 py-2 text-right font-medium">Success</th><th class="px-3 py-2 text-right font-medium">Median</th><th class="px-3 py-2 text-right font-medium">P95</th><th class="px-5 py-2 text-right font-medium">Duration data</th></tr></thead>
						<tbody class="divide-y divide-gray-700/70">
							{#each stats.sizeStats as row (row.band)}
								<tr class="hover:bg-gray-800/30"><td class="px-5 py-3 text-left"><span class="font-semibold text-gray-200">{row.band}</span><span class="ml-2 text-gray-500">{sizeBandLabel(row.band)}</span></td><td class="px-3 py-3 text-right text-green-400">{fmtNum(row.succeeded)}</td><td class="px-3 py-3 text-right {row.failed > 0 ? 'text-red-400' : 'text-gray-500'}">{fmtNum(row.failed)}</td><td class="px-3 py-3 text-right text-gray-200">{row.outcomes > 0 ? `${row.rate}%` : '—'}</td><td class="px-3 py-3 text-right text-gray-300">{formatElapsed(row.duration.medianSeconds)}</td><td class="px-3 py-3 text-right text-gray-300">{formatElapsed(row.duration.p95Seconds)}</td><td class="whitespace-nowrap px-5 py-3 text-right text-gray-400">{fmtNum(row.duration.timedCount)} of {fmtNum(row.duration.eligibleCount)}</td></tr>
							{/each}
						</tbody>
					</table>
				</div>
			</section>

			<section>
				<div class="mb-3">
					<h2 class="flex items-center gap-2 text-sm font-semibold text-gray-200">
						<Octicon name="pulse" size={16} class="text-gray-500" />Per-migration averages
					</h2>
					<p class="mt-1 text-xs text-gray-500">Typical timing and repository contents for these results</p>
				</div>

				<section class="border-y border-gray-700" aria-labelledby="timing-heading">
					<div class="flex items-center justify-between bg-gray-950/30 px-5 py-2">
						<h3 id="timing-heading" class="text-xs font-semibold uppercase text-gray-500">Timing</h3>
						<span class="text-xs text-gray-500">{fmtNum(stats.duration.timedCount)} migrations</span>
					</div>
					<dl class="grid grid-cols-1 divide-y divide-gray-700 sm:grid-cols-3 sm:divide-x sm:divide-y-0">
						<div class="px-5 py-4">
							<dt class="flex items-center gap-1.5 text-xs text-gray-500"><Octicon name="stopwatch" size={12} />Average</dt>
							<dd class="mt-1 text-xl font-semibold tabular-nums text-gray-50">{formatElapsed(stats.duration.avgSeconds)}</dd>
						</div>
						<div class="px-5 py-4">
							<dt class="text-xs text-gray-500">Median</dt>
							<dd class="mt-1 text-xl font-semibold tabular-nums text-gray-50">{formatElapsed(stats.duration.medianSeconds)}</dd>
						</div>
						<div class="px-5 py-4">
							<dt class="text-xs text-gray-500">95th percentile</dt>
							<dd class="mt-1 text-xl font-semibold tabular-nums text-yellow-300">{formatElapsed(stats.duration.p95Seconds)}</dd>
						</div>
					</dl>
				</section>

				<section class="border-b border-gray-700" aria-labelledby="contents-heading">
					<h3 id="contents-heading" class="bg-gray-950/30 px-5 py-2 text-xs font-semibold uppercase text-gray-500">Repository contents</h3>
					<dl class="grid grid-cols-2 divide-x divide-y divide-gray-700 sm:grid-cols-4 sm:divide-y-0">
						<div class="px-5 py-4">
							<dt class="flex items-center gap-1.5 text-xs text-gray-500"><Octicon name="database" size={12} />Repo size</dt>
							<dd class="mt-1 text-lg font-semibold tabular-nums text-gray-50">{formatRepoSize(stats.data.avgKb)}</dd>
							<p class="mt-0.5 text-xs text-gray-500">{fmtNum(stats.data.sizedCount)} migrations</p>
						</div>
						<div class="px-5 py-4">
							<dt class="flex items-center gap-1.5 text-xs text-gray-500"><Octicon name="git-commit" size={12} />Commits</dt>
							<dd class="mt-1 text-lg font-semibold tabular-nums text-gray-50">{fmtNum(avgPerCountedMigration(stats.resources.commits))}</dd>
							<p class="mt-0.5 text-xs text-gray-500">per migration</p>
						</div>
						<div class="px-5 py-4">
							<dt class="flex items-center gap-1.5 text-xs text-gray-500"><Octicon name="issue-opened" size={12} />Issues</dt>
							<dd class="mt-1 text-lg font-semibold tabular-nums text-gray-50">{fmtNum(avgPerCountedMigration(stats.resources.issues))}</dd>
							<p class="mt-0.5 text-xs text-gray-500">per migration</p>
						</div>
						<div class="px-5 py-4">
							<dt class="flex items-center gap-1.5 text-xs text-gray-500"><Octicon name="git-pull-request" size={12} />Pull requests</dt>
							<dd class="mt-1 text-lg font-semibold tabular-nums text-gray-50">{fmtNum(avgPerCountedMigration(stats.resources.pullRequests))}</dd>
							<p class="mt-0.5 text-xs text-gray-500">per migration</p>
						</div>
					</dl>
				</section>
			</section>
		</div>

		<div>
			<a href="/migrate" class="inline-flex items-center gap-1 text-sm font-medium text-blue-400 hover:text-blue-300 hover:underline focus-visible:outline-2 focus-visible:outline-blue-500">
				<Octicon name="chevron-left" size={16} />
				Back to migrations
			</a>
		</div>
	{/if}
</div>

<style>
	.stats-filters {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		align-items: end;
		gap: 0.75rem;
	}

	.stats-segmented {
		display: flex;
		height: 2rem;
		gap: 0.125rem;
		padding: 0.125rem;
		border: 1px solid var(--controlTrack-borderColor-rest);
		border-radius: 0.375rem;
		background: var(--controlTrack-bgColor-rest);
	}

	.stats-segment {
		position: relative;
		display: flex;
		min-width: 0;
		flex: 1;
		align-items: center;
		justify-content: center;
		gap: 0.375rem;
		padding-inline: 0.5rem;
		border: 1px solid transparent;
		border-radius: 0.25rem;
		color: var(--controlTrack-fgColor-rest);
		font-size: 0.75rem;
		font-weight: 500;
		white-space: nowrap;
		cursor: pointer;
		transition: background-color 120ms, border-color 120ms, color 120ms;
	}

	.stats-segment:not(:has(input:checked)):hover {
		background: var(--controlTrack-bgColor-hover);
		color: var(--fgColor-default);
	}

	.stats-segment:not(:has(input:checked)):active {
		background: var(--controlTrack-bgColor-active);
	}

	.stats-segment:has(input:checked) {
		border-color: color-mix(in srgb, var(--fgColor-accent) 35%, transparent);
		background: var(--bgColor-accent-muted);
		color: var(--fgColor-accent);
		font-weight: 600;
	}

	.stats-segment:has(input:focus-visible) {
		z-index: 2;
		outline: 2px solid var(--fgColor-accent);
		outline-offset: -2px;
	}

	@media (min-width: 40rem) {
		.stats-filters {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}

	@media (min-width: 62rem) {
		.stats-filters {
			width: fit-content;
			max-width: 100%;
			grid-template-columns: 12rem 13.5rem 14.5rem 15.5rem;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.stats-segment {
			transition: none;
		}
	}

	@media (min-width: 64rem) {
		.status-grid {
			grid-template-columns: repeat(var(--status-columns), minmax(0, 1fr));
		}
	}
</style>