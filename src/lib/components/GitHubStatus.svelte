<!-- GitHub platform status indicator pill -->
<script lang="ts">
	import type { GitHubStatus } from '$lib/types';
	import Octicon from '$lib/components/Octicon.svelte';

	let { status }: { status: GitHubStatus } = $props();

	const style = $derived(
		status.ok
			? 'bg-green-600/15 text-green-400 ring-1 ring-green-500/20'
			: 'bg-yellow-500/15 text-yellow-400 ring-1 ring-yellow-500/30'
	);

	const label = $derived(
		status.ok
			? 'All systems operational'
			: status.incidentCount === 1
				? '1 active incident'
				: `${status.incidentCount} active incidents`
	);

	const icon = $derived(status.ok ? 'check-circle' : 'alert');
</script>

{#if status.ok}
	<span class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium leading-4 {style}" title={label}>
		<span class="relative flex h-2 w-2">
			<span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75"></span>
			<span class="relative inline-flex h-2 w-2 rounded-full bg-green-400"></span>
		</span>
		GitHub: Healthy
	</span>
{:else}
	<a
		href="https://www.githubstatus.com"
		target="_blank"
		rel="noopener noreferrer"
		class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium leading-4 {style} hover:ring-yellow-400/50 transition-all"
		title={status.incidents.map(i => `${i.name} (${i.status})`).join('\n')}
	>
		<Octicon name={icon} size={12} />
		{label}
	</a>
{/if}
