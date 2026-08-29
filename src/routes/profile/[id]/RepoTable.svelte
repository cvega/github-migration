<script lang="ts">
	import { SvelteSet } from "svelte/reactivity";
	import Octicon from "$lib/components/Octicon.svelte";
	import { formatRepoSize, timeAgo } from "$lib/format";
	import type { UsedIconName } from "$lib/icons.generated";
	import { MIGRATION_CATALOG } from "$lib/profile/migration-catalog";
	import type { PageData } from "./$types";
	import type { ProfileMigrationPlannerController } from "./planner.svelte";

	let {
		runId,
		repos,
		planning,
		planner,
	}: {
		runId: string;
		repos: PageData["repos"];
		planning: boolean;
		planner: ProfileMigrationPlannerController;
	} = $props();

	type RepoSignalsView = PageData["repos"][number]["signals"];
	const catalogMetadata = new Map(
		MIGRATION_CATALOG.map((entry) => [
			entry.id,
			{ label: entry.label, severity: entry.severity },
		]),
	);
	const severityClass: Record<string, string> = {
		blocker: "border-red-500/30 bg-red-500/15 text-red-300",
		warn: "border-yellow-500/30 bg-yellow-500/15 text-yellow-300",
		info: "border-gray-600 bg-gray-700/50 text-gray-300",
	};
	const toneClass: Record<string, string> = {
		opportunity: "border-green-500/30 bg-green-500/15 text-green-300",
		caution: "border-amber-500/30 bg-amber-500/15 text-amber-300",
		note: "border-gray-600 bg-gray-700/50 text-gray-300",
	};
	const toneIcon = { opportunity: "rocket", caution: "alert", note: "info" } as const;
	let expanded = $derived.by(() => {
		runId;
		return new SvelteSet<string>();
	});

	function toggleRepo(name: string): void {
		if (expanded.has(name)) expanded.delete(name);
		else expanded.add(name);
	}

	function shortRepoName(nameWithOwner: string): string {
		const slash = nameWithOwner.indexOf("/");
		return slash >= 0 ? nameWithOwner.slice(slash + 1) : nameWithOwner;
	}

	function repoCounts(
		signals: RepoSignalsView,
	): Array<{ label: string; value: string; icon: UsedIconName }> {
		return [
			{ label: "Issues", value: signals.issuesCount.toLocaleString(), icon: "issue-opened" },
			{ label: "Pull requests", value: signals.pullRequestsCount.toLocaleString(), icon: "git-pull-request" },
			{ label: "Commits", value: signals.commitsCount.toLocaleString(), icon: "git-commit" },
			{ label: "Branches", value: signals.branchesCount.toLocaleString(), icon: "git-branch" },
			{ label: "Tags", value: signals.tagsCount.toLocaleString(), icon: "tag" },
			{ label: "Releases", value: signals.releasesCount.toLocaleString(), icon: "rocket" },
			{ label: "Discussions", value: signals.discussionsCount.toLocaleString(), icon: "comment-discussion" },
			{ label: "Projects", value: signals.projectsV2Count.toLocaleString(), icon: "project" },
			{ label: "Environments", value: signals.environmentsCount.toLocaleString(), icon: "server" },
			{ label: "Stars", value: signals.stargazerCount.toLocaleString(), icon: "star" },
			{ label: "Watchers", value: signals.watcherCount.toLocaleString(), icon: "eye" },
			{ label: "Forks", value: signals.forkCount.toLocaleString(), icon: "repo-forked" },
			{ label: "Protection rules", value: signals.branchProtectionRuleCount.toLocaleString(), icon: "shield" },
			{ label: "Rulesets", value: signals.rulesetCount.toLocaleString(), icon: "law" },
			{ label: "Webhooks", value: signals.webhooksCount.toLocaleString(), icon: "webhook" },
			{ label: "Collaborators", value: signals.collaboratorsCount.toLocaleString(), icon: "people" },
			{ label: "Pages", value: signals.hasPages ? "Yes" : "-", icon: "browser" },
			{ label: "Code scanning", value: signals.hasCodeScanningAlerts ? "Yes" : "-", icon: "codescan" },
			{ label: "Size", value: formatRepoSize(signals.diskUsageKb), icon: "database" },
		];
	}
</script>

