<script lang="ts">
	import { SvelteSet } from "svelte/reactivity";
	import { enhance } from "$app/forms";
	import Octicon from "$lib/components/Octicon.svelte";
	import { formatRepoSize, timeAgo } from "$lib/format";
	import type { UsedIconName } from "$lib/icons.generated";
	import { MIGRATION_CATALOG } from "$lib/profile/migration-catalog";
	import type {
		RepositoryAnalysisDetail,
		RepositoryAnalysisJob,
		RepositoryAnalysisJobState,
	} from "$lib/profile/repository-analysis";
	import type { PageData } from "./$types";
	import type { ProfileMigrationPlannerController } from "./planner.svelte";

	let {
		runId,
		repos,
		analysis,
		planning,
		canExport,
		planningEligibleNames,
		planner,
	}: {
		runId: string;
		repos: PageData["repos"];
		analysis: RepositoryAnalysisDetail | null;
		planning: boolean;
		canExport: boolean;
		planningEligibleNames: string[];
		planner: ProfileMigrationPlannerController;
	} = $props();

	type RepoSignalsView = PageData["repos"][number]["signals"];
	const catalogMetadata = new Map(
		MIGRATION_CATALOG.map((entry) => [entry.id, entry.label]),
	);
	const toneClass: Record<string, string> = {
		opportunity: "text-green-400",
		caution: "text-amber-400",
		note: "text-gray-400",
	};
	const toneIcon = { opportunity: "rocket", caution: "alert", note: "info" } as const;
	const analysisByRepository = $derived(
		new Map(analysis?.jobs.map((job) => [job.nameWithOwner, job]) ?? []),
	);
	const planningEligible = $derived(new Set(planningEligibleNames));
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
		analysisJob: RepositoryAnalysisJob | undefined,
	): Array<{ label: string; value: string; icon: UsedIconName }> {
		const counts: Array<{ label: string; value: string; icon: UsedIconName }> = [
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
			{ label: "Webhooks", value: signals.webhooksCount?.toLocaleString() ?? "Unavailable", icon: "webhook" },
			{ label: "Collaborators", value: signals.collaboratorsCount?.toLocaleString() ?? "Unavailable", icon: "people" },
			{ label: "Pages", value: signals.hasPages ? "Yes" : "-", icon: "browser" },
			{ label: "Code scanning", value: signals.hasCodeScanningAlerts === null ? "Unavailable" : signals.hasCodeScanningAlerts ? "Yes" : "No", icon: "codescan" },
			{ label: "Size", value: formatRepoSize(signals.diskUsageKb), icon: "database" },
		];
		if (analysisJob?.result) {
			counts.push(
				{ label: "Git mirror", value: formatBytes(analysisJob.result.mirrorSizeBytes), icon: "git-branch" },
				{ label: "LFS objects", value: analysisJob.result.lfsPointerCount.toLocaleString(), icon: "file-binary" },
				{ label: "LFS referenced", value: formatBytes(analysisJob.result.lfsDeclaredBytes), icon: "database" },
			);
		} else if (analysisJob?.estimatedWorkspaceBytes !== null && analysisJob?.estimatedWorkspaceBytes !== undefined) {
			counts.push({
				label: "Analysis workspace",
				value: formatBytes(analysisJob.estimatedWorkspaceBytes),
				icon: "database",
			});
		}
		return counts;
	}

	function formatBytes(bytes: number): string {
		if (bytes <= 0) return "0 B";
		const units = ["B", "KiB", "MiB", "GiB", "TiB"];
		let value = bytes;
		let index = 0;
		while (value >= 1024 && index < units.length - 1) {
			value /= 1024;
			index += 1;
		}
		return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
	}

	function formatMetric(value: number, unit: string): string {
		if (unit === "B") return formatBytes(value);
		return `${value.toLocaleString()}${unit ? ` ${unit}` : ""}`;
	}

	function metricLabel(description: string): string {
		const label = description.replace(/^The /, "");
		return label.charAt(0).toUpperCase() + label.slice(1);
	}

	function metricStatus(levelOfConcern: number): {
		label: string;
		icon: UsedIconName;
		tone: string;
	} {
		if (levelOfConcern >= 30) return { label: "Critical", icon: "stop", tone: "text-red-300" };
		if (levelOfConcern >= 1) return { label: "Review", icon: "alert", tone: "text-yellow-300" };
		return { label: "Within range", icon: "check", tone: "text-gray-500" };
	}

	function analysisState(state: RepositoryAnalysisJobState): {
		label: string;
		icon: UsedIconName;
		tone: string;
	} {
		if (state === "succeeded") return { label: "Analyzed", icon: "check-circle", tone: "text-green-400" };
		if (state === "failed") return { label: "Failed", icon: "x-circle", tone: "text-red-400" };
		if (state === "running") return { label: "Analyzing", icon: "sync", tone: "text-blue-400" };
		if (state === "cancelled") return { label: "Cancelled", icon: "stop", tone: "text-gray-400" };
		return { label: "Queued", icon: "clock", tone: "text-gray-400" };
	}
