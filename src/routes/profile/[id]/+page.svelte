<script lang="ts">
	import Octicon from "$lib/components/Octicon.svelte";
	import Pagination from "$lib/components/Pagination.svelte";
	import ProfileProgress from "$lib/components/profile/ProfileProgress.svelte";
	import SourceInventory from "$lib/components/profile/SourceInventory.svelte";
	import { getSourceProviderAdapter } from "$lib/source-provider";
	import Header from "./Header.svelte";
	import { LiveProfileController } from "./live.svelte";
	import Plan from "./Plan.svelte";
	import { ProfileMigrationPlannerController } from "./planner.svelte";
	import Readiness from "./Readiness.svelte";
	import RepoTable from "./RepoTable.svelte";

	let { data } = $props();

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
	const estimate = $derived(live.estimate);
	const provider = $derived(getSourceProviderAdapter(run.sourceProvider));
	const planner = new ProfileMigrationPlannerController({
		getRun: () => live.run,
		getRepos: () => live.repos,
		getPlanningRepos: () => live.planningRepos,
		getDefaultTargetOrg: () => "",
	});
</script>

<svelte:head><title>{run.org} - Source assessment</title></svelte:head>

<div class="space-y-6">
	<Header {run} {provider} />

	{#if provider.profileKind === "source-inventory"}
		<SourceInventory
			providerName={provider.displayName}
			running={run.state === "running"}
			progress={live.inventoryProgress}
			summary={inventorySummary}
		/>
		{#if run.state === "completed" && planningRepos.length > 0 && provider.capabilities.planning}
			<Plan {planner} canExport={provider.capabilities.export} />
		{/if}
	{:else}
		<ProfileProgress {run} {composition} livePhase={live.livePhase} />
		<Readiness {run} {scale} {summary} {estimate} />

		{#if run.state === "completed" && planningRepos.length > 0 && provider.capabilities.planning}
			<Plan {planner} canExport={provider.capabilities.export} />
		{/if}

		<section>
			<div class="mb-3 flex flex-wrap items-center justify-between gap-3">
				<h2 class="flex items-center gap-2 text-lg font-semibold text-gray-300">
					<Octicon name="repo" size={16} />Repositories
					{#if scale.repos > 0}<span class="text-sm font-normal text-gray-500">({repoPageInfo.total.toLocaleString()})</span>{/if}
				</h2>
				{#if scale.repos > 0}
					<div class="flex flex-wrap items-center gap-2">
						<select bind:value={readinessFilter} onchange={() => (repoPage = 1)} aria-label="Filter by readiness" class="rounded-md border border-gray-700 bg-gray-950 px-2.5 py-1.5 text-sm text-gray-200 focus:border-violet-500 focus:outline-none">
							<option value="all">All readiness</option><option value="ready">No blocking issues</option><option value="warnings">Warnings</option><option value="blockers">Blocking issues</option>
						</select>
						<div class="relative">
							<Octicon name="search" size={16} class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500" />
							<input type="search" bind:value={repoSearch} oninput={() => (repoPage = 1)} placeholder="Filter repositories..." aria-label="Filter repositories" class="w-64 rounded-md border border-gray-700 bg-gray-950 py-1.5 pr-3 pl-9 text-sm text-gray-100 placeholder:text-gray-500 focus:border-violet-500 focus:outline-none" />
						</div>
					</div>
				{/if}
			</div>

			{#if run.state === "completed" && repos.length > 0 && provider.capabilities.planning}
				<div class="mb-2 flex flex-wrap items-center gap-3 text-xs">
					<button type="button" onclick={() => planner.selectFiltered(false)} class="font-medium text-blue-400 hover:text-blue-300">Select shown without blocking issues</button>
					<button type="button" onclick={() => planner.selectFiltered(true)} class="font-medium text-blue-400 hover:text-blue-300">Select all shown</button>
					<button type="button" onclick={() => planner.clearSelection()} class="font-medium text-gray-400 hover:text-gray-200">Clear selection</button>
				</div>
			{/if}

			{#if scale.repos === 0 && planningRepos.length === 0}
				<div class="flex flex-col items-center justify-center rounded-md border border-dashed border-gray-600 py-12 text-gray-400">
					<Octicon name={run.state === "running" ? "sync" : "inbox"} size={24} class="h-10 w-10 text-gray-500 {run.state === 'running' ? 'animate-spin' : ''}" />
					<p class="mt-3">{run.state === "running" ? "Discovering and assessing repositories..." : "No repositories assessed"}</p>
				</div>
			{:else if repoPageInfo.total === 0}
				<div class="rounded-md border border-dashed border-gray-600 py-12 text-center text-gray-400">No repositories match the current filters.</div>
			{:else}
				<RepoTable runId={run.id} {repos} planning={run.state === "completed" && provider.capabilities.planning} {planner} />
				<Pagination page={repoPageInfo.page} totalPages={repoPageInfo.totalPages} total={repoPageInfo.total} limit={REPOS_PER_PAGE} onPageChange={(page) => (repoPage = page)} />
			{/if}
		</section>
	{/if}
</div>