<div class="overflow-x-auto rounded-lg border border-gray-700">
	<table class="w-full min-w-4xl text-sm">
		<thead class="bg-gray-900 text-left text-xs uppercase tracking-wide text-gray-500">
			<tr>
				{#if planning}<th class="w-10 px-3 py-2 font-medium"><span class="sr-only">Select</span></th>{/if}
				<th class="px-4 py-2 font-medium">Repository</th>
				<th class="px-4 py-2 font-medium">Target repository</th>
				<th class="px-4 py-2 text-center font-medium">Severity</th>
				<th class="px-4 py-2 font-medium">Migration findings</th>
				<th class="px-4 py-2 font-medium">Insights</th>
			</tr>
		</thead>
		<tbody class="divide-y divide-gray-800">
			{#each repos as repo (repo.nameWithOwner)}
				<tr class="bg-gray-950/40 align-top transition-colors hover:bg-gray-900/60">
					{#if planning}
						<td class="px-3 py-3">
							<input type="checkbox" checked={planner.selectedNames.includes(repo.nameWithOwner)} onchange={() => planner.toggleSelection(repo.nameWithOwner)} aria-label={`Select ${repo.nameWithOwner}`} class="h-4 w-4 accent-blue-500" />
						</td>
					{/if}
					<td class="px-4 py-3">
						<button type="button" onclick={() => toggleRepo(repo.nameWithOwner)} aria-expanded={expanded.has(repo.nameWithOwner)} title={repo.nameWithOwner} class="flex items-center gap-1.5 text-left font-medium text-gray-50 transition-colors hover:text-green-300">
							<Octicon name={expanded.has(repo.nameWithOwner) ? "chevron-down" : "chevron-right"} size={12} class="shrink-0 text-gray-500" />
							{shortRepoName(repo.nameWithOwner)}
						</button>
					</td>
					<td class="px-4 py-2">
						{#if planning && planner.selectedNames.includes(repo.nameWithOwner)}
							<input type="text" value={planner.targetNameFor(repo.nameWithOwner)} oninput={(event) => planner.setTargetName(repo.nameWithOwner, event.currentTarget.value)} aria-label={`Target repository for ${repo.nameWithOwner}`} class="w-full min-w-32 rounded-md border border-gray-700 bg-gray-900 px-2 py-1 font-mono text-xs text-gray-100 focus:border-blue-500 focus:outline-none" />
						{:else}
							<span class="font-mono text-xs text-gray-600">{shortRepoName(repo.nameWithOwner)}</span>
						{/if}
					</td>
					<td class="px-4 py-3 text-center">
						<span class="inline-flex items-center gap-2 text-xs">
							{#if repo.blockers > 0}<span class="text-red-400">{repo.blockers} blocking</span>{/if}
							{#if repo.warnings > 0}<span class="text-yellow-400">{repo.warnings} warning</span>{/if}
							{#if repo.infos > 0}<span class="text-gray-400">{repo.infos} info</span>{/if}
							{#if repo.blockers + repo.warnings + repo.infos === 0}<span class="text-green-400">clear</span>{/if}
						</span>
					</td>
					<td class="px-4 py-3">
						{#if repo.catalogMatches.length === 0}
							<span class="text-gray-600">-</span>
						{:else}
							<div class="flex flex-wrap gap-1.5">
								{#each repo.catalogMatches as match (match.catalogEntryId)}
									{@const meta = catalogMetadata.get(match.catalogEntryId)}
									<span class="inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-xs {severityClass[meta?.severity ?? 'info']}" title={match.evidence}>{meta?.label ?? match.catalogEntryId}</span>
								{/each}
							</div>
						{/if}
					</td>
					<td class="px-4 py-3">
						{#if repo.insights.length === 0}
							<span class="text-gray-600">-</span>
						{:else}
							<div class="flex flex-wrap gap-1.5">
								{#each repo.insights as insight (insight.id)}
									<span class="inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs {toneClass[insight.tone]}" title={insight.detail}>
										<Octicon name={toneIcon[insight.tone]} size={12} />{insight.label}
									</span>
								{/each}
							</div>
						{/if}
					</td>
				</tr>
				{#if expanded.has(repo.nameWithOwner)}
					<tr class="bg-gray-900/40">
						<td colspan={planning ? 6 : 5} class="px-4 py-4">
							<div class="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
								{#each repoCounts(repo.signals) as count (count.label)}
									<div class="flex items-center gap-2 rounded-md border border-gray-700/60 bg-gray-950/40 px-2.5 py-2">
										<Octicon name={count.icon} size={16} class="shrink-0 text-gray-500" />
										<div class="min-w-0"><div class="text-sm font-semibold tabular-nums text-gray-100">{count.value}</div><div class="truncate text-[11px] text-gray-400">{count.label}</div></div>
									</div>
								{/each}
							</div>
							<div class="mt-3 flex flex-wrap items-center gap-3 text-xs text-gray-500">
								<span class="lowercase">{repo.signals.visibility}</span>
								{#if repo.signals.defaultBranch}<span>default <span class="text-gray-400">{repo.signals.defaultBranch}</span></span>{/if}
								{#if repo.signals.pushedAt}<span>pushed {timeAgo(repo.signals.pushedAt)}</span>{/if}
								{#if repo.signals.isArchived}<span class="text-amber-400">archived</span>{/if}
								{#if repo.signals.isFork}<span>fork</span>{/if}
								{#if repo.signals.isEmpty}<span>empty</span>{/if}
							</div>
						</td>
					</tr>
				{/if}
			{/each}
		</tbody>
	</table>
</div>