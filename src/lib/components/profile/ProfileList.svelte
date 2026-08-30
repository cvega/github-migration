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
			className: "text-green-400",
			accent: "bg-green-500",
			dot: "bg-green-400",
			pulse: true,
		},
		completed: {
			label: "Completed",
			className: "text-green-400",
			accent: "bg-green-500",
			dot: "bg-green-400",
			pulse: false,
		},
		failed: {
			label: "Failed",
			className: "text-red-400",
			accent: "bg-red-500",
			dot: "bg-red-400",
			pulse: false,
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

<section>
	<div class="mb-3 flex items-center justify-between">
		<h2 class="flex items-center gap-2 text-lg font-semibold text-gray-300">
			<Octicon name="history" size={16} />
			Runs <span class="text-sm font-normal text-gray-500">({totalRuns})</span>
		</h2>
		<button
			type="button"
			onclick={() => invalidateAll()}
			class="inline-flex items-center gap-1.5 rounded-md border border-gray-700 bg-gray-800 px-3 py-1.5 text-sm text-gray-300 transition-colors hover:bg-gray-700 hover:text-gray-50"
		>
			<Octicon name="sync" size={16} />
			Refresh
		</button>
	</div>

	{#if runs.length === 0}
		<div class="flex flex-col items-center justify-center rounded-md border border-dashed border-gray-600 py-16">
			<Octicon name="telescope" size={24} class="h-12 w-12 text-gray-500" />
			<p class="mt-4 text-gray-400">No profile runs yet</p>
		</div>
	{:else}
		<div class="space-y-2">
			{#each runs as run (run.id)}
				{@const badge = stateBadge[run.state]}
				{@const provider = providerPresentation[run.sourceProvider]}
				{@const githubRun = getSourceProviderAdapter(run.sourceProvider).profileKind === "github-readiness"}
				<a
					href="/profile/{run.id}"
					class="group relative block overflow-hidden rounded-md border border-gray-700 bg-gray-900 transition-all hover:border-gray-600 hover:bg-gray-800"
				>
					<span class="absolute inset-y-0 left-0 w-1 {badge.accent}"></span>
					<div class="grid gap-4 p-4 pl-5 md:grid-cols-[minmax(15rem,1fr)_minmax(11rem,15rem)_minmax(10rem,auto)] md:items-center md:gap-5">
						<div class="flex min-w-0 items-center gap-3">
							<span class="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-gray-700 bg-gray-950/60 text-gray-300">
								<Octicon name={provider.icon} size={16} />
							</span>
							<span class="min-w-0">
								<span class="block text-xs font-semibold uppercase text-gray-500">{provider.label} source</span>
								<span class="mt-1 block truncate text-base font-semibold text-gray-50">{run.org}</span>
							</span>
						</div>

						<div class="border-t border-gray-700/70 pt-3 md:border-l md:border-t-0 md:pl-5 md:pt-0">
							<div class="text-xs font-semibold uppercase text-gray-500">{githubRun ? "Repository coverage" : "Project coverage"}</div>
							<div class="mt-1 text-sm font-medium tabular-nums text-gray-200">{runCountLabel(run)}</div>
							{#if run.blockers > 0 || run.warnings > 0}
								<div class="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
									{#if run.blockers > 0}<span class="rounded-md bg-red-500/10 px-2 py-1 text-red-400">{run.blockers} blocking {run.blockers === 1 ? "issue" : "issues"}</span>{/if}
									{#if run.warnings > 0}<span class="rounded-md bg-yellow-500/10 px-2 py-1 text-yellow-400">{run.warnings} warnings</span>{/if}
								</div>
							{/if}
						</div>

						<div class="flex items-center justify-between gap-4 border-t border-gray-700/70 pt-3 md:justify-end md:border-t-0 md:pt-0">
							<div class="md:text-right">
								<span class="inline-flex items-center gap-1.5 text-xs font-medium {badge.className}">
									<span class="relative flex h-2 w-2" aria-hidden="true">
										{#if badge.pulse}<span class="absolute inline-flex h-full w-full animate-ping rounded-full {badge.dot} opacity-40 motion-reduce:animate-none"></span>{/if}
										<span class="relative inline-flex h-2 w-2 rounded-full {badge.dot}"></span>
									</span>
									{badge.label}
								</span>
								<div class="mt-1.5 flex items-center gap-1 text-xs text-gray-500 md:justify-end">
									<Octicon name="clock" size={12} />Started {timeAgo(run.startedAt)}
								</div>
							</div>
							<span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-gray-700 text-gray-500 transition-colors group-hover:border-green-500/40 group-hover:text-green-400">
								<Octicon name="chevron-right" size={16} />
							</span>
						</div>
					</div>
				</a>
			{/each}
		</div>
	{/if}
</section>