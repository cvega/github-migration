<script lang="ts">
	import { invalidateAll } from "$app/navigation";
	import Octicon from "$lib/components/Octicon.svelte";
	import { timeAgo } from "$lib/format";
	import type { NumericObservation } from "$lib/source/types";
	import { getSourceProviderAdapter, type SourceProvider } from "$lib/source-provider";

	type RunState = "running" | "completed" | "failed";
	type ProfileRunListItem = {
		id: string;
		sourceProvider: SourceProvider;
		org: string;
		state: RunState;
		totalRepos: number;
		profiledRepos: number;
		blockers: number;
		warnings: number;
		startedAt: string;
		inventoryProjectCount: NumericObservation | null;
	};

	let { runs, totalRuns }: { runs: ProfileRunListItem[]; totalRuns: number } = $props();

	const stateBadge = {
		running: {
			label: "Running",
			className: "text-blue-400",
			icon: "sync",
		},
		completed: {
			label: "Completed",
			className: "text-green-400",
			icon: "check-circle-fill",
		},
		failed: {
			label: "Failed",
			className: "text-red-400",
			icon: "x-circle-fill",
		},
	} as const;

	const providerPresentation = {
		github: { label: "GitHub", icon: "mark-github" },
		gitlab: { label: "GitLab", icon: "gitlab-logo" },
		"bitbucket-server": { label: "Bitbucket Server", icon: "bitbucket-logo" },
	} as const;

	function runCountLabel(run: ProfileRunListItem): string {
		if (getSourceProviderAdapter(run.sourceProvider).profileKind === "github-readiness") {
			return `${run.profiledRepos}/${run.totalRepos} repos`;
		}
		const count = run.inventoryProjectCount;
		if (count?.kind === "unavailable") return "Profile unavailable";
		if (count?.kind === "at-least") return `At least ${count.value.toLocaleString()} projects`;
		if (count?.kind === "exact") return `${count.value.toLocaleString()} projects`;
		return run.state === "running" ? "Discovering projects" : "Profile failed";
	}
</script>

<section class="overflow-hidden rounded-md border border-gray-700 bg-gray-950/40">
	<div class="flex items-center justify-between gap-4 px-4 py-3">
		<h2 class="flex items-center gap-2 text-base font-semibold text-gray-100">
			<Octicon name="history" size={16} class="text-gray-500" />
			Profile runs
			<span class="rounded-full bg-gray-800 px-2 py-0.5 text-xs font-medium tabular-nums text-gray-400">{totalRuns}</span>
		</h2>
		<button
			type="button"
			onclick={() => invalidateAll()}
			class="inline-flex h-8 items-center gap-1.5 rounded-md border border-gray-600 px-3 text-xs font-medium text-gray-300 transition-colors hover:bg-gray-800 hover:text-gray-50"
		>
			<Octicon name="sync" size={12} />
			Refresh
		</button>
	</div>

	{#if runs.length === 0}
		<div class="flex flex-col items-center justify-center border-t border-gray-700 px-6 py-12 text-center">
			<Octicon name="telescope" size={24} class="text-gray-500" />
			<h3 class="mt-3 text-sm font-semibold text-gray-200">No profile runs yet</h3>
			<p class="mt-1 text-xs text-gray-500">Profiles you start will appear here.</p>
		</div>
	{:else}
		<div class="divide-y divide-gray-700 border-t border-gray-700">
			{#each runs as run (run.id)}
				{@const badge = stateBadge[run.state]}
				{@const provider = providerPresentation[run.sourceProvider]}
				{@const githubRun = getSourceProviderAdapter(run.sourceProvider).profileKind === "github-readiness"}
				<a
					href="/profile/{run.id}"
					class="group flex items-center gap-3 px-4 py-3.5 transition-colors hover:bg-gray-900/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-blue-500"
				>
					<span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-gray-700 bg-gray-950/60 text-gray-400">
						<Octicon name={provider.icon} size={16} />
					</span>
					<span class="min-w-0 flex-1">
						<span class="flex flex-wrap items-center gap-x-2 gap-y-1">
							<span class="truncate text-base font-semibold text-blue-400 group-hover:underline">{run.org}</span>
							<span class="inline-flex items-center gap-1 text-xs font-medium {badge.className}">
								<Octicon name={badge.icon} size={12} class={run.state === "running" ? "animate-spin" : ""} /><span class="sr-only sm:not-sr-only">{badge.label}</span>
							</span>
						</span>
						<span class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-gray-500 sm:text-sm">
							<span>{provider.label}</span>
							<span aria-hidden="true">·</span>
							<span class="font-medium tabular-nums text-gray-300">{runCountLabel(run)}</span>
							<span aria-hidden="true">·</span>
							<span class="inline-flex items-center gap-1"><Octicon name="clock" size={12} /><span class="hidden sm:inline">Started </span>{timeAgo(run.startedAt)}</span>
							{#if githubRun && run.blockers > 0}
								<span aria-hidden="true">·</span>
								<span class="inline-flex items-center gap-1 text-red-400"><Octicon name="stop" size={12} />{run.blockers} blocking {run.blockers === 1 ? "issue" : "issues"}</span>
							{/if}
							{#if githubRun && run.warnings > 0}
								<span aria-hidden="true">·</span>
								<span class="inline-flex items-center gap-1 text-yellow-400"><Octicon name="alert" size={12} />{run.warnings} {run.warnings === 1 ? "warning" : "warnings"}</span>
							{/if}
						</span>
					</span>
					<Octicon name="chevron-right" size={16} class="shrink-0 text-gray-500 transition-colors group-hover:text-gray-300" />
				</a>
			{/each}
		</div>
	{/if}
</section>