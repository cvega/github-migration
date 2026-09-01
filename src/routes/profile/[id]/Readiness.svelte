<script lang="ts">
	import Octicon from "$lib/components/Octicon.svelte";
	import { formatHours, formatRepoSize } from "$lib/format";
	import type { UsedIconName } from "$lib/icons.generated";
	import type { ProfileDetailRollup, ProfileRun } from "$lib/profile/types";

	let {
		run,
		scale,
		summary,
		estimate,
	}: {
		run: ProfileRun;
		scale: ProfileDetailRollup["scale"];
		summary: ProfileDetailRollup["summary"];
		estimate: ProfileDetailRollup["estimate"];
	} = $props();

	let parallelism = $derived.by(() => {
		run.id;
		return estimate.defaultParallelism || 10;
	});
	const wallLow = $derived(
		parallelism > 0 ? estimate.totalRepoHoursLow / parallelism : estimate.totalRepoHoursLow,
	);
	const wallHigh = $derived(
		parallelism > 0 ? estimate.totalRepoHoursHigh / parallelism : estimate.totalRepoHoursHigh,
	);
	const scaleTiles = $derived(
		[
			{ label: "Issues", value: scale.issues.toLocaleString(), icon: "issue-opened" },
			{ label: "Pull requests", value: scale.pullRequests.toLocaleString(), icon: "git-pull-request" },
			{ label: "Commits", value: scale.commits.toLocaleString(), icon: "git-commit" },
			{ label: "Branches", value: scale.branches.toLocaleString(), icon: "git-branch" },
			{ label: "Tags", value: scale.tags.toLocaleString(), icon: "tag" },
			{ label: "Releases", value: scale.releases.toLocaleString(), icon: "rocket" },
			{ label: "Total size", value: formatRepoSize(scale.diskUsageKb), icon: "database" },
		] satisfies Array<{ label: string; value: string; icon: UsedIconName }>,
	);
	const orgResourceTiles = $derived(
		(
			[
				{ label: "Rulesets", value: run.orgRulesetCount, icon: "law", warn: true },
				{ label: "Actions secrets", value: run.orgResources.actionsSecrets, icon: "key" },
				{ label: "Actions variables", value: run.orgResources.actionsVariables, icon: "note" },
				{ label: "Dependabot secrets", value: run.orgResources.dependabotSecrets, icon: "dependabot" },
				{ label: "Codespaces secrets", value: run.orgResources.codespacesSecrets, icon: "codespaces" },
				{ label: "Self-hosted runners", value: run.orgResources.selfHostedRunners, icon: "server" },
				{ label: "Custom properties", value: run.orgResources.customProperties, icon: "list-unordered" },
				{ label: "Teams", value: run.orgResources.teams, icon: "people" },
				{ label: "GitHub Apps", value: run.orgResources.appInstallations, icon: "apps" },
			] satisfies Array<{
				label: string;
				value: number;
				icon: UsedIconName;
				warn?: boolean;
			}>
		).filter((tile) => tile.value > 0),
	);
</script>

