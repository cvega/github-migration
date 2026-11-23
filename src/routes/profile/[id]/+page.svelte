<script lang="ts">
	import Octicon from "$lib/components/Octicon.svelte";
	import Pagination from "$lib/components/Pagination.svelte";
	import ProfileProgress from "$lib/components/profile/ProfileProgress.svelte";
	import SourceInventory from "$lib/components/profile/SourceInventory.svelte";
	import { repositoryAnalysisAllowsPlanning } from "$lib/profile/repository-analysis";
	import { getSourceProviderAdapter } from "$lib/source-provider";
	import Header from "./Header.svelte";
	import { LiveProfileController } from "./live.svelte";
	import Plan from "./Plan.svelte";
	import { ProfileMigrationPlannerController } from "./planner.svelte";
	import Readiness from "./Readiness.svelte";
	import RepositoryAnalysis from "./RepositoryAnalysis.svelte";
	import RepoTable from "./RepoTable.svelte";

	let { data, form } = $props();

	const REPOS_PER_PAGE = 25;
	let repoSearch = $derived.by(() => {
		data.run.id;
		return "";
	});
	let repoPage = $derived.by(() => {
		data.run.id;
		return 1;
	});
	let readinessFilter = $derived.by(() => {
		data.run.id;
		return "all" as "all" | "ready" | "warnings" | "blockers";
	});

	function profileDetailQuery(view?: "repos"): string {
		const query = new URLSearchParams({
			page: String(repoPage),
			search: repoSearch.trim(),
			readiness: readinessFilter,
		});
		if (view) query.set("view", view);
		return query.toString();
	}

	const live = new LiveProfileController({
		getData: () => data,
		getDetailQuery: () => profileDetailQuery(),
		getRepositoryQuery: () => profileDetailQuery("repos"),
		getRepositoryPage: () => repoPage,
		getRepositorySearch: () => repoSearch,
		getReadinessFilter: () => readinessFilter,
		setRepositoryPage: (page) => (repoPage = page),
	});
	const run = $derived(live.run);
	const repos = $derived(live.repos);
	const repoPageInfo = $derived(live.repoPage);
	const planningRepos = $derived(live.planningRepos);
	const inventorySummary = $derived(live.inventorySummary);
	const scale = $derived(live.scale);
	const composition = $derived(live.composition);
	const summary = $derived(live.summary);
	const repositoryAnalysis = $derived(data.repositoryAnalysis);
	const provider = $derived(getSourceProviderAdapter(run.sourceProvider));
	const eligiblePlanningRepos = $derived(
		planningRepos.filter(
			(repo) =>
				run.sourceProvider !== "github" ||
				repositoryAnalysisAllowsPlanning(repo, repositoryAnalysis),
		),
	);
	const eligiblePlanningNames = $derived(
		eligiblePlanningRepos.map((repo) => repo.nameWithOwner),
	);
	const planner = new ProfileMigrationPlannerController({
		getRun: () => live.run,
		getRepos: () => live.repos,
		getPlanningRepos: () => eligiblePlanningRepos,
		getDefaultTargetOrg: () => "",
		getTargets: () => data.targetProfiles ?? [],
		isRepoEligible: (name) => eligiblePlanningNames.includes(name),
	});
</script>

<svelte:head><title>{run.org} - Source profile</title></svelte:head>

