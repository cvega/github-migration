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
				total: direction.total,
				success: direction,
			};
		}),
	);
	const visibleTopOrgs = $derived(
		stats.topOrgs.slice(0, Math.min(stats.topOrgs.length, Math.max(3, directions.length))),
	);

	const chartDays = $derived(stats.throughput);
	const maxChartDay = $derived(Math.max(1, ...chartDays.map((day) => day.succeeded + day.failed)));
	const middleChartValue = $derived(Math.ceil(maxChartDay / 2));
	const chartIncludesYear = $derived(
		chartDays.at(0)?.date.slice(0, 4) !== chartDays.at(-1)?.endDate.slice(0, 4),
	);
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
	function avgPerCountedMigration(total: number): string {
		return stats.resources.migrationCount > 0
			? fmtNum(Math.round(total / stats.resources.migrationCount))
			: '—';
	}
	function shortDate(iso: string, includeYear = false): string {
		const date = new Date(`${iso}T00:00:00Z`);
		return Number.isNaN(date.getTime())
			? iso
			: date.toLocaleDateString(undefined, {
					month: 'short',
					day: 'numeric',
					year: includeYear ? 'numeric' : undefined,
					timeZone: 'UTC',
				});
	}
	function chartDateRange(day: { date: string; endDate: string }): string {
		const start = shortDate(day.date, chartIncludesYear);
		return day.date === day.endDate ? start : `${start}–${shortDate(day.endDate, chartIncludesYear)}`;
	}
	function daySuccessRate(succeeded: number, failed: number): string {
		const total = succeeded + failed;
		return total > 0 ? `${Math.round((succeeded / total) * 1000) / 10}%` : 'No completions';
	}
	function sizeBandLabel(band: RepositorySizeBand): string {
		return REPOSITORY_SIZE_BANDS.find((definition) => definition.band === band)?.label ?? band;
	}
</script>

<svelte:head><title>Migration statistics - GitHub Migration Toolkit</title></svelte:head>