<div class="space-y-3">
	<h3 class="flex items-center gap-2 text-sm font-medium text-gray-300">
		<Octicon name="graph" size={16} class="text-gray-500" />Migration scale
	</h3>
	<div class="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-gray-700 bg-gray-700 sm:grid-cols-4 lg:grid-cols-7">
		{#each scaleTiles as tile, index (tile.label)}
			<div class="bg-gray-950 px-3 py-3 {index === scaleTiles.length - 1 ? 'col-span-2 lg:col-span-1' : ''}">
				<div class="flex items-center justify-between gap-2">
					<span class="text-xl font-semibold tabular-nums text-gray-50">{tile.value}</span>
					<Octicon name={tile.icon} size={16} class="shrink-0 text-gray-500" />
				</div>
				<div class="mt-1 whitespace-nowrap text-sm text-gray-400">{tile.label}</div>
			</div>
		{/each}
	</div>
</div>

{#if scale.repos > 0}
	<div class="space-y-3">
		<h3 class="flex items-center gap-2 text-base font-semibold text-gray-200">
			<Octicon name="tasklist" size={16} class="text-gray-500" />Migration readiness
		</h3>

		{#if orgResourceTiles.length > 0}
			<div class="space-y-2">
				<h3 class="text-sm font-medium text-gray-300">Organization resources to recreate</h3>
				<div class="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-gray-700 bg-gray-700 sm:grid-cols-3 lg:grid-cols-5">
					{#each orgResourceTiles as tile (tile.label)}
						<div class="flex items-center gap-2 px-3 py-2.5 {tile.warn ? 'bg-yellow-500/10' : 'bg-gray-950'}">
							<Octicon name={tile.icon} size={16} class="shrink-0 {tile.warn ? 'text-yellow-400' : 'text-gray-500'}" />
							<div class="min-w-0">
								<div class="text-sm font-semibold tabular-nums {tile.warn ? 'text-yellow-200' : 'text-gray-100'}">{tile.value.toLocaleString()}</div>
								<div class="truncate text-sm text-gray-400">{tile.label}</div>
							</div>
						</div>
					{/each}
				</div>
				<p class="text-sm text-gray-500">These resources are organization-scoped and must be recreated on the target. Secret values are never exported.</p>
			</div>
		{/if}

		<div class="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-gray-700 bg-gray-700 sm:grid-cols-4">
			<div class="bg-gray-950 px-4 py-3">
				<div class="flex items-center gap-2 text-2xl font-semibold text-gray-50"><Octicon name="stop" size={16} class="text-red-400" />{summary.blockerRepos}</div>
				<div class="mt-1 text-sm text-gray-400">Repos with blocking issues</div>
			</div>
			<div class="bg-gray-950 px-4 py-3">
				<div class="flex items-center gap-2 text-2xl font-semibold text-gray-50"><Octicon name="alert" size={16} class="text-yellow-400" />{summary.warnRepos}</div>
				<div class="mt-1 text-sm text-gray-400">Repos with warnings</div>
			</div>
			<div class="bg-gray-950 px-4 py-3">
				<div class="flex items-center gap-2 text-2xl font-semibold text-gray-50"><Octicon name="check-circle" size={16} class="text-green-400" />{summary.cleanRepos}</div>
				<div class="mt-1 text-sm text-gray-400">Ready repositories</div>
			</div>
			<div class="bg-gray-950 px-4 py-3">
				<div class="flex items-center gap-2 text-2xl font-semibold text-gray-50"><Octicon name="tools" size={16} class="text-gray-500" />{summary.items.length}</div>
				<div class="mt-1 text-sm text-gray-400">Preparation items</div>
			</div>
		</div>

		<div class="flex flex-wrap items-start justify-between gap-4 rounded-md border border-gray-700 bg-gray-950/40 p-4">
			<div>
				<div class="flex items-center gap-2 text-base font-medium text-gray-300"><Octicon name="clock" size={16} class="text-gray-500" />Estimated migration time</div>
				<div class="mt-1 text-3xl font-semibold tabular-nums text-gray-50">{formatHours(wallLow)} - {formatHours(wallHigh)}</div>
				<div class="mt-1 text-sm text-gray-500">at {parallelism} concurrent migrations · {formatHours(estimate.totalRepoHoursLow)} - {formatHours(estimate.totalRepoHoursHigh)} total work</div>
			</div>
			<label class="flex flex-col gap-1 text-sm text-gray-400">
				Parallel migrations
				<input type="number" min="1" max="100" bind:value={parallelism} class="w-24 rounded-md border border-gray-700 bg-gray-950 px-2 py-1 text-sm tabular-nums text-gray-100 focus:border-green-500 focus:outline-none" />
			</label>
		</div>

		{#if summary.items.length > 0}
			<div class="overflow-hidden rounded-md border border-gray-700">
				<div class="border-b border-gray-700 bg-gray-900 px-4 py-3">
					<h3 class="text-base font-semibold text-gray-100">Preparation required</h3>
					<p class="mt-0.5 text-sm text-gray-400">Review these findings before launching the migration.</p>
				</div>
				<div class="overflow-x-auto">
				<table class="w-full min-w-xl text-sm">
					<thead class="bg-gray-950 text-left text-sm text-gray-400">
						<tr><th class="px-4 py-2 font-medium">Finding</th><th class="px-4 py-2 font-medium">Recommended action</th><th class="px-4 py-2 text-right font-medium">Affected repositories</th></tr>
					</thead>
					<tbody class="divide-y divide-gray-800">
						{#each summary.items as item (item.catalogEntryId)}
							<tr class="bg-gray-950/40">
								<td class="px-4 py-2.5 font-medium text-gray-100">{item.label}</td>
								<td class="px-4 py-2.5 text-gray-400">{item.routesTo ?? "Review and accept"}</td>
								<td class="px-4 py-2.5 text-right font-semibold tabular-nums whitespace-nowrap text-gray-200">{item.affectedRepos.toLocaleString()} {item.affectedRepos === 1 ? "repository" : "repositories"}</td>
							</tr>
						{/each}
					</tbody>
				</table>
				</div>
			</div>
		{/if}
	</div>
{/if}