<div class="space-y-6">
	<Header {run} {provider} />

	{#if provider.profileKind === "source-inventory"}
		<SourceInventory
			profileId={run.id}
			bitbucket={run.sourceProvider === "bitbucket-server"}
			providerName={provider.displayName}
			running={run.state === "running"}
			progress={live.inventoryProgress}
			summary={inventorySummary}
		/>
		{#if run.state === "completed" && planningRepos.length > 0 && provider.capabilities.planning}
			<Plan {planner} canExport={provider.capabilities.export} />
		{/if}
	{:else if run.state !== "completed" || !scale || !summary || !composition}
		<p class="text-sm text-gray-400">
			{run.state === "failed" ? "Profile incomplete. Readiness and migration scale are unavailable." : "Collecting profile results…"}
		</p>
	{:else}
		<section aria-labelledby="migration-readiness-heading" class="space-y-4">
			<h2 id="migration-readiness-heading" class="flex items-center gap-2 text-lg font-semibold text-gray-100">
				<Octicon name="tasklist" size={16} class="text-gray-500" />Migration readiness
			</h2>
			<Readiness {run} {scale} {summary} />
		</section>

		<section class="space-y-3">
			<div class="flex flex-wrap items-center justify-between gap-3">
				<h2 class="flex items-center gap-2 text-lg font-semibold text-gray-100">
					<Octicon name="repo" size={16} class="text-gray-500" />Repositories
					{#if scale.repos > 0}<span class="text-sm font-normal text-gray-500">({repoPageInfo.total.toLocaleString()})</span>{/if}
				</h2>
				{#if scale.repos > 0}
					<div class="flex flex-wrap items-center gap-2">
						<select bind:value={readinessFilter} onchange={() => (repoPage = 1)} aria-label="Filter by readiness" class="rounded-md border border-gray-700 bg-gray-950 px-2.5 py-1.5 text-sm text-gray-200 focus:border-green-500 focus:outline-none">
							<option value="all">All readiness</option><option value="ready">No blocking issues</option><option value="warnings">Warnings</option><option value="blockers">Blocking issues</option>
						</select>
						<div class="relative">
							<Octicon name="search" size={16} class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500" />
							<input type="search" bind:value={repoSearch} oninput={() => (repoPage = 1)} placeholder="Filter repositories..." aria-label="Filter repositories" class="w-64 rounded-md border border-gray-700 bg-gray-950 py-1.5 pr-3 pl-9 text-sm text-gray-100 placeholder:text-gray-500 focus:border-green-500 focus:outline-none" />
						</div>
					</div>
				{/if}
			</div>
			<RepositoryAnalysis
				analysis={repositoryAnalysis}
				available={data.repositoryAnalysisAvailable}
				{form}
			/>
			{#if eligiblePlanningRepos.length > 0 && provider.capabilities.planning}
				<Plan {planner} canExport={provider.capabilities.export} embedded />
			{/if}

			{#if scale.repos === 0 && planningRepos.length === 0}
				<div class="flex flex-col items-center justify-center rounded-md border border-dashed border-gray-600 py-12 text-gray-400">
					<Octicon name="inbox" size={24} class="h-10 w-10 text-gray-500" />
					<p class="mt-3">No repositories profiled</p>
				</div>
			{:else if repoPageInfo.total === 0}
				<div class="rounded-md border border-dashed border-gray-600 py-12 text-center text-gray-400">No repositories match the current filters.</div>
			{:else}
				<RepoTable
					runId={run.id}
					{repos}
					analysis={repositoryAnalysis}
					planning={provider.capabilities.planning}
					canExport={provider.capabilities.export}
					planningEligibleNames={eligiblePlanningNames}
					{planner}
				/>
				<Pagination page={repoPageInfo.page} totalPages={repoPageInfo.totalPages} total={repoPageInfo.total} limit={REPOS_PER_PAGE} onPageChange={(page) => (repoPage = page)} />
			{/if}
		</section>

		<details class="group overflow-hidden rounded-md border border-gray-700 bg-gray-950/40">
			<summary class="flex cursor-pointer list-none items-center justify-between gap-4 px-4 py-3 text-gray-300 hover:bg-gray-900/60 hover:text-gray-100 [&::-webkit-details-marker]:hidden">
				<span class="flex items-center gap-2.5">
					<Octicon name="pulse" size={16} class="shrink-0 text-gray-500" />
					<span>
						<span class="block text-sm font-medium">Profile details</span>
						<span class="block text-xs text-gray-500">Repository composition and migration scale</span>
					</span>
				</span>
				<Octicon name="chevron-right" size={16} class="shrink-0 text-gray-500 transition-transform group-open:rotate-90" />
			</summary>
			<div class="space-y-4 border-t border-gray-700 p-4">
				<ProfileProgress {run} {composition} livePhase={live.livePhase} showHeading={false} />
				<Readiness {run} {scale} {summary} view="scale" />
			</div>
		</details>
	{/if}
</div>