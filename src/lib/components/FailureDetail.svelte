<!-- Failure detail panel -->
<script lang="ts">
	import Octicon from '$lib/components/Octicon.svelte';
	import type { FailureDetail as FailureDetailType } from '$lib/types';

	let { detail }: { detail: FailureDetailType } = $props();

	const logEntries = $derived(detail.logEntries || []);
	const errors = $derived(logEntries.filter((e) => e.severity === 'ERROR'));
	const warnings = $derived(logEntries.filter((e) => e.severity === 'WARNING'));

	function formatElapsed(seconds: number): string {
		const m = Math.floor(seconds / 60);
		const s = Math.round(seconds % 60);
		return m > 0 ? `${m}m ${s}s` : `${s}s`;
	}
</script>

<div class="rounded-md border border-red-500/30 bg-red-500/5 p-5">
	<h3 class="flex items-center gap-2 text-sm font-semibold text-red-400">
		<Octicon name="x-circle" size={16} />
		Migration Failed
	</h3>

	{#if detail.failureReason}
		<p class="mt-2 text-sm text-red-300">{detail.failureReason}</p>
	{/if}

	<div class="mt-3 flex gap-4 text-xs text-gray-400">
		<span>Elapsed: {formatElapsed(detail.elapsed)}</span>
		{#if detail.logUrl}
		<a href={detail.logUrl} target="_blank" rel="noreferrer"
				class="inline-flex items-center gap-1 text-blue-400 hover:text-blue-300 hover:underline">
				<Octicon name="link-external" size={12} />
				Migration Log
			</a>
		{/if}
	</div>

	{#if errors.length > 0}
		<div class="mt-4">
			<h4 class="flex items-center gap-1 text-xs font-medium text-red-400/80"><Octicon name="alert" size={12} />Errors ({errors.length})</h4>
			<div class="mt-1 max-h-48 overflow-y-auto rounded border border-red-500/20 bg-gray-900">
				{#each errors as entry}
					<div class="border-b border-red-500/10 px-3 py-1.5 text-xs text-red-300 last:border-0">
						<span class="text-gray-500">[{entry.modelName}]</span> {entry.message}
					</div>
				{/each}
			</div>
		</div>
	{/if}

	{#if warnings.length > 0}
		<div class="mt-3">
			<h4 class="flex items-center gap-1 text-xs font-medium text-yellow-400/80"><Octicon name="alert" size={12} />Warnings ({warnings.length})</h4>
			<div class="mt-1 max-h-36 overflow-y-auto rounded border border-yellow-500/20 bg-gray-900">
				{#each warnings as entry}
					<div class="border-b border-yellow-500/10 px-3 py-1.5 text-xs text-yellow-300 last:border-0">
						<span class="text-gray-500">[{entry.modelName}]</span> {entry.message}
					</div>
				{/each}
			</div>
		</div>
	{/if}
</div>
