<!-- Source vs Target stats comparison table -->
<script lang="ts">
	import type { Counts } from '$lib/types';
	import Octicon from '$lib/components/Octicon.svelte';
	import type { IconName } from '@primer/octicons';

	let { source, target }: { source: Counts | null; target: Counts | null } = $props();

	const rows: { label: string; icon: IconName; src: number; tgt: number }[] = $derived([
		{ label: 'Commits', icon: 'git-commit', src: source?.commits ?? 0, tgt: target?.commits ?? 0 },
		{ label: 'Branches', icon: 'git-branch', src: source?.branches ?? 0, tgt: target?.branches ?? 0 },
		{ label: 'Tags', icon: 'tag', src: source?.tags ?? 0, tgt: target?.tags ?? 0 },
		{ label: 'Issues', icon: 'issue-opened', src: source?.issues ?? 0, tgt: target?.issues ?? 0 },
		{ label: 'Pull Requests', icon: 'git-pull-request', src: source?.pullRequests ?? 0, tgt: target?.pullRequests ?? 0 },
		{ label: 'Releases', icon: 'package', src: source?.releases ?? 0, tgt: target?.releases ?? 0 }
	]);
</script>

<div class="rounded-md border border-gray-700 bg-gray-900 overflow-hidden">
	<table class="w-full text-sm">
		<thead>
			<tr class="border-b border-gray-700 text-gray-400">
				<th class="px-4 py-2.5 text-left font-medium">Resource</th>
				<th class="px-4 py-2.5 text-right font-medium">Source</th>
				<th class="px-4 py-2.5 text-right font-medium">Target</th>
				<th class="px-4 py-2.5 text-right font-medium">Match</th>
			</tr>
		</thead>
		<tbody>
			{#each rows as row}
				{@const match = row.src > 0 ? row.tgt >= row.src : row.tgt === 0}
				<tr class="border-b border-gray-800/50 last:border-0">
					<td class="px-4 py-2 text-gray-300"><span class="inline-flex items-center gap-2"><Octicon name={row.icon} size={16} class="text-gray-500" />{row.label}</span></td>
					<td class="px-4 py-2 text-right text-gray-400">{row.src.toLocaleString()}</td>
					<td class="px-4 py-2 text-right text-gray-50">{row.tgt.toLocaleString()}</td>
					<td class="px-4 py-2 text-right">
						{#if match}
							<span class="text-green-400"><Octicon name="check-circle" size={16} /></span>
						{:else}
							<span class="text-yellow-400">{row.src > 0 ? `${Math.floor((row.tgt / row.src) * 10000) / 100}%` : '—'}</span>
						{/if}
					</td>
				</tr>
			{/each}
		</tbody>
	</table>
</div>
