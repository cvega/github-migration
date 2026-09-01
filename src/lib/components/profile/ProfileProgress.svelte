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

<section aria-labelledby="profile-summary-heading" class="space-y-3">
	<h2 id="profile-summary-heading" class="flex items-center gap-2 text-lg font-semibold text-gray-100">
		<Octicon name="pulse" size={16} class="text-gray-500" />Profile summary
	</h2>
	<div class="grid grid-cols-2 overflow-hidden rounded-md border border-gray-700 bg-gray-950/40 sm:grid-cols-5">
		<div class="col-span-2 p-4 sm:col-span-1">
			<div class="text-2xl font-semibold tabular-nums text-gray-50">
				{run.profiledRepos}<span class="text-base font-normal text-gray-500">/{run.totalRepos}</span>
			</div>
			<div class="mt-1 flex items-center gap-1.5 text-sm text-gray-400">
				<Octicon name="repo" size={12} class="text-gray-500" />Repos profiled
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
			<div class="border-t border-gray-700 p-4 sm:border-t-0 sm:border-l">
				<div class="text-2xl font-semibold tabular-nums {tile.color}">{tile.value.pct}%</div>
				<div class="mt-1 flex items-center gap-1.5 text-sm text-gray-400">
					<Octicon name={tile.icon} size={12} class="text-gray-500" />
					{tile.label} <span class="text-gray-500">· {tile.value.count.toLocaleString()}</span>
				</div>
			</div>
		{/each}
	</div>
</section>