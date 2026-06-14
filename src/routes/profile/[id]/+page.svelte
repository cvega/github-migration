<!-- One profiling run: readiness summary + per-repo consideration matrix. Polls while running. -->
<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import Octicon from '$lib/components/Octicon.svelte';
	import { timeAgo } from '$lib/format';
	import { MIGRATION_CONSIDERATIONS } from '$lib/profile/consideration-registry';

	let { data } = $props();

	// Prefer freshly-polled data, but only when it's for the run currently shown
	// (on navigation `data.run.id` changes and we fall back to the new snapshot
	// until the next poll). Avoids resetting state from an effect.
	let polled = $state<typeof data | null>(null);
	const fresh = $derived(polled && polled.run.id === data.run.id ? polled : null);
	const run = $derived(fresh?.run ?? data.run);
	const repos = $derived(fresh?.repos ?? data.repos);

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

	// Run-level insight rollup: count each insight kind across all repos.
	const insightRollup = $derived.by(() => {
		const m = new Map<string, { id: string; tone: string; label: string; count: number }>();
		for (const repo of repos) {
			for (const ins of repo.insights ?? []) {
				const cur = m.get(ins.id);
				if (cur) cur.count += 1;
				else m.set(ins.id, { id: ins.id, tone: ins.tone, label: ins.label, count: 1 });
			}
		}
		return [...m.values()];
	});

	const stateBadge: Record<RunState, { label: string; cls: string; icon: 'sync' | 'check-circle-fill' | 'x-circle-fill' }> = {
		running: { label: 'Running', cls: 'bg-blue-500/15 text-blue-300', icon: 'sync' },
		completed: { label: 'Completed', cls: 'bg-green-500/15 text-green-300', icon: 'check-circle-fill' },
		failed: { label: 'Failed', cls: 'bg-red-500/15 text-red-300', icon: 'x-circle-fill' }
	};

	const badge = $derived(stateBadge[run.state]);
	const pct = $derived(run.totalRepos > 0 ? Math.round((run.profiledRepos / run.totalRepos) * 100) : 0);

	let interval: ReturnType<typeof setInterval> | null = null;
	async function poll() {
		if (run.state !== 'running') return;
		try {
			const res = await fetch(`/api/profile/${data.run.id}`);
			if (res.ok) polled = await res.json();
		} catch {
			// Non-fatal — keep the last good snapshot.
		}
	}
	onMount(() => {
		interval = setInterval(poll, 3000);
		return () => { if (interval) clearInterval(interval); };
	});
	onDestroy(() => { if (interval) clearInterval(interval); });
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
			<p class="mt-1 font-mono text-xs text-gray-500">{run.sourceApiUrl} · started {timeAgo(run.startedAt)}</p>
		</div>
		<a href="/profile" class="text-sm text-gray-400 transition-colors hover:text-gray-50">← All runs</a>
	</header>

	{#if run.failureReason}
		<div class="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">
			<Octicon name="x-circle-fill" size={16} class="mt-0.5 shrink-0" />
			<span>{run.failureReason}</span>
		</div>
	{/if}

	<!-- Summary tiles -->
	<section class="grid grid-cols-2 gap-3 sm:grid-cols-4">
		<div class="rounded-lg border border-gray-700 bg-gray-900 p-4">
			<div class="text-2xl font-semibold text-gray-50">{run.profiledRepos}<span class="text-base text-gray-500">/{run.totalRepos}</span></div>
			<div class="mt-1 text-xs text-gray-400">Repositories profiled</div>
			{#if run.state === 'running'}
				<div class="mt-2 h-1.5 overflow-hidden rounded-full bg-gray-800">
					<div class="h-full bg-violet-500 transition-all" style="width: {pct}%"></div>
				</div>
			{/if}
		</div>
		<div class="rounded-lg border border-gray-700 bg-gray-900 p-4">
			<div class="flex items-center gap-1.5 text-2xl font-semibold text-red-400"><Octicon name="stop" size={16} />{run.blockers}</div>
			<div class="mt-1 text-xs text-gray-400">Blockers</div>
		</div>
		<div class="rounded-lg border border-gray-700 bg-gray-900 p-4">
			<div class="flex items-center gap-1.5 text-2xl font-semibold text-yellow-400"><Octicon name="alert" size={16} />{run.warnings}</div>
			<div class="mt-1 text-xs text-gray-400">Warnings</div>
		</div>
		<div class="rounded-lg border border-gray-700 bg-gray-900 p-4">
			<div class="text-2xl font-semibold text-gray-50">{repos.length}</div>
			<div class="mt-1 text-xs text-gray-400">Repos with results</div>
		</div>
	</section>

	<!-- Insights rollup -->
	{#if insightRollup.length > 0}
		<section>
			<h2 class="mb-3 flex items-center gap-2 text-lg font-semibold text-gray-300">
				<Octicon name="light-bulb" size={16} />
				Insights
			</h2>
			<div class="flex flex-wrap gap-2">
				{#each insightRollup as item (item.id)}
					<span class="inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm {toneClass[item.tone]}">
						<Octicon name={toneIcon[item.tone] ?? 'info'} size={12} />
						<span class="font-semibold tabular-nums">{item.count}</span>
						{item.label}
					</span>
				{/each}
			</div>
		</section>
	{/if}

	<!-- Per-repo readiness -->
	<section>
		<h2 class="mb-3 flex items-center gap-2 text-lg font-semibold text-gray-300">
			<Octicon name="repo" size={16} />
			Repositories
		</h2>

		{#if repos.length === 0}
			<div class="flex flex-col items-center justify-center rounded-md border border-dashed border-gray-600 py-12 text-gray-400">
				<Octicon name={run.state === 'running' ? 'sync' : 'inbox'} size={24} class="h-10 w-10 text-gray-500 {run.state === 'running' ? 'animate-spin' : ''}" />
				<p class="mt-3">{run.state === 'running' ? 'Crawling…' : 'No repositories profiled'}</p>
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
						{#each repos as repo (repo.nameWithOwner)}
							<tr class="bg-gray-950/40 align-top transition-colors hover:bg-gray-900/60">
								<td class="px-4 py-3 font-medium text-gray-50">{repo.nameWithOwner}</td>
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
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</section>
</div>
