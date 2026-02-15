<!-- Migration card for the dashboard list -->
<script lang="ts">
	import type { Migration } from '$lib/types';
	import Octicon from '$lib/components/Octicon.svelte';
	import type { IconName } from '@primer/octicons';

	let { migration }: { migration: Migration } = $props();

	const stateStyles: Record<string, string> = {
		pending: 'bg-yellow-500/15 text-yellow-400',
		running: 'bg-green-600/15 text-green-400',
		succeeded: 'bg-green-600/15 text-green-400',
		failed: 'bg-red-500/15 text-red-400',
		cancelled: 'bg-gray-500/15 text-gray-400'
	};

	const stateIcons: Record<string, IconName> = {
		pending: 'clock',
		running: 'sync',
		succeeded: 'check-circle',
		failed: 'x-circle-fill',
		cancelled: 'skip'
	};

	function formatElapsed(seconds: number | null): string {
		if (!seconds) return '';
		const m = Math.floor(seconds / 60);
		const s = Math.round(seconds % 60);
		return m > 0 ? `${m}m ${s}s` : `${s}s`;
	}

	function timeAgo(dateStr: string): string {
		const diff = Date.now() - new Date(dateStr).getTime();
		const mins = Math.floor(diff / 60_000);
		if (mins < 1) return 'just now';
		if (mins < 60) return `${mins}m ago`;
		const hrs = Math.floor(mins / 60);
		if (hrs < 24) return `${hrs}h ago`;
		return `${Math.floor(hrs / 24)}d ago`;
	}
</script>

<a href="/{migration.id}"
	class="block rounded-md border border-gray-700 bg-gray-900 p-4 hover:border-gray-600 hover:bg-gray-800 transition-all">
	<div class="flex items-center justify-between">
		<div class="flex items-center gap-3">
			<div>
				<span class="text-sm font-medium text-gray-50">
					{migration.sourceOrg}/{migration.sourceRepo}
				</span>
				<span class="mx-2 text-gray-500"><Octicon name="arrow-right" size={12} /></span>
				<span class="text-sm text-gray-300">
					{migration.targetOrg}/{migration.targetRepo}
				</span>
			</div>
		</div>

		<div class="flex items-center gap-3">
			{#if migration.elapsedSeconds}
				<span class="text-xs text-gray-500">{formatElapsed(migration.elapsedSeconds)}</span>
			{/if}
			<span class="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium {stateStyles[migration.state] || stateStyles.pending}">
				<Octicon name={stateIcons[migration.state] || 'clock'} size={12} />
				{migration.state}
			</span>
		</div>
	</div>

	{#if migration.failureReason}
		<p class="mt-2 text-xs text-red-400/80 line-clamp-1">{migration.failureReason}</p>
	{/if}

	<div class="mt-2 flex items-center gap-3 text-xs text-gray-500">
		<span>{timeAgo(migration.startedAt)}</span>
		{#if migration.batchId}
			<!-- Use onclick to avoid nested <a> inside card link -->
			<span>· <button type="button" onclick={(e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); window.location.href = `/batches/${migration.batchId}`; }} class="inline-flex items-center gap-1 text-blue-400 hover:text-blue-300 underline cursor-pointer bg-transparent border-none p-0"><Octicon name="stack" size={12} />batch</button></span>
		{/if}
		{#if migration.warningsCount > 0}
			<span>· {migration.warningsCount} warnings</span>
		{/if}
		{#if migration.sourceApiUrl && !migration.sourceApiUrl.includes('api.github.com')}
			<span class="inline-flex items-center gap-1">· <Octicon name="server" size={12} /> GHES</span>
		{/if}
	</div>
</a>
