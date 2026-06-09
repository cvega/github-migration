<!-- Migration card for the dashboard list -->
<script lang="ts">
	import { goto } from '$app/navigation';
	import type { Migration, Snapshot, Counts, Phase } from '$lib/types';
	import { formatElapsed, formatRepoSize, formatDateTime } from '$lib/format';
	import Octicon from '$lib/components/Octicon.svelte';
	import type { IconName } from '@primer/octicons';

	let {
		migration,
		live,
		now,
	}: {
		migration: Migration;
		live?: { snapshot: Snapshot; sourceCounts: Counts | null };
		now?: number;
	} = $props();

	const stateStyles: Record<string, string> = {
		queued: 'bg-blue-500/15 text-blue-400',
		pending: 'bg-yellow-500/15 text-yellow-400',
		running: 'bg-green-600/15 text-green-400',
		succeeded: 'bg-green-600/15 text-green-400',
		failed: 'bg-red-500/15 text-red-400',
		cancelled: 'bg-gray-500/15 text-gray-400'
	};

	const stateIcons: Record<string, IconName> = {
		queued: 'hourglass',
		pending: 'clock',
		running: 'sync',
		succeeded: 'check-circle',
		failed: 'x-circle-fill',
		cancelled: 'skip'
	};

	const phaseMeta: Record<Phase, { label: string; icon: IconName }> = {
		QUEUED: { label: 'Queued', icon: 'clock' },
		PENDING_VALIDATION: { label: 'Validating', icon: 'shield-check' },
		EXPORTING: { label: 'Exporting', icon: 'download' },
		IMPORTING_GIT: { label: 'Git import', icon: 'repo-push' },
		IMPORTING_METADATA: { label: 'Metadata', icon: 'note' },
		SUCCEEDED: { label: 'Done', icon: 'check-circle' },
		FAILED: { label: 'Failed', icon: 'x-circle' },
		UNKNOWN: { label: 'Working', icon: 'sync' }
	};

	const isActive = $derived(
		migration.state === 'queued' || migration.state === 'pending' || migration.state === 'running'
	);

	// Source platform: GitHub Enterprise Server vs. GitHub.com. Target is always GHEC.
	const sourcePlatform = $derived(
		migration.sourceApiUrl && !migration.sourceApiUrl.includes('api.github.com') ? 'GHES' : 'GHEC'
	);

	// Live wall-clock elapsed for active migrations (ticks via `now`).
	const liveElapsed = $derived(
		isActive && now ? (now - new Date(migration.startedAt).getTime()) / 1000 : migration.elapsedSeconds
	);

	// Blended progress (commits + issues + PRs migrated vs. source) for the live bar.
	const livePct = $derived.by(() => {
		if (!live) return null;
		const src = live.sourceCounts;
		if (!src) return null;
		const total = src.commits + src.issues + src.pullRequests;
		if (total <= 0) return null;
		const done = live.snapshot.commits + live.snapshot.issues + live.snapshot.pullRequests;
		return Math.min(100, Math.round((done / total) * 100));
	});

	// Copy a compact failure report for a services engineer (mirrors the
	// migration detail page's report, minus the per-entry log which isn't
	// loaded on the card).
	let copiedError = $state(false);

	function buildErrorReport(): string {
		const m = migration;
		const lines = [
			'GitHub Migration — Failure Report',
			'==================================',
			`Source repo:        ${m.sourceOrg}/${m.sourceRepo}`,
			`Target repo:        ${m.targetOrg}/${m.targetRepo}`,
			`Source API URL:     ${m.sourceApiUrl}`,
			`Migration ID:       ${m.id}`,
			`GHEC migration ID:  ${m.githubMigrationId ?? '(not assigned)'}`,
			`Batch ID:           ${m.batchId ?? '(none)'}`,
			`State:              ${m.state}`,
			`Failure reason:     ${m.failureReason ?? '(none)'}`,
			`Started:            ${formatDateTime(m.startedAt)}`,
			`Completed:          ${m.completedAt ? formatDateTime(m.completedAt) : '(n/a)'}`,
			`Elapsed:            ${formatElapsed(m.elapsedSeconds)}`,
			`Source size:        ${m.sourceSizeKb != null ? formatRepoSize(m.sourceSizeKb) : '(unknown)'}`,
			`Auth mode:          ${m.authMode ?? '(unknown)'}`,
			`Warnings:           ${m.warningsCount}`,
			`Migration log:      ${m.migrationLogUrl ?? '(none)'}`,
		];
		return lines.join('\n');
	}

	async function copyErrorDetails(e: MouseEvent) {
		// The card is a link — don't navigate when copying.
		e.preventDefault();
		e.stopPropagation();
		try {
			await navigator.clipboard.writeText(buildErrorReport());
			copiedError = true;
			setTimeout(() => (copiedError = false), 1500);
		} catch {
			// Clipboard unavailable (e.g. insecure context); ignore.
		}
	}
</script>

