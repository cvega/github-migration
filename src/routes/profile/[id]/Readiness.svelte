<script lang="ts">
	import Octicon from "$lib/components/Octicon.svelte";
	import { formatRepoSize } from "$lib/format";
	import type { UsedIconName } from "$lib/icons.generated";
	import type { ProfileDetailRollup, ProfileRun } from "$lib/profile/types";

	let {
		run,
		scale,
		summary,
		view = "readiness",
	}: {
		run: ProfileRun;
		scale: ProfileDetailRollup["scale"];
		summary: ProfileDetailRollup["summary"];
		view?: "readiness" | "scale";
	} = $props();
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
		[
			{ label: "Rulesets", value: run.orgRulesetCount, icon: "law", warn: (run.orgRulesetCount ?? 0) > 0 },
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
			value: number | null;
			icon: UsedIconName;
			warn?: boolean;
		}>,
	);
</script>

{#if view === "scale"}
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
{/if}

{#if view === "readiness"}
	<div class="space-y-3">
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

		{#if run.sourceProvider === "github"}
			<div class="space-y-2">
				<h3 class="text-sm font-medium text-gray-300">Organization resources to recreate</h3>
				<div class="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-gray-700 bg-gray-700 sm:grid-cols-3 lg:grid-cols-5">
					{#each orgResourceTiles as tile (tile.label)}
						<div class="flex items-center gap-2 px-3 py-2.5 {tile.warn ? 'bg-yellow-500/10' : 'bg-gray-950'}">
							<Octicon name={tile.icon} size={16} class="shrink-0 {tile.warn ? 'text-yellow-400' : 'text-gray-500'}" />
							<div class="min-w-0">
								<div class="text-sm font-semibold tabular-nums {tile.warn ? 'text-yellow-200' : 'text-gray-100'}">{tile.value?.toLocaleString() ?? "Unavailable"}</div>
								<div class="text-sm text-gray-400">{tile.label}</div>
							</div>
						</div>
					{/each}
				</div>
				<p class="text-sm text-gray-500">These resources are organization-scoped and must be recreated on the target. Secret values are never exported.</p>
			</div>
		{/if}
	</div>
{/if}