<script lang="ts">
	import Octicon from "$lib/components/Octicon.svelte";
	import type { ProfileDetailRollup, ProfileRun } from "$lib/profile/types";

	let {
		run,
		composition,
		livePhase,
	}: {
		run: ProfileRun;
		composition: ProfileDetailRollup["composition"];
		livePhase: string | null;
	} = $props();

	const percentage = $derived(
		run.totalRepos > 0 ? Math.round((run.profiledRepos / run.totalRepos) * 100) : 0,
	);
	const phaseLabels: Record<string, string> = {
		discovering: "Discovering repositories...",
		organization: "Scanning organization resources...",
		counting: "Counting issues, pull requests, and branches...",
		details: "Scanning LFS, workflows, and releases...",
		signals: "Checking commits, webhooks, and collaborators...",
	};
	const compositionTiles = $derived([
		{ label: "Active", value: composition.active, color: "text-green-400", icon: "pulse" },
		{ label: "Stale", value: composition.stale, color: "text-amber-400", icon: "history" },
		{ label: "Empty", value: composition.empty, color: "text-gray-300", icon: "circle-slash" },
		{ label: "Archived", value: composition.archived, color: "text-sky-400", icon: "archive" },
	] as const);
</script>

<section class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
	<div class="rounded-lg border border-gray-700 bg-gray-900 p-4">
		<div class="text-2xl font-semibold text-gray-50">
			{run.profiledRepos}<span class="text-base text-gray-500">/{run.totalRepos}</span>
		</div>
		<div class="mt-1 flex items-center gap-1.5 text-xs text-gray-400">
			<Octicon name="repo" size={12} class="text-gray-500" />Repositories profiled
		</div>
		{#if run.state === "running"}
			<div class="mt-2 h-1.5 overflow-hidden rounded-full bg-gray-800">
				<div class="h-full bg-green-500 transition-all" style:width={`${percentage}%`}></div>
			</div>
			{#if livePhase && phaseLabels[livePhase]}
				<div class="mt-1.5 flex items-center gap-1 text-xs text-gray-500">
					<Octicon name="sync" size={12} class="animate-spin" />{phaseLabels[livePhase]}
				</div>
			{/if}
		{/if}
	</div>
	{#each compositionTiles as tile (tile.label)}
		<div class="rounded-lg border border-gray-700 bg-gray-900 p-4">
			<div class="text-2xl font-semibold tabular-nums {tile.color}">{tile.value.pct}%</div>
			<div class="mt-1 flex items-center gap-1.5 text-xs text-gray-400">
				<Octicon name={tile.icon} size={12} class="text-gray-500" />
				{tile.label} <span class="text-gray-500">· {tile.value.count.toLocaleString()}</span>
			</div>
		</div>
	{/each}
</section>