<script lang="ts">
	import Octicon from "$lib/components/Octicon.svelte";
	import type { ProfileMigrationPlannerController } from "./planner.svelte";

	let {
		planner,
		canExport,
		embedded = false,
	}: { planner: ProfileMigrationPlannerController; canExport: boolean; embedded?: boolean } = $props();
</script>

<section class="rounded-md border border-gray-700 bg-gray-950/40 p-4">
	<div class="grid gap-4 lg:grid-cols-[minmax(14rem,1fr)_auto] lg:items-end">
		<div class="self-start">
			{#if embedded}
				<h3 class="flex items-center gap-2 text-base font-semibold text-gray-100">
					<Octicon name="tasklist" size={16} class="text-gray-500" />Build migration plan
				</h3>
			{:else}
				<h2 class="flex items-center gap-2 text-base font-semibold text-gray-100">
					<Octicon name="tasklist" size={16} class="text-gray-500" />Build migration plan
				</h2>
			{/if}
			<p class="mt-1 ml-6 text-sm text-gray-400">Choose repositories and target names, then launch them as one batch.</p>
		</div>
		<div class="flex flex-wrap items-end gap-2 lg:justify-end">
			<label class="block w-full text-sm font-medium text-gray-400 sm:w-64">
				Destination
				<select required value={planner.targetProfileId} onchange={(event) => planner.setTargetProfileId(event.currentTarget.value)} class="mt-1 block h-9 w-full rounded-md border border-gray-700 bg-gray-950 px-2 text-sm text-gray-100">
					<option value="" disabled>Choose destination</option>
					{#each planner.targets as target (target.id)}
						<option value={target.id}>{target.platform.toUpperCase()} · {target.webUrl}</option>
					{/each}
				</select>
			</label>
			<label class="block w-full text-sm font-medium text-gray-400 sm:w-64">
				Target organization
				<span class="mt-1 flex h-9 items-center gap-2 rounded-md border border-gray-700 bg-gray-950 px-3">
					<Octicon name="organization" size={16} class="shrink-0 text-blue-400" />
					<input type="text" required value={planner.targetOrg} oninput={(event) => planner.setTargetOrg(event.currentTarget.value)} placeholder="target-org" class="min-w-0 flex-1 bg-transparent font-mono text-sm text-gray-100 focus:outline-none" />
				</span>
			</label>
			{#if !embedded}
				<span class="inline-flex h-9 items-center text-sm font-medium text-gray-400">{planner.selectedNames.length} selected</span>
				{#if planner.selectedWarnings > 0}
					<span class="inline-flex h-9 items-center gap-1 text-sm text-yellow-300"><Octicon name="alert" size={12} />{planner.selectedWarnings} {planner.selectedWarnings === 1 ? "warning" : "warnings"}</span>
				{/if}
				{#if planner.selectedBlockers > 0}
					<span class="inline-flex h-9 items-center gap-1 text-sm text-red-300"><Octicon name="stop" size={12} />{planner.selectedBlockers} {planner.selectedBlockers === 1 ? "blocker" : "blockers"}</span>
				{/if}
				{#if canExport}
					<button type="button" onclick={() => planner.exportPlan()} disabled={planner.submitDisabled} class="inline-flex items-center gap-1.5 rounded-md border border-gray-600 px-3 py-2 text-sm font-medium text-gray-200 hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-40">
						<Octicon name="download" size={16} />Export
					</button>
				{/if}
			{/if}
			<button type="button" onclick={() => planner.launchBatch()} disabled={planner.launchingBatch || planner.submitDisabled} class="inline-flex items-center gap-1.5 rounded-md bg-green-600 px-3 py-2 text-sm font-semibold text-white hover:bg-green-500 disabled:cursor-not-allowed disabled:opacity-40">
				<Octicon name={planner.launchingBatch ? "sync" : "rocket"} size={16} class={planner.launchingBatch ? "animate-spin" : ""} />
				{planner.launchingBatch ? "Launching..." : "Launch batch"}
			</button>
		</div>
	</div>

	{#if planner.repos.length === 0}
		<div class="mt-4 overflow-hidden rounded-md border border-gray-700">
			<div class="flex items-center justify-between gap-3 border-b border-gray-700 bg-gray-950/60 px-3 py-2 text-xs">
				<span class="text-gray-400">Discovered projects</span>
				<div class="flex items-center gap-3">
					<button type="button" onclick={() => planner.selectInventoryProjects()} class="font-medium text-blue-400 hover:text-blue-300">Select all</button>
					<button type="button" onclick={() => planner.clearSelection()} class="font-medium text-gray-400 hover:text-gray-200">Clear</button>
				</div>
			</div>
			<div class="max-h-80 divide-y divide-gray-800 overflow-y-auto">
				{#each planner.planningRepos as repo (repo.nameWithOwner)}
					<div class="grid min-h-12 grid-cols-[1.5rem_minmax(12rem,1fr)_minmax(10rem,16rem)] items-center gap-3 px-3 py-2">
						<input type="checkbox" checked={planner.selectedNames.includes(repo.nameWithOwner)} onchange={() => planner.toggleSelection(repo.nameWithOwner)} aria-label={`Select ${repo.nameWithOwner}`} class="h-4 w-4 accent-blue-500" />
						<div class="min-w-0 break-all">
							<span class="text-machine text-gray-300">{repo.nameWithOwner}</span>
							{#if repo.providerDetails?.provider === "bitbucket-server"}
								{@const details = repo.providerDetails}
								{#if details.forkedFromPath}<div class="mt-1 flex items-center gap-1 text-xs text-gray-400"><Octicon name="repo-forked" size={12} />Forked from {details.forkedFromPath}</div>{/if}
								<div class="mt-1 text-xs text-gray-400">{details.rootLfsRules === "found" ? "LFS tracking rule found" : details.rootLfsRules === "none" ? "No root LFS rule found" : "LFS rules not verified"}</div>
							{/if}
						</div>
						<input type="text" value={planner.targetNameFor(repo.nameWithOwner)} disabled={!planner.selectedNames.includes(repo.nameWithOwner)} oninput={(event) => planner.setTargetName(repo.nameWithOwner, event.currentTarget.value)} aria-label={`Target repository for ${repo.nameWithOwner}`} class="text-machine min-w-0 rounded-md border border-gray-700 bg-gray-900 px-2 py-1 text-gray-100 focus:border-blue-500 focus:outline-none disabled:opacity-40" />
					</div>
				{/each}
			</div>
		</div>
	{/if}

	{#if planner.selectedBlockers > 0}
		<label class="mt-3 flex cursor-pointer items-start gap-2 border-t border-red-500/20 pt-3 text-xs text-red-200">
			<input type="checkbox" checked={planner.blockersAccepted} onchange={(event) => planner.setBlockersAccepted(event.currentTarget.checked)} class="mt-0.5 h-4 w-4 shrink-0 accent-red-500" />
			<span><span class="font-semibold">Accept unresolved blocking issues.</span> I reviewed the findings for the {planner.selectedBlockers} blocked {planner.selectedBlockers === 1 ? "repository" : "repositories"} and accept the migration risk.</span>
		</label>
	{/if}
	{#if planner.targetNameError}<p class="mt-3 text-xs text-red-400">{planner.targetNameError}</p>{/if}
	{#if planner.planError}<p class="mt-3 text-xs text-red-400" role="alert">{planner.planError}</p>{/if}
</section>