<div class="stats-page space-y-7">
	<section class="stats-cover" aria-label="Report cover">
		<div class="stats-cover-brand">
			<Octicon name="mark-github" size={24} />
			<span>GitHub<br /><strong>Migration Toolkit</strong></span>
		</div>
		<div class="stats-cover-title">
			<p>Migration report</p>
			<h2>Migration statistics</h2>
			<p>Outcomes, throughput, and performance across migration history</p>
		</div>
		<div class="stats-cover-details">
			<div class="stats-cover-route">
				<div><span>Source</span><strong>{sourceFilterOptions.find((option) => option.value === filters.sourceProvider)?.label}</strong></div>
				<span class="stats-cover-arrow" aria-hidden="true">→</span>
				<div><span>Target</span><strong>{targetFilterOptions.find((option) => option.value === filters.targetPlatform)?.label}</strong></div>
			</div>
			<dl>
				<div><dt>Started</dt><dd>{periodOptions.find((option) => option.value === filters.period)?.label}</dd></div>
				<div><dt>Mode</dt><dd>{modeOptions.find((option) => option.value === filters.mode)?.label}</dd></div>
				<div><dt>{hasActiveFilters ? 'Matching migrations' : 'Total migrations'}</dt><dd>{fmtNum(stats.total)}</dd></div>
			</dl>
		</div>
	</section>

	<div class="flex flex-wrap items-end justify-between gap-3">
		<div>
			<h1 class="flex items-center gap-2 text-xl font-semibold text-gray-50"><Octicon name="graph" size={24} class="text-gray-500" />Migration statistics</h1>
			<p class="mt-1 text-sm text-gray-500">Outcomes, throughput, and performance across migration history</p>
		</div>
		<div class="flex flex-wrap items-center gap-4">
			<div class="flex items-baseline gap-2 tabular-nums">
				<span class="text-2xl font-semibold text-gray-100">{fmtNum(stats.total)}</span>
				<span class="text-sm text-gray-500">{hasActiveFilters ? 'matching migrations' : 'total migrations'}</span>
			</div>
			<button type="button" class="stats-export" aria-label="Print or save PDF" title="Print or save PDF" onclick={() => window.print()}>
				<svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
					<path d="M4.5 5V2.5h7V5M4.5 11h-1a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1h-1" />
					<rect x="4.5" y="9" width="7" height="4.5" rx=".5" />
					<circle cx="11.5" cy="7" r=".5" fill="currentColor" stroke="none" />
				</svg>
			</button>
		</div>
	</div>

	<p class="stats-print-context">
		Source: {sourceFilterOptions.find((option) => option.value === filters.sourceProvider)?.label} ·
		Target: {targetFilterOptions.find((option) => option.value === filters.targetPlatform)?.label} ·
		Started: {periodOptions.find((option) => option.value === filters.period)?.label} ·
		Mode: {modeOptions.find((option) => option.value === filters.mode)?.label}
	</p>

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
		<div class="stats-empty rounded-md border border-gray-700 bg-gray-900 p-10 text-center text-gray-400">
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
		<nav aria-label="Statistics sections" class="stats-nav flex gap-6 overflow-x-auto border-b border-gray-700 text-sm">
			<a href="#overview" class="whitespace-nowrap pb-3 text-gray-300 hover:text-gray-100 focus-visible:outline-2 focus-visible:outline-blue-400">Overview</a>
			<a href="#attention" class="whitespace-nowrap pb-3 text-gray-300 hover:text-gray-100 focus-visible:outline-2 focus-visible:outline-blue-400">Needs attention</a>
			<a href="#performance" class="whitespace-nowrap pb-3 text-gray-300 hover:text-gray-100 focus-visible:outline-2 focus-visible:outline-blue-400">Performance &amp; volume</a>
		</nav>
		<section id="overview" aria-labelledby="overview-heading" class="space-y-4 scroll-mt-4">
			<div class="flex flex-wrap items-end justify-between gap-2"><div><h2 id="overview-heading" class="flex items-center gap-2 text-base font-semibold text-gray-100"><Octicon name="graph" size={16} class="text-gray-500" />Overview</h2><p class="mt-1 text-xs text-gray-500">How the selected migrations are progressing</p></div><p class="stats-overview-context text-xs text-gray-500">{sourceFilterOptions.find((option) => option.value === filters.sourceProvider)?.label} → {targetFilterOptions.find((option) => option.value === filters.targetPlatform)?.label} · {periodOptions.find((option) => option.value === filters.period)?.label}{filters.mode !== 'all' ? ` · ${modeOptions.find((option) => option.value === filters.mode)?.label}` : ''}</p></div>
			<dl class="stats-overview-metrics grid grid-cols-2 gap-px overflow-hidden rounded-md border border-gray-700 bg-gray-700 sm:grid-cols-3 lg:grid-cols-5">
				<div class="bg-gray-950 px-4 py-4">
					<dt class="flex items-center gap-1.5 text-xs text-gray-500"><Octicon name="check-circle" size={12} class="text-green-400" />Success rate</dt>
					<dd class="mt-1 text-2xl font-semibold tabular-nums text-green-400">{stats.successRate === null ? '—' : `${stats.successRate}%`}</dd>
					<p class="mt-0.5 text-xs text-gray-500">{fmtNum(stats.byState.succeeded)} succeeded · {fmtNum(stats.byState.failed)} failed</p>
				</div>
				<div class="bg-gray-950 px-4 py-4">
					<dt class="flex items-center gap-1.5 text-xs text-gray-500"><Octicon name="sync" size={12} class="text-blue-400" />In progress</dt>
					<dd class="mt-1 text-2xl font-semibold tabular-nums text-gray-50">{fmtNum(stats.active)}</dd>
					<p class="mt-0.5 text-xs text-gray-500">{fmtNum(stats.byState.running)} currently running</p>
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
					<dt class="flex items-center gap-1.5 text-xs text-gray-500"><Octicon name="database" size={12} class="text-blue-400" />Source repository size</dt>
					<dd class="mt-1 text-2xl font-semibold tabular-nums text-gray-50">{formatRepoSize(stats.data.sizedCount > 0 ? stats.data.totalKb : null)}</dd>
					<p class="mt-0.5 text-xs text-gray-500">{fmtNum(stats.data.sizedCount)} of {fmtNum(stats.data.eligibleCount)} succeeded with size data</p>
				</div>
				<div class="col-span-2 bg-gray-950 px-4 py-4 sm:col-span-1">
					<dt class="flex items-center gap-1.5 text-xs text-gray-500"><Octicon name="stack" size={12} class="text-blue-400" />Batches</dt>
					<dd class="mt-1 text-2xl font-semibold tabular-nums text-gray-50">{fmtNum(stats.batches)}</dd>
					<p class="mt-0.5 text-xs text-gray-500">{fmtNum(stats.batchFailures)} failed in batches</p>
				</div>
			</dl>
			<div class="stats-overview-grid grid gap-4 {stats.throughput.length > 0 ? 'lg:grid-cols-[minmax(0,1.7fr)_minmax(250px,1fr)]' : ''}">
				{#if stats.throughput.length > 0}
					{@const firstDay = chartDays[0]}
					{@const middleDay = chartDays[Math.floor((chartDays.length - 1) / 2)]}
					{@const lastDay = chartDays[chartDays.length - 1]}
					<section class="min-w-0 rounded-md border border-gray-700 bg-gray-950/30 p-4">
						<div class="flex flex-wrap items-start justify-between gap-3">
							<div>
								<h3 class="flex items-center gap-2 text-sm font-semibold text-gray-200"><Octicon name="graph" size={16} class="text-gray-500" />Completions over time</h3>
								<p class="mt-1 text-xs text-gray-500">{firstDay ? shortDate(firstDay.date, chartIncludesYear) : ''}–{lastDay ? shortDate(lastDay.endDate, chartIncludesYear) : ''} · {stats.throughputIntervalDays === 1 ? 'daily' : `${stats.throughputIntervalDays}-day`} outcomes for the selected started cohort · UTC</p>
							</div>
							<div class="inline-flex items-center gap-3 text-xs text-gray-500">
									<span class="inline-flex items-center gap-1"><span class="inline-block h-2 w-2 rounded-sm bg-green-500"></span>Succeeded</span>
									<span class="inline-flex items-center gap-1"><span class="inline-block h-2 w-2 rounded-sm bg-red-500"></span>Failed</span>
							</div>
						</div>
						<div class="mt-5 grid grid-cols-[2.25rem_minmax(0,1fr)] gap-2">
							<div class="flex h-[135px] flex-col justify-between pb-px text-right text-xs tabular-nums text-gray-600" aria-hidden="true">
								<span>{fmtNum(maxChartDay)}</span>
								<span>{fmtNum(middleChartValue)}</span>
								<span>0</span>
							</div>
							<div class="relative h-[135px] min-w-0">
								<div class="pointer-events-none absolute inset-0 flex flex-col justify-between" aria-hidden="true">
									<span class="border-t border-gray-700/70"></span>
									<span class="border-t border-dashed border-gray-700/70"></span>
									<span class="border-t border-gray-700"></span>
								</div>
								<div class="stats-chart-bars absolute inset-0 flex items-end gap-px overflow-x-auto">
							{#each chartDays as day, index (day.date)}
								<button type="button" class="group relative flex h-full min-w-px flex-1 flex-col justify-end outline-none focus-visible:ring-2 focus-visible:ring-blue-400" aria-label="{chartDateRange(day)}: {fmtNum(day.succeeded)} succeeded, {fmtNum(day.failed)} failed, {daySuccessRate(day.succeeded, day.failed)} success rate">
									<span class="pointer-events-none absolute top-1 z-10 hidden w-max max-w-48 rounded-md border border-gray-600 bg-gray-800 px-2.5 py-2 text-left text-xs text-gray-300 shadow-lg group-hover:block group-focus:block {index < chartDays.length / 2 ? 'left-0' : 'right-0'}">
										<strong class="block font-medium text-gray-100">{chartDateRange(day)}</strong>
										<span class="mt-1 block font-medium text-gray-200">{fmtNum(day.succeeded + day.failed)} completed · {daySuccessRate(day.succeeded, day.failed)}</span>
										<span class="block">{fmtNum(day.succeeded)} succeeded</span>
										<span class="block">{fmtNum(day.failed)} failed</span>
									</span>
									<div class="flex h-full w-full flex-col-reverse justify-start pt-2">
										{#if day.succeeded > 0}
											<div style:height={`${(day.succeeded / maxChartDay) * 100}%`} class="min-h-px bg-green-500"></div>
										{/if}
										{#if day.failed > 0}
											<div style:height={`${(day.failed / maxChartDay) * 100}%`} class="min-h-px bg-red-500"></div>
										{/if}
									</div>
								</button>
							{/each}
								</div>
							</div>
						</div>
						<div class="mt-2 ml-13 grid grid-cols-3 text-xs text-gray-500">
							<span>{firstDay ? shortDate(firstDay.date, chartIncludesYear) : ''}</span>
							<span class="text-center">{middleDay ? shortDate(middleDay.date, chartIncludesYear) : ''}</span>
							<span class="text-right">{lastDay ? shortDate(lastDay.endDate, chartIncludesYear) : ''}</span>
						</div>
						<dl class="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-xs sm:grid-cols-4">
							<div><dt class="text-gray-500">Last 7 days</dt><dd class="mt-0.5 font-semibold tabular-nums text-gray-200">{fmtNum(stats.recentWindow.completed)} completed</dd></div>
							<div><dt class="text-gray-500">Previous 7 days</dt><dd class="mt-0.5 font-semibold tabular-nums text-gray-200">{fmtNum(stats.recentWindow.previousCompleted)} completed</dd></div>
							<div><dt class="text-gray-500">Success rate</dt><dd class="mt-0.5 font-semibold tabular-nums text-green-400">{stats.recentWindow.successRate === null ? '—' : `${stats.recentWindow.successRate}%`} <span class="font-normal text-gray-500">· {fmtNum(stats.recentWindow.failed)} failed</span></dd></div>
							<div><dt class="text-gray-500">Daily average</dt><dd class="mt-0.5 font-semibold tabular-nums text-gray-200">{fmtNum(recentDailyAverage)} completed</dd></div>
						</dl>
					</section>
				{/if}
				<section class="min-w-0 rounded-md border border-gray-700 bg-gray-950/30 p-4">
					<div>
						<h3 class="flex items-center gap-2 text-sm font-semibold text-gray-200"><Octicon name="check-circle" size={16} class="text-gray-500" />Migration outcomes</h3>
						<p class="mt-1 text-xs text-gray-500">Current state across {fmtNum(stats.total)} migrations</p>
					</div>
					<div class="mt-4">
						{#each stateSegments as seg (seg.state)}
							<div class="flex items-center justify-between gap-3 border-t border-gray-700/70 py-2">
								<div class="flex items-center gap-1.5 text-xs font-medium text-gray-300">
									{#if seg.live}
										<span class="relative flex h-2 w-2" aria-hidden="true">
											<span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-40 motion-reduce:animate-none"></span>
											<span class="relative inline-flex h-2 w-2 rounded-full bg-green-400"></span>
										</span>
									{:else}
										<Octicon name={seg.icon} size={12} class={seg.text} />
									{/if}
									{seg.label}
								</div>
								<div class="flex items-baseline gap-2">
									<span class="text-sm font-semibold tabular-nums text-gray-50">{fmtNum(seg.count)}</span>
									<span class="text-xs tabular-nums text-gray-500">{seg.pct < 0.1 ? '<0.1' : seg.pct.toFixed(1)}%</span>
								</div>
							</div>
						{/each}
					</div>
					<p class="mt-3 text-xs text-gray-500">Success rate compares succeeded and failed migrations; outcomes include all states.</p>
				</section>
			</div>
		</section>
		<section id="attention" aria-labelledby="attention-heading" class="space-y-6 scroll-mt-4">
			<section>
				<h2 id="attention-heading" class="sr-only">Needs attention</h2>
				<div class="mb-3"><h3 class="flex items-center gap-2 text-sm font-semibold text-gray-200"><Octicon name="alert" size={16} class="text-gray-500" />Top failure reasons</h3><p class="mt-1 text-xs text-gray-500">Most frequent reasons, with the full message visible</p></div>
				{#if stats.failuresByReason.length > 0}
					<div class="stats-print-table hidden overflow-x-auto border-y border-gray-700 md:block">
						<table class="stats-table w-full border-collapse tabular-nums">
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
							<tbody>
								{#each stats.failuresByReason.slice(0, 5) as failure (failure.reason)}
									<tr class="hover:bg-gray-800/30">
										<td class="max-w-md break-words text-gray-100">{failure.reason}</td>
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
					<ul class="stats-compact-list divide-y divide-gray-700 border-y border-gray-700 md:hidden">
						{#each stats.failuresByReason.slice(0, 5) as failure (failure.reason)}
							<li class="space-y-3 p-4">
								<div class="break-words font-medium text-gray-100">{failure.reason}</div>
								<dl class="grid grid-cols-2 gap-x-5 gap-y-2 text-xs tabular-nums">
									<div class="flex justify-between gap-2"><dt class="text-gray-500">Count</dt><dd class="text-red-400">{fmtNum(failure.count)}</dd></div>
									<div class="flex justify-between gap-2"><dt class="text-gray-500">Share</dt><dd class="text-gray-300">{failure.share}%</dd></div>
									<div class="flex justify-between gap-2"><dt class="text-gray-500">Average</dt><dd class="text-gray-300">{formatElapsed(failure.avgSeconds)}</dd></div>
									<div class="flex justify-between gap-2"><dt class="text-gray-500">Total</dt><dd class="text-gray-300">{formatElapsed(failure.totalSeconds)}</dd></div>
								</dl>
							</li>
						{/each}
					</ul>
				{:else if stats.byState.failed === 0}
					<p class="inline-flex items-center gap-1.5 border-y border-gray-700 py-4 text-sm text-green-400"><Octicon name="check-circle" size={12} />No failures recorded.</p>
				{/if}
				{#if stats.failuresWithoutReason > 0}<p class="mt-2 text-xs text-gray-400">{fmtNum(stats.failuresWithoutReason)} failed migrations without a recorded reason</p>{/if}
			</section>
			<section>
				<div class="mb-3">
					<h3 class="flex items-center gap-2 text-sm font-semibold text-gray-200"><Octicon name="stack" size={16} class="text-gray-500" />Batch details</h3>
					<p class="mt-1 text-xs text-gray-500">Batches needing attention, followed by recent completed batches</p>
				</div>
				{#if stats.batchStats.length > 0}
					<div class="stats-print-table hidden overflow-x-auto border-y border-gray-700 md:block">
						<table class="stats-table w-full border-collapse tabular-nums">
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
							<tbody>
								{#each stats.batchStats as batch (batch.id)}
									<tr class="hover:bg-gray-800/30">
										<td class="text-left"><a class="font-medium text-blue-400 hover:text-blue-300" href="/migrate/batches/{batch.id}">{batch.id}</a>{#if batch.active || batch.completionRate === 100 || batch.needsReview > 0}<div class="mt-0.5 text-xs font-normal text-gray-500">{batch.active && batch.needsReview > 0 ? 'Active · Needs review' : batch.needsReview > 0 ? 'Needs review' : batch.active ? 'Active' : 'Completed'}</div>{/if}</td>
										<td class="px-3 py-3 text-right text-gray-300">{fmtNum(batch.total)}</td>
										<td class="px-3 py-3 text-right text-gray-300">{batch.completionRate}%</td>
										<td class="px-3 py-3 text-right text-gray-300">{fmtNum(batch.succeeded)}</td>
										<td class="px-3 py-3 text-right {batch.failed > 0 ? 'text-red-400' : 'text-gray-500'}">{fmtNum(batch.failed)}</td>
										<td class="px-3 py-3 text-right text-gray-400">{fmtNum(batch.cancelled)}</td>
										<td class="px-3 py-3 text-right {batch.needsReview > 0 ? 'text-orange-300' : 'text-gray-500'}">{fmtNum(batch.needsReview)}</td>
										<td class="whitespace-nowrap px-5 py-3 text-right text-gray-300">{formatElapsed(batch.elapsedSeconds)}</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
					<div class="stats-compact-list divide-y divide-gray-700 border-y border-gray-700 md:hidden">
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
						<h3 class="flex items-center gap-2 text-sm font-semibold text-gray-200">
							<Octicon name="arrow-switch" size={16} class="text-gray-500" />Migration paths
						</h3>
						<p class="mt-1 text-xs text-gray-500">Compare outcomes and duration by source → target</p>
					</div>
					<span class="text-xs text-gray-500">{fmtNum(directions.length)} paths</span>
				</div>
				{#if directions.length > 0}
				<div class="stats-print-table hidden overflow-x-auto border-y border-gray-700 md:block">
					<table class="stats-table w-full border-collapse tabular-nums">
						<thead class="bg-gray-950/40 text-xs uppercase text-gray-500">
							<tr>
								<th class="px-5 py-2 text-left font-medium">Path</th>
								<th class="px-3 py-2 text-right font-medium">Total</th>
								<th class="px-3 py-2 text-right font-medium">Volume</th>
								<th class="px-3 py-2 text-right font-medium">Succeeded</th>
								<th class="px-3 py-2 text-right font-medium">Failed</th>
								<th class="px-3 py-2 text-right font-medium">Cancelled</th>
								<th class="px-3 py-2 text-right font-medium">Success</th>
								<th class="px-3 py-2 text-right font-medium">Median</th>
								<th class="px-3 py-2 text-right font-medium">P95</th>
								<th class="px-5 py-2 text-right font-medium">Duration data</th>
							</tr>
						</thead>
						<tbody>
							{#each directions as direction (direction.key)}
								<tr class="hover:bg-gray-800/30">
									<td class="whitespace-nowrap text-left font-medium text-gray-200"><span class="inline-flex items-center gap-2">{direction.sourceLabel}<Octicon name="arrow-right" size={12} class="text-blue-400" />{direction.targetLabel}</span></td>
									<td class="px-3 py-3 text-right text-gray-300">{fmtNum(direction.total)}</td>
									<td class="px-3 py-3 text-right text-gray-400">{directionTotal > 0 ? Math.round((direction.total / directionTotal) * 100) : 0}%</td>
									<td class="px-3 py-3 text-right text-gray-300">{fmtNum(direction.success.succeeded)}</td>
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
				<div class="stats-compact-list divide-y divide-gray-700 border-y border-gray-700 md:hidden">
					{#each directions as direction (direction.key)}
						<div class="space-y-3 p-4 text-xs tabular-nums">
							<div class="font-medium text-gray-200">{direction.label}</div>
							<dl class="grid grid-cols-2 gap-x-5 gap-y-2">
								<div class="flex justify-between gap-2"><dt class="text-gray-500">Total</dt><dd class="text-gray-200">{fmtNum(direction.total)}</dd></div>
								<div class="flex justify-between gap-2"><dt class="text-gray-500">Volume</dt><dd class="text-gray-200">{directionTotal > 0 ? Math.round((direction.total / directionTotal) * 100) : 0}%</dd></div>
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
				{:else}
					<p class="border-y border-gray-700 py-4 text-sm text-gray-500">No data.</p>
				{/if}
			</section>
		</section>
		<section id="performance" aria-labelledby="performance-heading" class="space-y-6 scroll-mt-4">
			<section>
				<h2 id="performance-heading" class="sr-only">Performance &amp; volume</h2>
				<div class="mb-3 flex flex-wrap items-start justify-between gap-2">
					<div>
						<h3 class="flex items-center gap-2 text-sm font-semibold text-gray-200"><Octicon name="database" size={16} class="text-gray-500" />Performance by repository size</h3>
						<p class="mt-1 text-xs text-gray-500">Historical completion times, not an estimate</p>
					</div>
					{#if stats.sizeUnavailableCount > 0}<span class="text-xs text-gray-500">{fmtNum(stats.sizeUnavailableCount)} without size data</span>{/if}
				</div>
				<div class="overflow-x-auto border-y border-gray-700">
					<table class="stats-table w-full min-w-160 border-collapse tabular-nums">
						<thead class="bg-gray-950/40 text-xs uppercase text-gray-500"><tr><th class="px-5 py-2 text-left font-medium">Size</th><th class="px-3 py-2 text-right font-medium">Succeeded</th><th class="px-3 py-2 text-right font-medium">Failed</th><th class="px-3 py-2 text-right font-medium">Success</th><th class="px-3 py-2 text-right font-medium">Median</th><th class="px-3 py-2 text-right font-medium">P95</th><th class="px-5 py-2 text-right font-medium">Duration data</th></tr></thead>
						<tbody>
							{#each stats.sizeStats as row (row.band)}
								<tr class="hover:bg-gray-800/30"><td class="px-5 py-3 text-left"><span class="font-semibold text-gray-200">{row.band}</span><span class="ml-2 text-gray-500">{sizeBandLabel(row.band)}</span></td><td class="px-3 py-3 text-right text-gray-300">{fmtNum(row.succeeded)}</td><td class="px-3 py-3 text-right {row.failed > 0 ? 'text-red-400' : 'text-gray-500'}">{fmtNum(row.failed)}</td><td class="px-3 py-3 text-right text-gray-200">{row.outcomes > 0 ? `${row.rate}%` : '—'}</td><td class="px-3 py-3 text-right text-gray-300">{formatElapsed(row.duration.medianSeconds)}</td><td class="px-3 py-3 text-right text-gray-300">{formatElapsed(row.duration.p95Seconds)}</td><td class="whitespace-nowrap px-5 py-3 text-right text-gray-400">{fmtNum(row.duration.timedCount)} of {fmtNum(row.duration.eligibleCount)}</td></tr>
							{/each}
						</tbody>
					</table>
				</div>
			</section>
			<section>
				<div class="mb-3"><h3 class="flex items-center gap-2 text-sm font-semibold text-gray-200"><Octicon name="star" size={16} class="text-gray-500" />Highlights</h3><p class="mt-1 text-xs text-gray-500">Notable results across matching migrations</p></div>
				<dl class="stats-highlights grid grid-cols-1 gap-px overflow-hidden rounded-md border border-gray-700 bg-gray-700 sm:grid-cols-2 lg:grid-cols-4">
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
			<div class="stats-resources-grid grid gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
				<section>
					<div class="mb-3 flex flex-wrap items-end justify-between gap-2">
						<div>
							<h3 class="flex items-center gap-2 text-sm font-semibold text-gray-200"><Octicon name="database" size={16} class="text-gray-500" />Destination repository contents</h3>
							<p class="mt-1 text-xs text-gray-500">Recorded final destination counts, not measured items transferred</p>
						</div>
						<span class="text-xs text-gray-500">
							{fmtNum(stats.resources.migrationCount)} of {fmtNum(stats.byState.succeeded)} succeeded with final counts
						</span>
					</div>
					<dl class="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-gray-700 bg-gray-700">
						{#each resourceCards as resource (resource.label)}
							<div class="bg-gray-950 px-3 py-3">
								<dt class="flex items-center gap-1.5 text-xs text-gray-500"><Octicon name={resource.icon} size={12} class="text-blue-400" />{resource.label}</dt>
								<dd class="mt-1 text-base font-semibold tabular-nums text-gray-100">{stats.resources.migrationCount > 0 ? fmtNum(resource.value) : '—'}</dd>
							</div>
						{/each}
					</dl>
					<p class="mt-2 text-xs text-gray-500">Commits reflect default-branch history. Older recorded counts may include zeros from unavailable API data.</p>
				</section>
				<section class="flex min-h-0 flex-col">
					<div class="mb-3 flex items-start justify-between gap-3">
						<div>
							<h3 class="flex items-center gap-2 text-sm font-semibold text-gray-200">
								<Octicon name="organization" size={16} class="text-gray-500" />Top source organizations
							</h3>
							<p class="mt-1 text-xs text-gray-500">Migration attempts by source owner</p>
						</div>
						<span class="shrink-0 text-xs text-gray-500">Top {visibleTopOrgs.length}</span>
					</div>
					{#if stats.topOrgs.length > 0}
						<div class="overflow-x-auto border-y border-gray-700">
							<table class="stats-table w-full border-collapse tabular-nums">
								<thead class="bg-gray-950/40 text-gray-500"><tr><th class="px-3 py-2 text-left font-medium">Source owner</th><th class="px-3 py-2 text-right font-medium">Migrations</th><th class="px-3 py-2 text-right font-medium">Share</th></tr></thead>
								<tbody>
									{#each visibleTopOrgs as org (org.key)}
										<tr><td class="px-3 py-3 font-medium text-gray-200">{org.org}<span class="block text-xs font-normal text-gray-500">{org.provider} · {org.host}</span></td><td class="px-3 py-3 text-right text-gray-200">{fmtNum(org.count)}</td><td class="px-3 py-3 text-right text-gray-400">{stats.total > 0 ? ((org.count / stats.total) * 100).toFixed(1) : '0.0'}%</td></tr>
									{/each}
								</tbody>
							</table>
						</div>
					{:else}
						<p class="text-sm text-gray-500">No data.</p>
					{/if}
				</section>
			</div>
			<section>
				<div class="mb-3">
					<h3 class="flex items-center gap-2 text-sm font-semibold text-gray-200">
						<Octicon name="pulse" size={16} class="text-gray-500" />Per-migration averages
					</h3>
					<p class="mt-1 text-xs text-gray-500">Typical timing and repository contents for these results</p>
				</div>

				<section aria-labelledby="timing-heading">
					<h4 id="timing-heading" class="mb-2 text-xs text-gray-500">Timing · {fmtNum(stats.duration.timedCount)} migrations</h4>
					<dl class="grid grid-cols-1 divide-y divide-gray-700 overflow-hidden rounded-md border border-gray-700 bg-gray-950/30 sm:grid-cols-4 sm:divide-x sm:divide-y-0">
						<div class="px-4 py-3.5">
							<dt class="flex items-center gap-1.5 text-xs text-gray-500"><Octicon name="stopwatch" size={12} />Average</dt>
							<dd class="mt-1 text-lg font-semibold tabular-nums text-gray-50">{formatElapsed(stats.duration.avgSeconds)}</dd>
						</div>
						<div class="px-4 py-3.5">
							<dt class="text-xs text-gray-500">Median</dt>
							<dd class="mt-1 text-lg font-semibold tabular-nums text-gray-50">{formatElapsed(stats.duration.medianSeconds)}</dd>
						</div>
						<div class="px-4 py-3.5">
							<dt class="text-xs text-gray-500">95th percentile</dt>
							<dd class="mt-1 text-lg font-semibold tabular-nums text-gray-50">{formatElapsed(stats.duration.p95Seconds)}</dd>
						</div>
						<div class="px-4 py-3.5">
							<dt class="flex items-center gap-1.5 text-xs text-gray-500"><Octicon name="database" size={12} />Repo size</dt>
							<dd class="mt-1 text-lg font-semibold tabular-nums text-gray-50">{formatRepoSize(stats.data.avgKb)}</dd>
							<p class="mt-0.5 text-xs text-gray-500">{fmtNum(stats.data.sizedCount)} migrations</p>
						</div>
					</dl>
				</section>

				<section class="mt-6" aria-labelledby="contents-heading">
					<h4 id="contents-heading" class="text-sm font-semibold text-gray-200">Repository contents per migration</h4>
					<p class="mt-1 text-xs text-gray-500">Averages across {fmtNum(stats.resources.migrationCount)} migrations with final counts</p>
					<dl class="mt-3 grid grid-cols-1 divide-y divide-gray-700 overflow-hidden rounded-md border border-gray-700 bg-gray-950/30 sm:grid-cols-3 sm:divide-x sm:divide-y-0">
						<div class="px-4 py-3.5">
							<dt class="flex items-center gap-1.5 text-xs text-gray-500"><Octicon name="git-commit" size={12} />Commits</dt>
							<dd class="mt-1 text-lg font-semibold tabular-nums text-gray-50">{avgPerCountedMigration(stats.resources.commits)}</dd>
							<p class="mt-0.5 text-xs text-gray-500">per migration</p>
						</div>
						<div class="px-4 py-3.5">
							<dt class="flex items-center gap-1.5 text-xs text-gray-500"><Octicon name="issue-opened" size={12} />Issues</dt>
							<dd class="mt-1 text-lg font-semibold tabular-nums text-gray-50">{avgPerCountedMigration(stats.resources.issues)}</dd>
							<p class="mt-0.5 text-xs text-gray-500">per migration</p>
						</div>
						<div class="px-4 py-3.5">
							<dt class="flex items-center gap-1.5 text-xs text-gray-500"><Octicon name="git-pull-request" size={12} />Pull requests</dt>
							<dd class="mt-1 text-lg font-semibold tabular-nums text-gray-50">{avgPerCountedMigration(stats.resources.pullRequests)}</dd>
							<p class="mt-0.5 text-xs text-gray-500">per migration</p>
						</div>
					</dl>
				</section>
			</section>
		</section>

		<div class="stats-back">
			<a href="/migrate" class="inline-flex items-center gap-1 text-sm font-medium text-blue-400 hover:text-blue-300 hover:underline focus-visible:outline-2 focus-visible:outline-blue-500">
				<Octicon name="chevron-left" size={16} />
				Back to migrations
			</a>
		</div>
	{/if}

	<section class="stats-end" aria-label="Report closing page">
		<div class="stats-cover-brand">
			<Octicon name="mark-github" size={24} />
			<span>GitHub<br /><strong>Migration Toolkit</strong></span>
		</div>
		<div class="stats-cover-title">
			<p>Migration report</p>
			<h2>End of report</h2>
			<p>Migration statistics</p>
		</div>
		<div class="stats-end-scope">
			<span>Report scope</span>
			<p>{sourceFilterOptions.find((option) => option.value === filters.sourceProvider)?.label} → {targetFilterOptions.find((option) => option.value === filters.targetPlatform)?.label} · {periodOptions.find((option) => option.value === filters.period)?.label} · {modeOptions.find((option) => option.value === filters.mode)?.label}</p>
		</div>
	</section>
</div>

<style>
	.stats-cover,
	.stats-end {
		display: none;
	}

	.stats-print-context {
		display: none;
	}

	.stats-export {
		display: inline-flex;
		width: 2rem;
		height: 2rem;
		align-items: center;
		justify-content: center;
		border: 1px solid var(--button-default-borderColor-rest);
		border-radius: 0.375rem;
		background: var(--button-default-bgColor-rest);
		box-shadow: var(--button-default-shadow-resting);
		color: var(--button-default-fgColor-rest);
		font-size: 0.75rem;
		font-weight: 600;
		white-space: nowrap;
	}

	.stats-export:hover {
		background: var(--button-default-bgColor-hover);
	}

	.stats-export:active {
		background: var(--button-default-bgColor-active);
	}

	.stats-export:focus-visible {
		outline: 2px solid var(--fgColor-accent);
		outline-offset: 2px;
	}

	.stats-nav a {
		border-bottom: 2px solid transparent;
		font-size: 13px;
		font-weight: 550;
	}

	.stats-page:not(:has(#attention:target, #performance:target)) .stats-nav a[href="#overview"],
	.stats-page:has(#attention:target) .stats-nav a[href="#attention"],
	.stats-page:has(#performance:target) .stats-nav a[href="#performance"] {
		border-bottom-color: var(--fgColor-accent);
		color: var(--fgColor-default);
	}

	.stats-table {
		font-size: 13px;
	}

	.stats-table thead {
		background: transparent;
		text-transform: none;
	}

	.stats-table th {
		padding: 10px 12px;
		font-size: 11px;
		font-weight: 600;
		white-space: nowrap;
	}

	.stats-table td {
		padding: 12px;
		border-top: 1px solid var(--borderColor-muted);
	}

	.stats-table td:first-child {
		font-weight: 550;
	}

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

	@media print {
		@page stats-report {
			size: landscape;
			margin: 12mm;
			background: white;
		}

		:global(html:has(.stats-page)),
		:global(body:has(.stats-page)),
		:global(body:has(.stats-page) .min-h-screen) {
			min-height: 0;
			background: white;
			color: #1f2328;
			color-scheme: light;
		}

		:global(body:has(.stats-page) header) {
			display: none;
		}

		:global(body:has(.stats-page) main) {
			max-width: none;
			padding: 0;
		}

		.stats-page {
			--color-gray-50: #1f2328;
			--color-gray-100: #1f2328;
			--color-gray-200: #1f2328;
			--color-gray-300: #424a53;
			--color-gray-400: #424a53;
			--color-gray-500: #57606a;
			--color-gray-700: #d0d7de;
			--color-gray-800: #f6f8fa;
			--color-gray-900: #f6f8fa;
			--color-gray-950: #ffffff;
			--color-blue-400: #0969da;
			--color-green-400: #1a7f37;
			--color-green-500: #1a7f37;
			--color-red-400: #cf222e;
			--color-red-500: #cf222e;
			--borderColor-muted: #d8dee4;
			color: #1f2328;
			page: stats-report;
			print-color-adjust: exact;
			-webkit-print-color-adjust: exact;
		}

		.stats-cover,
		.stats-end {
			display: flex;
			height: 165mm;
			flex-direction: column;
		}

		.stats-cover {
			break-after: page;
		}

		.stats-end {
			margin-top: 0;
			break-before: page;
		}

		.stats-cover-brand {
			display: flex;
			align-items: center;
			gap: 12px;
			font-size: 11pt;
			line-height: 1.3;
		}

		.stats-cover-brand :global(svg) {
			width: 42px;
			height: 42px;
		}

		.stats-cover-title {
			margin-top: 33mm;
		}

		.stats-cover-title p:first-child {
			color: #57606a;
			font-size: 10pt;
			font-weight: 600;
			letter-spacing: 0.06em;
			text-transform: uppercase;
		}

		.stats-cover-title h2 {
			margin-top: 8px;
			font-size: 30pt;
			font-weight: 700;
			letter-spacing: -0.02em;
		}

		.stats-cover-title p:last-child {
			margin-top: 8px;
			color: #57606a;
			font-size: 11pt;
		}

		.stats-cover-details {
			margin-top: auto;
			border-top: 1px solid #d0d7de;
			padding-top: 6mm;
		}

		.stats-end-scope {
			margin-top: auto;
			border-top: 1px solid #d0d7de;
			padding-top: 6mm;
		}

		.stats-end-scope span {
			color: #57606a;
			font-size: 9pt;
		}

		.stats-end-scope p {
			margin-top: 4px;
			font-size: 11pt;
			font-weight: 600;
		}

		.stats-cover-route {
			display: flex;
			align-items: center;
			gap: 24px;
		}

		.stats-cover-route > div {
			min-width: 0;
			flex: 1;
		}

		.stats-cover-route div span,
		.stats-cover-details dt {
			display: block;
			color: #57606a;
			font-size: 9pt;
		}

		.stats-cover-route strong {
			display: block;
			margin-top: 4px;
			font-size: 14pt;
			font-weight: 600;
		}

		.stats-cover-arrow {
			color: #0969da;
			font-size: 20pt;
		}

		.stats-cover-details dl {
			display: flex;
			gap: 16mm;
			margin-top: 8mm;
		}

		.stats-cover-details dd {
			margin-top: 4px;
			font-size: 11pt;
			font-weight: 600;
		}

		.stats-export,
		.stats-filters,
		.stats-nav,
		.stats-back,
		.stats-overview-context,
		.stats-empty a,
		.stats-compact-list {
			display: none;
		}

		.stats-print-context {
			display: block;
			font-size: 11pt;
			color: #424a53;
		}

		.stats-print-table {
			display: block;
		}

		.stats-overview-metrics {
			grid-template-columns: repeat(5, minmax(0, 1fr));
		}

		.stats-overview-grid {
			grid-template-columns: minmax(0, 1.7fr) minmax(0, 1fr);
		}

		.stats-highlights {
			grid-template-columns: repeat(4, minmax(0, 1fr));
		}

		.stats-resources-grid {
			grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr);
		}

		.stats-overview-grid > section {
			break-inside: avoid;
		}

		.stats-chart-bars {
			justify-content: space-around;
		}

		.stats-chart-bars button {
			max-width: 1.75rem;
		}

		.stats-page :global(.overflow-x-auto),
		.stats-page :global(.overflow-hidden) {
			overflow: visible;
		}

		.stats-page :global(.truncate) {
			overflow: visible;
			text-overflow: clip;
			white-space: normal;
			overflow-wrap: anywhere;
		}

		.stats-table {
			min-width: 0;
			width: 100%;
			table-layout: auto;
		}

		.stats-table td {
			overflow-wrap: anywhere;
		}

		.stats-table thead {
			display: table-header-group;
		}

		.stats-table tr,
		.stats-page dl,
		.stats-page section[aria-labelledby="contents-heading"] {
			break-inside: avoid;
		}

		.stats-page h2,
		.stats-page h3,
		.stats-page h4 {
			break-after: avoid;
		}

		.stats-page section > :global(.mb-3) {
			break-after: avoid;
		}
	}

</style>