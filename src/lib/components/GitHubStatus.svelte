<script lang="ts">
	import Octicon from "$lib/components/Octicon.svelte";
	import type { GitHubStatus } from "$lib/status";

	let { status }: { status: GitHubStatus } = $props();
	const label = $derived(
		status.ok
			? "All systems operational"
			: status.incidentCount === 1
				? "1 active incident"
				: `${status.incidentCount} active incidents`,
	);
</script>

{#if status.ok}
	<span
		class="inline-flex items-center gap-1.5 text-xs font-medium leading-4 text-gray-400"
		title={label}
	>
		<Octicon name="check-circle-fill" size={12} class="text-green-400" />
		GitHub operational
	</span>
{:else}
	<a
		href="https://www.githubstatus.com"
		target="_blank"
		rel="noopener noreferrer"
		class="inline-flex items-center gap-1.5 text-xs font-medium leading-4 text-yellow-400 hover:underline"
		title={status.incidents.map((incident) => `${incident.name} (${incident.status})`).join("\n")}
	>
		<Octicon name="alert" size={12} />
		{label}
	</a>
{/if}