<a href="/{migration.id}"
	class="block rounded-md border border-gray-700 bg-gray-900 p-4 hover:border-gray-600 hover:bg-gray-800 transition-all">
	<div class="flex items-center justify-between">
		<div class="flex items-center gap-2 min-w-0">
			<span class="inline-flex items-center gap-1.5 text-sm font-medium text-gray-50 min-w-0">
				<Octicon name="repo" size={16} class="text-gray-500 shrink-0" />
				<span class="truncate">{migration.sourceOrg}/{migration.sourceRepo}</span>
			</span>
			<span class="text-gray-500 shrink-0"><Octicon name="arrow-right" size={12} /></span>
			<span class="inline-flex items-center gap-1.5 text-sm text-gray-300 min-w-0">
				<Octicon name="repo" size={16} class="text-gray-600 shrink-0" />
				<span class="truncate">{migration.targetOrg}/{migration.targetRepo}</span>
			</span>
		</div>

		<div class="flex items-center gap-3">
			{#if liveElapsed}
				<span class="inline-flex items-center gap-1 text-xs {isActive ? 'text-green-400' : 'text-gray-500'}"
					title={migration.completedAt
						? `Started ${formatDateTime(migration.startedAt)}\nFinished ${formatDateTime(migration.completedAt)}`
						: `Started ${formatDateTime(migration.startedAt)}`}>
					<Octicon name="stopwatch" size={12} />{formatElapsed(liveElapsed, '')}
				</span>
			{/if}
			<span class="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium {stateStyles[migration.state] || stateStyles.pending}">
				<Octicon name={stateIcons[migration.state] || 'clock'} size={12} class={migration.state === 'running' ? 'animate-spin' : ''} />
				{migration.state}
			</span>
		</div>
	</div>

	{#if isActive && live}
		{@const snap = live.snapshot}
		{@const meta = phaseMeta[snap.phase] ?? phaseMeta.UNKNOWN}
		<div class="mt-2.5">
			<div class="flex items-center justify-between text-xs">
				<span class="inline-flex items-center gap-1 text-green-400"><Octicon name={meta.icon} size={12} />{meta.label}</span>
				<span class="flex items-center gap-3 text-gray-500">
					{#if snap.commits > 0}<span class="inline-flex items-center gap-1"><Octicon name="git-commit" size={12} />{snap.commits.toLocaleString()}</span>{/if}
					{#if snap.issues > 0}<span class="inline-flex items-center gap-1"><Octicon name="issue-opened" size={12} />{snap.issues.toLocaleString()}</span>{/if}
					{#if snap.pullRequests > 0}<span class="inline-flex items-center gap-1"><Octicon name="git-pull-request" size={12} />{snap.pullRequests.toLocaleString()}</span>{/if}
					{#if livePct != null}<span class="tabular-nums text-gray-400">{livePct}%</span>{/if}
				</span>
			</div>
			<div class="mt-1.5 h-1.5 overflow-hidden rounded-full bg-gray-800">
				{#if livePct != null}
					<div class="h-full rounded-full bg-green-500 transition-all duration-500" style="width: {livePct}%"></div>
				{:else}
					<div class="h-full w-1/3 animate-pulse rounded-full bg-green-500/60"></div>
				{/if}
			</div>
		</div>
	{/if}

	<div class="mt-2 flex items-center justify-between gap-3">
		<div class="flex min-w-0 shrink-0 items-center gap-x-3 gap-y-1 flex-wrap text-xs text-gray-500 [&>*:not(:first-child)]:before:content-['·'] [&>*:not(:first-child)]:before:mr-3 [&>*:not(:first-child)]:before:text-gray-600">
			{#if migration.sourceSizeKb != null}
				<span class="inline-flex items-center gap-1"><Octicon name="database" size={12} /> {formatRepoSize(migration.sourceSizeKb)}</span>
			{/if}
			{#if migration.batchId}
				<!-- Use onclick to avoid nested <a> inside card link -->
				<span><button type="button" onclick={(e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); goto(`/batches/${migration.batchId}`); }} class="inline-flex items-center gap-1 text-blue-400 hover:text-blue-300 underline cursor-pointer bg-transparent border-none p-0"><Octicon name="stack" size={12} />batch</button></span>
			{/if}
			{#if migration.warningsCount > 0}
				<span class="inline-flex items-center gap-1 text-yellow-500/80"><Octicon name="alert" size={12} /> {migration.warningsCount} warnings</span>
			{/if}
			<span class="inline-flex items-center gap-1.5" title="{sourcePlatform === 'GHES' ? 'GitHub Enterprise Server' : 'GitHub.com'} to GitHub Enterprise Cloud">
				<span class="inline-flex items-center gap-1"><Octicon name="server" size={12} />{sourcePlatform}</span>
				<span class="text-gray-600">→</span>
				<span class="inline-flex items-center gap-1"><Octicon name="cloud" size={12} />GHEC</span>
			</span>
		</div>
		{#if migration.failureReason}
			<div class="flex min-w-0 items-center gap-2">
				<p class="min-w-0 truncate text-xs text-red-400/80" title={migration.failureReason}>{migration.failureReason}</p>
				<!-- Use onclick + stopPropagation to avoid triggering the card link -->
				<button type="button" onclick={copyErrorDetails}
					title="Copy error details to share with a services engineer"
					class="shrink-0 inline-flex items-center gap-1 rounded border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-xs text-red-300 hover:bg-red-500/20 transition-colors cursor-pointer">
					<Octicon name={copiedError ? 'check' : 'copy'} size={12} />
					{copiedError ? 'Copied' : 'Copy'}
				</button>
			</div>
		{/if}
	</div>
</a>