</script>

<div class="overflow-hidden rounded-md border border-gray-700">
	{#if planning}
		<div class="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-gray-700 bg-gray-900 px-4 py-2.5 text-sm">
			<span class="font-medium text-gray-300">Select repositories</span>
			<span class="text-gray-500">{planner.selectedNames.length} selected</span>
			{#if planner.selectedWarnings > 0}
				<span class="inline-flex items-center gap-1 text-yellow-300"><Octicon name="alert" size={12} />{planner.selectedWarnings} {planner.selectedWarnings === 1 ? "warning" : "warnings"}</span>
			{/if}
			{#if planner.selectedBlockers > 0}
				<span class="inline-flex items-center gap-1 text-red-300"><Octicon name="stop" size={12} />{planner.selectedBlockers} {planner.selectedBlockers === 1 ? "blocker" : "blockers"}</span>
			{/if}
			<div class="flex flex-wrap items-center gap-x-3 gap-y-2 sm:ml-auto">
				<button type="button" onclick={() => planner.selectFiltered(false)} class="font-medium text-blue-400 hover:text-blue-300">Without blockers</button>
				<button type="button" onclick={() => planner.selectFiltered(true)} class="font-medium text-blue-400 hover:text-blue-300">All shown</button>
				<button type="button" onclick={() => planner.clearSelection()} class="font-medium text-gray-400 hover:text-gray-200">Clear</button>
				{#if canExport}
					<button type="button" onclick={() => planner.exportPlan()} disabled={planner.submitDisabled} class="inline-flex items-center gap-1.5 rounded-md border border-gray-600 px-2.5 py-1 text-xs font-medium text-gray-300 hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-40">
						<Octicon name="download" size={12} />Export
					</button>
				{/if}
			</div>
		</div>
	{/if}
	<div class="overflow-x-auto">
	<table class="w-full min-w-3xl text-sm">
		<thead class="bg-gray-900 text-left text-sm text-gray-400">
			<tr>
				{#if planning}<th class="w-10 px-3 py-2 font-medium"><span class="sr-only">Select</span></th>{/if}
				<th class="px-4 py-2 font-medium">Repository</th>
				<th class="px-4 py-2 font-medium">Target repository</th>
				<th class="px-4 py-2 font-medium">Git analysis</th>
				<th class="px-4 py-2 font-medium">Readiness</th>
			</tr>
		</thead>
		<tbody class="divide-y divide-gray-800">
			{#each repos as repo (repo.nameWithOwner)}
				{@const analysisJob = analysisByRepository.get(repo.nameWithOwner)}
				{@const canPlan = planningEligible.has(repo.nameWithOwner)}
				<tr class="bg-gray-950/40 align-top transition-colors hover:bg-gray-900/60">
					{#if planning}
						<td class="px-3 py-3">
							<input
								type="checkbox"
								checked={planner.selectedNames.includes(repo.nameWithOwner)}
								disabled={!canPlan}
								onchange={() => planner.toggleSelection(repo.nameWithOwner)}
								aria-label={canPlan ? `Select ${repo.nameWithOwner}` : `${repo.nameWithOwner} requires Git analysis before planning`}
								class="h-4 w-4 accent-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
							/>
						</td>
					{/if}
					<td class="px-4 py-3">
						<button type="button" onclick={() => toggleRepo(repo.nameWithOwner)} aria-expanded={expanded.has(repo.nameWithOwner)} title={repo.nameWithOwner} class="flex items-center gap-1.5 text-left font-medium text-gray-50 transition-colors hover:text-blue-400">
							<Octicon name={expanded.has(repo.nameWithOwner) ? "chevron-down" : "chevron-right"} size={12} class="shrink-0 text-gray-500" />
							{shortRepoName(repo.nameWithOwner)}
						</button>
					</td>
					<td class="px-4 py-2">
						{#if planning && !planner.assignment && planner.selectedNames.includes(repo.nameWithOwner)}
							<input type="text" value={planner.targetNameFor(repo.nameWithOwner)} oninput={(event) => planner.setTargetName(repo.nameWithOwner, event.currentTarget.value)} aria-label={`Target repository for ${repo.nameWithOwner}`} class="text-machine w-full min-w-32 rounded-md border border-gray-700 bg-gray-900 px-2 py-1 text-gray-100 focus:border-blue-500 focus:outline-none" />
						{:else}
							<span class="text-machine text-gray-500">{shortRepoName(repo.nameWithOwner)}</span>
						{/if}
					</td>
					<td class="px-4 py-3">
						{#if analysisJob}
							{@const state = analysisState(analysisJob.state)}
							<span class="inline-flex items-center gap-1.5 whitespace-nowrap text-sm font-medium {state.tone}">
								<Octicon name={state.icon} size={16} class={analysisJob.state === "running" ? "animate-spin" : ""} />{state.label}
							</span>
							{#if analysisJob.result}
								<p class="mt-0.5 whitespace-nowrap text-xs text-gray-500">{formatBytes(analysisJob.result.mirrorSizeBytes)} mirror</p>
							{/if}
						{:else if repo.signals.isEmpty}
							<span class="text-sm text-gray-500">Not required</span>
						{:else}
							<span class="text-sm text-gray-500">Not analyzed</span>
						{/if}
					</td>
					<td class="px-4 py-3">
						<div class="space-y-1.5">
							<div class="inline-flex items-center gap-1.5 text-sm font-medium {repo.blockers > 0 ? 'text-red-400' : repo.warnings > 0 ? 'text-yellow-400' : 'text-green-400'}">
								<Octicon name={repo.blockers > 0 ? "stop" : repo.warnings > 0 ? "alert" : "check-circle"} size={16} />
								{#if repo.blockers > 0}
									{repo.blockers} {repo.blockers === 1 ? "blocker" : "blockers"}
								{:else if repo.warnings > 0}
									{repo.warnings} {repo.warnings === 1 ? "warning" : "warnings"}
								{:else}
									Ready
								{/if}
							</div>
							{#if repo.catalogMatches.length > 0}
								{#each repo.catalogMatches as match (match.catalogEntryId)}
									<p class="text-sm text-gray-300" title={match.evidence}>{catalogMetadata.get(match.catalogEntryId) ?? match.catalogEntryId}</p>
								{/each}
							{/if}
							{#if repo.insights.length > 0}
								<div class="flex flex-wrap gap-x-3 gap-y-1">
								{#each repo.insights as insight (insight.id)}
									<span class="inline-flex items-center gap-1 whitespace-nowrap text-xs {toneClass[insight.tone]}" title={insight.detail}>
										<Octicon name={toneIcon[insight.tone]} size={12} />{insight.label}
									</span>
								{/each}
								</div>
							{/if}
							</div>
					</td>
				</tr>
				{#if expanded.has(repo.nameWithOwner)}
					<tr class="bg-gray-900/40">
						<td colspan={planning ? 5 : 4} class="px-4 py-4">
							<div class="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
								{#each repoCounts(repo.signals, analysisJob) as count (count.label)}
									<div class="flex items-center gap-2 rounded-md border border-gray-700/60 bg-gray-950/40 px-2.5 py-2">
										<Octicon name={count.icon} size={16} class="shrink-0 text-gray-500" />
										<div class="min-w-0"><div class="text-sm font-semibold tabular-nums text-gray-100">{count.value}</div><div class="truncate text-xs text-gray-400">{count.label}</div></div>
									</div>
								{/each}
							</div>
							{#if analysisJob?.failureReason}
								<div class="mt-3 border-t border-red-500/20 pt-3">
									<p class="flex min-w-0 items-start gap-1.5 text-xs text-red-300">
										<Octicon name="x-circle" size={12} class="mt-0.5 shrink-0" />{analysisJob.failureReason}
									</p>
								</div>
							{/if}
							{#if !planner.assignment && analysis && (analysisJob?.state === "failed" || analysisJob?.state === "cancelled")}
								<form method="POST" action="?/retryAnalysisJob" use:enhance class="mt-3">
									<input type="hidden" name="analysisRunId" value={analysis.run.id} />
									<input type="hidden" name="jobId" value={analysisJob.id} />
									<button type="submit" class="inline-flex items-center gap-1.5 rounded-md border border-gray-600 px-2.5 py-1.5 text-xs font-medium text-gray-300 hover:border-gray-400 hover:text-white">
										<Octicon name="sync" size={12} />Retry repository
									</button>
								</form>
							{/if}
							{#if analysisJob?.result?.gitSizerFindings.length}
								<div class="mt-3 border-t border-yellow-500/20 pt-3">
									<p class="mb-2 text-xs font-medium text-gray-300">Git repository concerns</p>
									<ul class="space-y-2">
										{#each analysisJob.result.gitSizerFindings as finding (finding.metric)}
											<li class="flex items-start gap-2 text-xs">
												<Octicon name={finding.severity === "critical" ? "stop" : "alert"} size={12} class="mt-0.5 shrink-0 {finding.severity === 'critical' ? 'text-red-400' : 'text-yellow-400'}" />
												<div class="min-w-0">
													<p class="text-gray-200">
														{finding.description}: <span class="font-semibold tabular-nums">{formatMetric(finding.value, finding.unit)}</span>
														<span class="ml-1.5 {finding.severity === 'critical' ? 'text-red-300' : 'text-yellow-300'}">{finding.severity === "critical" ? "Critical" : "Review recommended"}</span>
													</p>
													{#if finding.objectDescription}
														<p class="text-machine mt-0.5 break-all text-gray-500">{finding.objectDescription}</p>
													{/if}
												</div>
											</li>
										{/each}
									</ul>
								</div>
							{/if}
							{#if analysisJob?.result?.gitSizerMetrics.length}
								<details class="group mt-3 border-t border-gray-700 pt-3">
									<summary class="flex cursor-pointer list-none items-center justify-between gap-4 rounded px-1 py-1.5 text-xs text-gray-300 hover:bg-gray-800/50 hover:text-white [&::-webkit-details-marker]:hidden">
										<span class="flex items-center gap-2 font-medium">
											<Octicon name="graph" size={16} class="text-gray-500" />
											All Git measurements
											<span class="rounded-full bg-gray-800 px-2 py-0.5 font-normal tabular-nums text-gray-400">{analysisJob.result.gitSizerMetrics.length}</span>
										</span>
										<Octicon name="chevron-right" size={12} class="text-gray-500 transition-transform group-open:rotate-90" />
									</summary>
									<div class="mt-2 overflow-x-auto rounded-md border border-gray-700/70 bg-gray-950/30">
										<table class="w-full min-w-xl text-left text-xs">
											<thead class="bg-gray-900/70 uppercase text-gray-500">
												<tr>
													<th class="px-3 py-2 font-medium">Measurement</th>
													<th class="px-3 py-2 text-right font-medium">Value</th>
													<th class="px-3 py-2 font-medium">Status</th>
												</tr>
											</thead>
											<tbody class="divide-y divide-gray-800">
												{#each analysisJob.result.gitSizerMetrics as metric (metric.metric)}
													{@const status = metricStatus(metric.levelOfConcern)}
													<tr class="transition-colors hover:bg-gray-800/30 {metric.levelOfConcern >= 30 ? 'bg-red-500/5' : metric.levelOfConcern >= 1 ? 'bg-yellow-500/5' : ''}">
														<td class="px-3 py-2.5 text-gray-300">
															<p class="font-medium text-gray-200">{metricLabel(metric.description)}</p>
															<p class="text-machine mt-0.5 text-gray-600">{metric.metric}</p>
															{#if metric.objectDescription}<p class="text-machine mt-1 break-all text-blue-300/60">{metric.objectDescription}</p>{/if}
														</td>
														<td class="px-3 py-2.5 text-right text-sm font-semibold tabular-nums whitespace-nowrap text-gray-50">{formatMetric(metric.value, metric.unit)}</td>
														<td class="px-3 py-2.5 whitespace-nowrap">
															<span class="inline-flex items-center gap-1.5 font-medium {status.tone}"><Octicon name={status.icon} size={12} />{status.label}</span>
														</td>
													</tr>
												{/each}
											</tbody>
										</table>
									</div>
								</details>
							{/if}
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
</div>