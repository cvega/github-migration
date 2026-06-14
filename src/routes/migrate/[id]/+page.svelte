<!-- Live migration detail page -->
<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { page } from '$app/state';
	import CancelConfirmModal from '$lib/components/CancelConfirmModal.svelte';
	import CleanupModal from '$lib/components/CleanupModal.svelte';
	import FailureDetail from '$lib/components/FailureDetail.svelte';
	import Octicon from '$lib/components/Octicon.svelte';
	import PhaseTimeline from '$lib/components/PhaseTimeline.svelte';
	import ProgressBar from '$lib/components/ProgressBar.svelte';
	import RestartModal from '$lib/components/RestartModal.svelte';
	import StatsTable from '$lib/components/StatsTable.svelte';
	import { formatDateTime, formatElapsed, formatRepoSize } from '$lib/format';
	import { isActiveState, isGitHubCloud } from '$lib/migration-display';
	import { createMigrationForm } from '$lib/migration-form.svelte';
	import { createMigrationEventSource, refreshMigrations } from '$lib/stores/migrations.svelte';
	import type { Counts, FailureDetail as FailureDetailType, Migration, MigrationEvent, Phase, Progress } from '$lib/types';

	let { data } = $props();
	let polledMigration = $state<Migration | null>(null);
	let migration = $derived<Migration>(polledMigration ?? data.migration);
	let eventLog = $state<MigrationEvent[]>([]);
	let currentPhase = $state<Phase>('PENDING_VALIDATION');
	let latestProgress = $state<Progress | null>(null);
	let sourceCounts = $state<Counts | null>(null);
	let failureDetail = $state<FailureDetailType | null>(null);

	let sse: ReturnType<typeof createMigrationEventSource> | null = null;
	let lastProcessedId = $state<number | undefined>(undefined);
	let pollInterval: ReturnType<typeof setInterval> | null = null;

	// ── Restart modal state ────────────────────────────────────────────────
	let showRestartModal = $state(false);
	let restartSubmitting = $state(false);
	let restartError = $state('');

	// ── Cancel confirmation modal state ────────────────────────────────────
	let showCancelModal = $state(false);
	let cancelSubmitting = $state(false);
	let cancelError = $state('');
	const cancelPhrase = $derived(`${migration.sourceOrg}/${migration.sourceRepo}`);

	// Auth mode for restart
	const sourceEnvApp = $derived(page.data.sourceAuth?.mode === 'github-app');
	const targetEnvApp = $derived(page.data.targetAuth?.mode === 'github-app');
	const sourceEnvPat = $derived(!!page.data.sourceAuth?.hasEnvPat);
	const targetEnvPat = $derived(!!page.data.targetAuth?.hasEnvPat);

	const restart = createMigrationForm(() => ({
		sourceEnvApp,
		sourceEnvPat,
		targetEnvApp,
		targetEnvPat,
	}));

	onMount(() => {
		// Seed from server-loaded data.
		eventLog = [...data.events];
		for (const ev of eventLog) processEvent(ev);

		// Only subscribe to SSE if migration is still active.
		if (isActiveState(migration.state)) {
			sse = createMigrationEventSource(migration.id);
		}

		startPolling();

		// Initialise restart auth modes based on env auth availability.
		restart.initAuthModes();

		return () => {
			if (pollInterval) clearInterval(pollInterval);
		};
	});

	onDestroy(() => {
		sse?.destroy();
	});

	// React to new SSE events via rune-backed reactive getter.
	// Track last processed event id rather than array length, because the SSE
	// store caps its buffer at ~501 entries and length stabilises after that.
	$effect(() => {
		if (!sse) return;
		const events = sse.events;
		if (events.length === 0) return;

		// Find events newer than what we already processed. Capture the id in a
		// const so it narrows inside the closure without a non-null assertion.
		const lastId = lastProcessedId;
		const startIdx =
			lastId === undefined
				? 0
				: events.findIndex(e => e.id !== undefined && e.id > lastId);

		if (startIdx === -1) return; // no new events

		for (let i = startIdx; i < events.length; i++) {
			const ev = events[i];
			if (!ev) continue;
			eventLog = [...eventLog.slice(-(1000 - 1)), ev];
			processEvent(ev);
		}

		const lastEvent = events[events.length - 1];
		if (lastEvent && lastEvent.id !== undefined) lastProcessedId = lastEvent.id;
	});

	function processEvent(ev: MigrationEvent) {
		if (ev.phase) currentPhase = ev.phase;
		if (ev.eventType === 'snapshot') {
			latestProgress = ev.payload.progress;
			if (ev.payload.sourceCounts) sourceCounts = ev.payload.sourceCounts;
		} else if (ev.eventType === 'complete') {
			latestProgress = ev.payload.progress;
			if (ev.payload.sourceCounts) sourceCounts = ev.payload.sourceCounts;
		} else if (ev.eventType === 'failure' && ev.payload.detail) {
			failureDetail = ev.payload.detail;
		} else if (ev.eventType === 'restart') {
			// Reset live state for the new run.
			currentPhase = 'PENDING_VALIDATION';
			latestProgress = null;
			sourceCounts = null;
			failureDetail = null;
		}
	}

	const isActive = $derived(isActiveState(migration.state));
	const stateColor = $derived(
		migration.state === 'succeeded' ? 'text-green-400' :
		migration.state === 'failed' ? 'text-red-400' :
		migration.state === 'cancelled' ? 'text-yellow-400' :
		'text-green-400'
	);

	// Target counts for display: prefer the latest/completion snapshot — the same
	// data the "Migration succeeded — …" log line reports — over the persisted
	// migration.targetCounts, which can capture GHEC's post-migration indexing
	// lag (issue/PR totalCount transiently reads 0). Falls back to targetCounts
	// only when no snapshot is available (e.g. older/recovered migrations).
	const displayTargetCounts = $derived<Counts | null>(
		latestProgress?.current
			? {
				commits: latestProgress.current.commits,
				branches: latestProgress.current.branches,
				tags: latestProgress.current.tags,
				issues: latestProgress.current.issues,
				pullRequests: latestProgress.current.pullRequests,
				releases: latestProgress.current.releases,
			}
			: migration.targetCounts
	);

	async function handleCancel() {
		cancelError = '';
		cancelSubmitting = false;
		showCancelModal = true;
	}

	async function confirmCancel() {
		cancelError = '';
		cancelSubmitting = true;
		try {
			const res = await fetch(`/api/migrations/${migration.id}`, { method: 'DELETE' });
			if (!res.ok) {
				cancelError = `Failed to cancel migration: HTTP ${res.status}`;
				return;
			}
			polledMigration = { ...migration, state: 'cancelled' };
			refreshMigrations();
			showCancelModal = false;
		} catch (err) {
			cancelError = err instanceof Error ? err.message : 'Unknown error';
		} finally {
			cancelSubmitting = false;
		}
	}

	function startPolling() {
		if (pollInterval) clearInterval(pollInterval);
		pollInterval = setInterval(async () => {
			const res = await fetch(`/api/migrations/${migration.id}`);
			if (res.ok) polledMigration = await res.json();
			if (!isActiveState(migration.state)) {
				if (pollInterval) clearInterval(pollInterval);
				pollInterval = null;
			}
		}, 5000);
	}

	function openRestartModal() {
		restartError = '';
		restartSubmitting = false;
		restart.reset();
		showRestartModal = true;
	}

	async function handleRestart(e: Event) {
		e.preventDefault();
		restartError = '';
		restartSubmitting = true;

		try {
			const res = await fetch(`/api/migrations/${migration.id}/restart`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(restart.buildPayload()),
			});

			if (!res.ok) {
				const data = await res.json();
				restartError = data.error || `HTTP ${res.status}`;
				return;
			}

			polledMigration = await res.json();
			showRestartModal = false;

			// Re-subscribe to SSE for the restarted migration.
			sse?.destroy();
			sse = createMigrationEventSource(migration.id);

			// Restart polling.
			startPolling();
			refreshMigrations();
		} catch (err) {
			restartError = err instanceof Error ? err.message : 'Unknown error';
		} finally {
			restartSubmitting = false;
		}
	}

	const isRestartable = $derived(migration.state === 'failed' || migration.state === 'cancelled');

	// Target cleanup (rename/delete) — only when the server says this migration
	// is a candidate (failed/cancelled, we created the repo) and cleanup is on.
	const cleanupMode = $derived(data.cleanup?.mode ?? 'off');
	const showCleanup = $derived(cleanupMode !== 'off' && !!data.cleanup?.candidate);
	let cleanupOpen = $state(false);

	function repoUrl(apiUrl: string, org: string, repo: string): string {
		const hostname = new URL(apiUrl).hostname;
		const base = hostname === 'api.github.com' || hostname === 'github.com'
			? 'https://github.com'
			: apiUrl.replace(/\/+$/, '').replace(/\/api\/v3$/, '');
		return `${base}/${org}/${repo}`;
	}

	const sourceRepoUrl = $derived(repoUrl(migration.sourceApiUrl, migration.sourceOrg, migration.sourceRepo));
	const targetRepoUrl = $derived(`https://github.com/${migration.targetOrg}/${migration.targetRepo}`);

	// ── Copy migration node ID ─────────────────────────────────────────────
	let copiedId = $state(false);
	async function copyMigrationId() {
		if (!migration.githubMigrationId) return;
		try {
			await navigator.clipboard.writeText(migration.githubMigrationId);
			copiedId = true;
			setTimeout(() => (copiedId = false), 1500);
		} catch {
			// Clipboard unavailable (e.g. insecure context); ignore.
		}
	}
</script>

<div class="space-y-6">
	<!-- Header -->
	<div class="flex items-start justify-between">
		<div>
			<div class="flex items-center gap-3">
				<Octicon name="repo" size={24} class="text-gray-400" />
				<h1 class="inline-flex items-center gap-1.5 text-2xl font-bold text-gray-50">
					{migration.sourceOrg}/{migration.sourceRepo}
					<a href={sourceRepoUrl} target="_blank" rel="noopener" class="inline-flex text-gray-500 hover:text-blue-400 transition-colors" title="Open source repo">
						<Octicon name="link-external" size={16} />
					</a>
				</h1>
				<span class="text-gray-500"><Octicon name="arrow-right" size={16} /></span>
				<span class="inline-flex items-center gap-1.5 text-2xl font-bold text-gray-300">
					{migration.targetOrg}/{migration.targetRepo}
					<a href={targetRepoUrl} target="_blank" rel="noopener" class="inline-flex text-gray-500 hover:text-blue-400 transition-colors" title="Open target repo">
						<Octicon name="link-external" size={16} />
					</a>
				</span>
			</div>
			<div class="mt-1 flex items-center gap-3 text-sm">
				<span class={`${stateColor} font-medium uppercase`}>{migration.state}</span>
				<span class="text-gray-600">·</span>
				<span class="inline-flex items-center gap-1 text-gray-400"
					title={migration.completedAt
						? `Started ${formatDateTime(migration.startedAt)}\nFinished ${formatDateTime(migration.completedAt)}`
						: `Started ${formatDateTime(migration.startedAt)}`}>
					<Octicon name="stopwatch" size={12} />{formatElapsed(migration.elapsedSeconds)}
				</span>
				{#if migration.sourceSizeKb != null}
					<span class="text-gray-600">·</span>
					<span class="inline-flex items-center gap-1 text-gray-400"><Octicon name="database" size={12} />{formatRepoSize(migration.sourceSizeKb)}</span>
				{/if}
				{#if migration.warningsCount > 0}
					<span class="text-gray-600">·</span>
					<span class="text-yellow-400">{migration.warningsCount} warnings</span>
				{/if}
				{#if migration.batchId}
					<span class="text-gray-600">·</span>
					<a href="/migrate/batches/{migration.batchId}" class="inline-flex items-center gap-1 text-blue-400 hover:text-blue-300 transition-colors">
						<Octicon name="stack" size={12} />
						Batch
					</a>
				{/if}
			</div>
		</div>
		{#if isActive}
			<button type="button" onclick={handleCancel}
				class="flex items-center gap-1.5 rounded-md border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-400 hover:bg-red-500/20 transition-colors">
				<Octicon name="x-circle" size={16} />
				Cancel
			</button>
		{:else if isRestartable}
			<div class="flex items-center gap-2">
				<button type="button" onclick={openRestartModal}
					class="flex items-center gap-1.5 rounded-md border border-blue-500/30 bg-blue-500/10 px-4 py-2 text-sm text-blue-400 hover:bg-blue-500/20 transition-colors">
					<Octicon name="sync" size={16} />
					Restart
				</button>
				{#if showCleanup}
					<button type="button" onclick={() => (cleanupOpen = true)}
						class="flex items-center gap-1.5 rounded-md border border-yellow-500/30 bg-yellow-500/10 px-4 py-2 text-sm text-yellow-400 hover:bg-yellow-500/20 transition-colors">
						<Octicon name="alert" size={16} />
						Clean up target
					</button>
				{/if}
			</div>
		{/if}
	</div>

	<!-- Phase timeline -->
	<div class="flex items-stretch gap-3">
		<div class="min-w-0 flex-1">
			<PhaseTimeline {currentPhase} failed={migration.state === 'failed'} />
		</div>
		{#if migration.githubMigrationId}
			<button type="button" onclick={copyMigrationId}
				title="Copy migration ID: {migration.githubMigrationId}"
				class="flex shrink-0 items-center gap-1.5 rounded-md border border-gray-700 bg-gray-900 px-3 text-sm text-gray-400 hover:bg-gray-800 hover:text-gray-200 transition-colors">
				<Octicon name={copiedId ? 'check' : 'copy'} size={16} />
				{copiedId ? 'Copied' : 'Copy ID'}
			</button>
		{/if}
	</div>

	<!-- Live stats overview (during active migration) -->
	{#if isActive && latestProgress}
		{@const snap = latestProgress.current}
		<div class="rounded-md border border-green-500/20 bg-green-500/5 p-4">
			<div class="flex items-center justify-between mb-3">
				<h2 class="flex items-center gap-2 text-sm font-semibold text-green-400 uppercase tracking-wide">
					<Octicon name="pulse" size={16} />
					Live Progress
				</h2>
				<span class="inline-flex items-center gap-1 text-xs text-gray-500"><Octicon name="stopwatch" size={12} />{formatElapsed(snap.elapsed)} elapsed</span>
			</div>
			<div class="grid grid-cols-3 sm:grid-cols-6 gap-3">
				{#each [
					{ label: 'Commits', icon: 'git-commit' as const, value: snap.commits, src: sourceCounts?.commits ?? 0 },
					{ label: 'Branches', icon: 'git-branch' as const, value: snap.branches, src: sourceCounts?.branches ?? 0 },
					{ label: 'Tags', icon: 'tag' as const, value: snap.tags, src: sourceCounts?.tags ?? 0 },
					{ label: 'Issues', icon: 'issue-opened' as const, value: snap.issues, src: sourceCounts?.issues ?? 0 },
					{ label: 'PRs', icon: 'git-pull-request' as const, value: snap.pullRequests, src: sourceCounts?.pullRequests ?? 0 },
					{ label: 'Releases', icon: 'package' as const, value: snap.releases, src: sourceCounts?.releases ?? 0 },
				] as s (s.label)}
					{@const pct = s.src > 0 ? Math.min(100, Math.round((s.value / s.src) * 100)) : 0}
					<div class="text-center">
						<div class="text-lg font-bold text-gray-50">{s.value.toLocaleString()}</div>
						<div class="inline-flex items-center gap-1 text-xs text-gray-500"><Octicon name={s.icon} size={12} />{s.label}</div>
						{#if s.src > 0}
							<div class="mt-1 h-1 rounded-full bg-gray-800 overflow-hidden">
								<div class="h-full rounded-full bg-green-500 transition-all" style="width: {pct}%"></div>
							</div>
							<div class="text-[10px] text-gray-600 mt-0.5">{pct}% of {s.src.toLocaleString()}</div>
						{/if}
					</div>
				{/each}
			</div>
			{#if latestProgress.commitsPerMin > 0 || latestProgress.issuesPerMin > 0}
				<div class="mt-3 flex gap-4 border-t border-green-500/10 pt-2 text-xs text-gray-400">
					{#if latestProgress.commitsPerMin > 0}
						<span class="inline-flex items-center gap-1"><Octicon name="stopwatch" size={12} />{Math.round(latestProgress.commitsPerMin)} commits/min</span>
					{/if}
					{#if latestProgress.issuesPerMin > 0}
						<span class="inline-flex items-center gap-1"><Octicon name="stopwatch" size={12} />{Math.round(latestProgress.issuesPerMin)} issues/min</span>
					{/if}
					{#if latestProgress.deltaCommits > 0}
						<span>+{latestProgress.deltaCommits.toLocaleString()} commits since last poll</span>
					{/if}
					{#if latestProgress.deltaIssues > 0}
						<span>+{latestProgress.deltaIssues.toLocaleString()} issues since last poll</span>
					{/if}
				</div>
			{/if}
		</div>
	{/if}

	<!-- Progress bars (during active migration) -->
	{#if latestProgress && sourceCounts}
		<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
			<ProgressBar
				label="Commits"
				current={latestProgress.current.commits}
				total={sourceCounts.commits}
				rate={latestProgress.commitsPerMin}
				rateLabel="/min" />
			<ProgressBar
				label="Branches"
				current={latestProgress.current.branches}
				total={sourceCounts.branches} />
			<ProgressBar
				label="Tags"
				current={latestProgress.current.tags}
				total={sourceCounts.tags} />
			<ProgressBar
				label="Issues"
				current={latestProgress.current.issues}
				total={sourceCounts.issues}
				rate={latestProgress.issuesPerMin}
				rateLabel="/min" />
			<ProgressBar
				label="Pull Requests"
				current={latestProgress.current.pullRequests}
				total={sourceCounts.pullRequests} />
			<ProgressBar
				label="Releases"
				current={latestProgress.current.releases}
				total={sourceCounts.releases} />
		</div>
	{/if}

	<!-- Stats comparison table -->
	{#if migration.sourceCounts || displayTargetCounts}
		<StatsTable source={migration.sourceCounts} target={displayTargetCounts} />
	{/if}

	<!-- Completion summary — Hero Banner + Icon Grid -->
	{#if migration.state === 'succeeded'}
		{@const src = migration.sourceCounts}
		{@const tgt = displayTargetCounts}
		{@const resources = src && tgt ? [
			{ label: 'Commits', icon: 'git-commit' as const, s: src.commits, t: tgt.commits },
			{ label: 'Branches', icon: 'git-branch' as const, s: src.branches, t: tgt.branches },
			{ label: 'Tags', icon: 'tag' as const, s: src.tags, t: tgt.tags },
			{ label: 'Issues', icon: 'issue-opened' as const, s: src.issues, t: tgt.issues },
			{ label: 'PRs', icon: 'git-pull-request' as const, s: src.pullRequests, t: tgt.pullRequests },
			{ label: 'Releases', icon: 'package' as const, s: src.releases, t: tgt.releases },
		].filter(r => r.s > 0 || r.t > 0) : []}
		{@const allMatch = resources.every(r => r.t >= r.s)}
		<section class="overflow-hidden rounded-lg border border-green-500/30">
			<!-- Hero banner -->
			<div class="bg-green-500/5 px-5 py-4">
				<div class="flex items-center gap-3">
					<div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-green-500/15">
						<Octicon name="check-circle" size={24} class="text-green-400" />
					</div>
					<div class="min-w-0">
						<h2 class="text-lg font-semibold text-green-400">Migration Succeeded</h2>
						<div class="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm text-gray-400">
							<a href={sourceRepoUrl} target="_blank" rel="noopener" class="inline-flex items-center gap-1 truncate hover:text-blue-400 transition-colors">
								{migration.sourceOrg}/{migration.sourceRepo}
								<Octicon name="link-external" size={12} />
							</a>
							<Octicon name="arrow-right" size={12} class="text-gray-600 shrink-0" />
							<a href={targetRepoUrl} target="_blank" rel="noopener" class="inline-flex items-center gap-1 truncate hover:text-blue-400 transition-colors">
								{migration.targetOrg}/{migration.targetRepo}
								<Octicon name="link-external" size={12} />
							</a>
							<span class="text-gray-600">·</span>
							<span class="inline-flex items-center gap-1"><Octicon name="stopwatch" size={12} />{formatElapsed(migration.elapsedSeconds)}</span>
							{#if migration.completedAt}
								<span class="text-gray-600">·</span>
								<span class="inline-flex items-center gap-1" title="Started {formatDateTime(migration.startedAt)}"><Octicon name="check" size={12} />{formatDateTime(migration.completedAt)}</span>
							{/if}
							{#if migration.warningsCount > 0}
								<span class="text-gray-600">·</span>
								<span class="inline-flex items-center gap-1 text-yellow-400"><Octicon name="alert" size={12} />{migration.warningsCount} warnings</span>
							{/if}
						</div>
					</div>
				</div>
			</div>

			<!-- Resource grid -->
			{#if resources.length > 0}
				{@const cols = resources.length}
				<div class="resource-grid gap-px bg-gray-800"
					style="--cols-mobile: {Math.min(cols, 3)}; --cols-full: {cols};">
					{#each resources as r (r.label)}
						{@const match = r.t >= r.s}
						{@const extra = r.t - r.s}
						<div class="flex flex-col items-center gap-1 bg-gray-950 px-3 py-4">
							<div class="flex items-center gap-1 {match ? 'text-green-400' : 'text-yellow-400'}">
								<Octicon name={r.icon} size={16} />
								{#if match}<Octicon name="check-circle" size={12} />{:else}<Octicon name="alert" size={12} />{/if}
							</div>
							<div class="text-xl font-bold text-gray-50">{r.t.toLocaleString()}</div>
							<div class="text-xs text-gray-500">{r.label}</div>
							{#if extra > 0}
								<div class="text-[10px] text-gray-500"
									title="{r.s.toLocaleString()} migrated from source + {extra.toLocaleString()} created by the migration">
									+{extra.toLocaleString()} added
								</div>
							{:else if extra < 0}
								<div class="text-[10px] text-yellow-400">{r.t.toLocaleString()} of {r.s.toLocaleString()}</div>
							{/if}
						</div>
					{/each}
				</div>
			{/if}

			<!-- Footer bar — only rendered when there's content -->
			{#if !allMatch || migration.migrationLogUrl || (latestProgress && (latestProgress.commitsPerMin > 0 || latestProgress.issuesPerMin > 0))}
				<div class="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-gray-800 bg-gray-950 px-5 py-2.5 text-xs text-gray-500">
					{#if !allMatch}
						<span class="inline-flex items-center gap-1 text-yellow-400"><Octicon name="alert" size={12} />Some resources may need attention</span>
						<span class="text-gray-700">·</span>
					{/if}
					{#if latestProgress}
						{#if latestProgress.commitsPerMin > 0}
							<span class="inline-flex items-center gap-1"><Octicon name="zap" size={12} />{Math.round(latestProgress.commitsPerMin)} commits/min</span>
						{/if}
						{#if latestProgress.issuesPerMin > 0}
							<span class="inline-flex items-center gap-1"><Octicon name="zap" size={12} />{Math.round(latestProgress.issuesPerMin)} issues/min</span>
						{/if}
					{/if}
					{#if migration.migrationLogUrl}
						<a href={migration.migrationLogUrl} target="_blank" rel="noopener"
							class="ml-auto inline-flex items-center gap-1 text-blue-400 hover:text-blue-300 transition-colors">
							<Octicon name="link-external" size={12} />
							View Migration Log
						</a>
					{/if}
				</div>
			{/if}
		</section>
	{/if}

	<!-- Failure details -->
	{#if migration.state === 'failed' && failureDetail}
		<FailureDetail detail={failureDetail} {migration} events={eventLog} />
	{/if}

	<!-- Event log -->
	<section>
		<h2 class="mb-3 flex items-center gap-2 text-lg font-semibold text-gray-300">
			<Octicon name="log" size={16} />
			Event Log
		</h2>
		<div class="max-h-96 overflow-y-auto rounded-md border border-gray-700 bg-gray-900">
			{#each eventLog as event, i (event.id ?? i)}
				<div class="flex items-start gap-3 border-b border-gray-800/50 px-4 py-2.5 last:border-0 {i % 2 === 0 ? 'bg-gray-900/30' : ''}">
					<span class="mt-0.5 shrink-0 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium
				{event.eventType === 'step' ? 'bg-green-600/15 text-green-400' :
					 event.eventType === 'phase_change' ? 'bg-purple-500/15 text-purple-400' :
					 event.eventType === 'complete' ? 'bg-green-600/15 text-green-400' :
					 event.eventType === 'failure' ? 'bg-red-500/15 text-red-400' :
					 event.eventType === 'restart' ? 'bg-blue-500/15 text-blue-400' :
					 event.eventType === 'snapshot' ? 'bg-gray-500/15 text-gray-400' :
					 'bg-gray-500/15 text-gray-400'}">
						<Octicon name={event.eventType === 'step' ? 'play'
							: event.eventType === 'phase_change' ? 'milestone'
							: event.eventType === 'complete' ? 'check-circle'
							: event.eventType === 'failure' ? 'x-circle'
							: event.eventType === 'restart' ? 'sync'
							: event.eventType === 'snapshot' ? 'graph'
							: 'dot'} size={12} />
						{event.eventType}
					</span>
					<span class="text-sm text-gray-300">
						{#if event.eventType === 'step'}
							{event.payload.message || ''}
						{:else if event.eventType === 'phase_change'}
							{event.payload.from} → {event.payload.to}
					{:else if event.eventType === 'snapshot'}
						{@const snap = event.payload.progress?.current}
						{#if snap}
							<span class="text-gray-500">{event.phase}</span>
							{#each [
								{ k: 'commits', v: snap.commits },
								{ k: 'branches', v: snap.branches },
								{ k: 'tags', v: snap.tags },
								{ k: 'issues', v: snap.issues },
								{ k: 'PRs', v: snap.pullRequests },
								{ k: 'releases', v: snap.releases },
							].filter(i => i.v > 0) as item, idx (item.k)}
								{#if idx > 0}<span class="text-gray-600">, </span>{/if}
								<span class="text-gray-400">{item.v.toLocaleString()}</span>
								<span class="text-gray-500"> {item.k}</span>
							{:else}
								<span class="text-gray-500 ml-2">waiting for data...</span>
							{/each}
						{:else}
							{event.phase}
						{/if}
						{:else if event.eventType === 'complete'}
						{@const snap = event.payload.progress?.current}
						Migration succeeded
						{#if snap}
							— {(snap.commits || 0).toLocaleString()} commits, {(snap.branches || 0).toLocaleString()} branches, {(snap.tags || 0).toLocaleString()} tags, {(snap.issues || 0).toLocaleString()} issues, {(snap.pullRequests || 0).toLocaleString()} PRs, {(snap.releases || 0).toLocaleString()} releases
						{/if}
						{#if event.payload.elapsed}
							in {formatElapsed(event.payload.elapsed)}
						{/if}
						{:else if event.eventType === 'failure'}
							{event.payload.error ||
							 event.payload.detail?.failureReason || 'Migration failed'}
						{:else if event.eventType === 'restart'}
							{event.payload.message || 'Migration restarted'}
						{:else}
							{JSON.stringify(event.payload)}
						{/if}
					</span>
					<span class="ml-auto shrink-0 text-xs text-gray-600">
						{new Date(event.createdAt).toLocaleTimeString()}
					</span>
				</div>
			{/each}
			{#if eventLog.length === 0}
				<div class="px-4 py-8 text-center text-sm text-gray-500">
					{isActive ? 'Waiting for events...' : 'No events recorded'}
				</div>
			{/if}
		</div>
	</section>
</div>

<!-- Restart Modal -->
<RestartModal
	bind:open={showRestartModal}
	form={restart}
	submitting={restartSubmitting}
	error={restartError}
	title="Restart Migration"
	submitLabel="Restart Migration"
	productionLockText="Source repository will be locked during migration and archived after success."
	{sourceEnvApp}
	{sourceEnvPat}
	{targetEnvApp}
	{targetEnvPat}
	allowOverride={page.data.allowCredentialOverride ?? true}
	onsubmit={handleRestart}
>
	{#snippet info()}
		<!-- Migration info (read-only) -->
		<div class="rounded-md border border-gray-700/50 bg-gray-800/50 px-4 py-3">
			<div class="flex items-center gap-2 text-sm text-gray-300">
				<span class="font-medium text-gray-50">{migration.sourceOrg}/{migration.sourceRepo}</span>
				<Octicon name="arrow-right" size={12} class="text-gray-500" />
				<span class="font-medium text-gray-50">{migration.targetOrg}/{migration.targetRepo}</span>
			</div>
			{#if !isGitHubCloud(migration.sourceApiUrl)}
				<p class="mt-1 inline-flex items-center gap-1 text-xs text-gray-500">
					<Octicon name="server" size={12} />
					{migration.sourceApiUrl}
				</p>
			{/if}
		</div>
	{/snippet}
</RestartModal>

<!-- Cancel confirmation modal -->
<CancelConfirmModal
	bind:open={showCancelModal}
	title="Cancel this migration?"
	confirmPhrase={cancelPhrase}
	submitLabel="Cancel Migration"
	submitting={cancelSubmitting}
	error={cancelError}
	inputId="cancel-confirm"
	onConfirm={confirmCancel}
>
	{#snippet body()}
		<p class="text-sm text-gray-300">
			This stops the migration of
			<span class="font-medium text-gray-50">{migration.sourceOrg}/{migration.sourceRepo}</span>.
			You can restart it afterwards from this page.
		</p>
	{/snippet}
</CancelConfirmModal>

{#if showCleanup}
	<CleanupModal
		migrationId={migration.id}
		targetOrg={migration.targetOrg}
		targetRepo={migration.targetRepo}
		mode={cleanupMode === 'delete' ? 'delete' : 'rename'}
		bind:open={cleanupOpen}
		onDone={() => {
			polledMigration = { ...migration };
			refreshMigrations();
		}}
	/>
{/if}

<style>
	.resource-grid {
		display: grid;
		grid-template-columns: repeat(var(--cols-mobile, 3), minmax(0, 1fr));
	}
	@media (min-width: 640px) {
		.resource-grid {
			grid-template-columns: repeat(var(--cols-full, 6), minmax(0, 1fr));
		}
	}
</style>
