<script lang="ts">
	import { enhance } from "$app/forms";
	import { goto } from "$app/navigation";
	import { page } from "$app/state";
	import Octicon from "$lib/components/Octicon.svelte";
	import Pagination from "$lib/components/Pagination.svelte";

	let { data, form } = $props();
	let filter = $state<"all" | "unmapped" | "mapped">("all");
	let search = $state("");
	let submittingId = $state<string | null>(null);

	const mannequins = $derived(data.result?.mannequins ?? []);
	const unmappedCount = $derived(mannequins.filter((mannequin) => !mannequin.claimant).length);
	const mappedCount = $derived(mannequins.length - unmappedCount);
	const suggestedTargetLogins = $derived(
		new Set(data.targetMembers.map((member) => member.login.toLowerCase())),
	);
	const filteredMannequins = $derived(
		mannequins.filter((mannequin) => {
			if (filter === "unmapped" && mannequin.claimant) return false;
			if (filter === "mapped" && !mannequin.claimant) return false;
			const query = search.trim().toLowerCase();
			if (!query) return true;
			return [mannequin.login, mannequin.email, mannequin.claimant?.login].some((value) =>
				value?.toLowerCase().includes(query),
			);
		}),
	);

	function selectOrganization(event: Event) {
		const organization = (event.currentTarget as HTMLSelectElement).value;
		goto(`/mannequins?org=${encodeURIComponent(organization)}`);
	}

	function goToPage(nextPage: number) {
		const params = new URLSearchParams(page.url.searchParams);
		params.set("page", String(nextPage));
		goto(`/mannequins?${params.toString()}`);
	}
</script>

<svelte:head><title>Mannequins - GitHub Migration Toolkit</title></svelte:head>

<div class="space-y-6">
	<header class="flex flex-col gap-4 border-b border-gray-700 pb-5 sm:flex-row sm:items-end sm:justify-between">
		<div>
			<h1 class="flex items-center gap-2 text-xl font-semibold text-gray-50">
				<Octicon name="people" size={24} class="text-gray-300" />
				Mannequins
			</h1>
			<p class="mt-1 max-w-2xl text-sm leading-6 text-gray-400">
				Map source users to target users and send attribution invitations.
			</p>
		</div>
		{#if data.targetOrganizations.length > 0}
			<label class="flex min-w-0 flex-col gap-1 text-xs font-medium text-gray-400">
				Target organization
				<span class="relative">
					<select
						value={data.organization ?? ""}
						onchange={selectOrganization}
						class="h-9 w-full min-w-52 appearance-none rounded-md border border-gray-600 bg-gray-900 py-1 pr-9 pl-3 text-sm text-gray-100 outline-none hover:border-gray-500 focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
					>
						{#each data.targetOrganizations as organization (organization)}
							<option value={organization}>{organization}</option>
						{/each}
					</select>
					<span class="pointer-events-none absolute inset-y-0 right-2 flex items-center text-gray-500">
						<Octicon name="chevron-down" size={16} />
					</span>
				</span>
			</label>
		{/if}
	</header>

	{#if data.targetOrganizations.length === 0}
		<section class="py-14 text-center" aria-labelledby="no-target-heading">
			<Octicon name="organization" size={24} class="text-gray-600" />
			<h2 id="no-target-heading" class="mt-3 text-base font-semibold text-gray-100">No target organization configured</h2>
			<p class="mx-auto mt-1 max-w-md text-sm leading-6 text-gray-400">Add at least one GitHub Enterprise Cloud organization before discovering mannequins.</p>
			<a href="/setup#targets" class="mt-4 inline-flex h-9 items-center gap-2 rounded-md border border-gray-600 px-3 text-sm font-medium text-gray-200 hover:bg-gray-800"><Octicon name="gear" size={16} />Open Setup</a>
		</section>
	{:else if !data.targetAuthReady}
		<section class="py-14 text-center" aria-labelledby="auth-heading">
			<Octicon name="key" size={24} class="text-gray-600" />
			<h2 id="auth-heading" class="mt-3 text-base font-semibold text-gray-100">No server target credential configured</h2>
			<p class="mx-auto mt-1 max-w-md text-sm leading-6 text-gray-400">Set <code class="font-mono text-gray-300">GH_TARGET_PAT</code> or the target GitHub App environment variables, then restart the service.</p>
			<a href="/setup#targets" class="mt-4 inline-flex h-9 items-center gap-2 rounded-md border border-gray-600 px-3 text-sm font-medium text-gray-200 hover:bg-gray-800"><Octicon name="gear" size={16} />Open Setup</a>
		</section>
	{:else if data.error}
		<div role="alert" class="flex items-start gap-3 rounded-md border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
			<Octicon name="alert" size={16} class="mt-0.5 shrink-0" />
			<div class="min-w-0 flex-1"><p class="font-medium">Unable to load mannequins</p><p class="mt-0.5 text-red-200/80">{data.error}</p></div>
			<a href={page.url.pathname + page.url.search} aria-label="Retry" title="Retry" class="rounded p-1 text-red-200 hover:bg-red-500/10"><Octicon name="sync" size={16} /></a>
		</div>
	{:else if data.result}
		<section aria-labelledby="mapping-heading">
			<div class="grid grid-cols-[minmax(0,1fr)_2.5rem_minmax(0,1fr)] items-center border-y border-gray-700 bg-gray-900/40 px-3 py-4 sm:px-4">
				<div class="min-w-0">
					<p class="text-xs font-medium text-gray-500">Source users</p>
					<p class="mt-1 truncate text-sm font-semibold text-gray-100">{data.result.totalCount.toLocaleString()} migrated users</p>
				</div>
				<Octicon name="arrow-right" size={16} class="mx-auto text-gray-500" />
				<div class="min-w-0 text-right">
					<p class="text-xs font-medium text-gray-500">Target users</p>
					<p class="mt-1 truncate text-sm font-semibold text-gray-100">{data.organization}</p>
				</div>
			</div>

			<div class="flex flex-col gap-3 border-b border-gray-700 py-4 sm:flex-row sm:items-center sm:justify-between">
				<div class="min-w-0">
					<h2 id="mapping-heading" class="text-base font-semibold text-gray-100">User map</h2>
					<p class="mt-0.5 text-xs text-gray-500">{mappedCount} mapped · {unmappedCount} need a target on this page</p>
				</div>
				<div class="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
					<label class="relative min-w-0 sm:w-56">
						<span class="sr-only">Search user mappings</span>
						<span class="pointer-events-none absolute inset-y-0 left-2.5 flex items-center text-gray-500"><Octicon name="search" size={16} /></span>
						<input bind:value={search} type="search" placeholder="Search users" class="h-8 w-full rounded-md border border-gray-700 bg-gray-900 pr-2 pl-8 text-sm text-gray-100 outline-none placeholder:text-gray-600 focus:border-blue-500 focus:ring-1 focus:ring-blue-500" />
					</label>
					<fieldset class="inline-flex self-start rounded-md border border-gray-700 bg-gray-900 p-0.5">
						<legend class="sr-only">Filter user mappings</legend>
						{#each [
							{ id: "all", label: "All", count: mannequins.length },
							{ id: "unmapped", label: "Unmapped", count: unmappedCount },
							{ id: "mapped", label: "Mapped", count: mappedCount },
						] as option (option.id)}
							<button type="button" onclick={() => (filter = option.id as typeof filter)} aria-pressed={filter === option.id} class="rounded px-2.5 py-1 text-xs font-medium transition-colors {filter === option.id ? 'bg-gray-700 text-gray-50 shadow-sm' : 'text-gray-400 hover:text-gray-200'}">{option.label} <span class="ml-1 tabular-nums text-gray-500">{option.count}</span></button>
						{/each}
					</fieldset>
				</div>
			</div>

			{#if data.memberDiscoveryLimited || data.targetMembers.length >= 100}
				<p class="border-b border-gray-800 px-3 py-2 text-xs text-gray-500">Target suggestions are limited. You can still enter any organization member’s login.</p>
			{/if}
			<datalist id="target-members">
				{#each data.targetMembers as member (member.id)}<option value={member.login}></option>{/each}
			</datalist>

			{#if mannequins.length === 0}
				<div class="py-14 text-center">
					<Octicon name="check-circle" size={24} class="text-green-400" />
					<h3 class="mt-3 text-base font-semibold text-gray-100">No source users found</h3>
					<p class="mt-1 text-sm text-gray-400">GitHub has no migrated users to map in this organization.</p>
				</div>
			{:else}
				<div class="hidden grid-cols-[minmax(0,1fr)_2rem_minmax(0,1fr)_8rem] items-center gap-4 border-b border-gray-800 px-3 py-2 text-xs font-medium text-gray-500 sm:grid">
					<span>Source user</span><span></span><span>Target user</span><span>Status</span>
				</div>
				<ul class="divide-y divide-gray-800">
					{#each filteredMannequins as mannequin (mannequin.id)}
						<li class="grid gap-3 px-3 py-4 sm:grid-cols-[minmax(0,1fr)_2rem_minmax(0,1fr)_8rem] sm:items-center sm:gap-4">
							<div class="min-w-0">
								<p class="truncate font-mono text-sm font-medium text-gray-100">{mannequin.login}</p>
								<p class="mt-0.5 truncate text-xs text-gray-500">{mannequin.email ?? "No source email"}</p>
							</div>
							<Octicon name="arrow-right" size={16} class="text-gray-600" />
							{#if mannequin.claimant}
								<div class="flex min-w-0 items-center gap-2">
									<img src={mannequin.claimant.avatarUrl} alt="" class="h-7 w-7 rounded-full" />
									<span class="truncate text-sm text-gray-200">@{mannequin.claimant.login}</span>
								</div>
								<span class="inline-flex items-center gap-1.5 text-xs font-medium text-green-400"><Octicon name="check-circle-fill" size={16} />Mapped</span>
							{:else}
								<form method="POST" action="?/invite" use:enhance={() => { submittingId = mannequin.id; return async ({ update }) => { await update(); submittingId = null; }; }} class="grid min-w-0 gap-2 sm:col-span-2 sm:grid-cols-[minmax(0,1fr)_8rem]">
									<input type="hidden" name="organization" value={data.organization ?? ""} />
									<input type="hidden" name="mannequinId" value={mannequin.id} />
									<div class="min-w-0">
										<div class="relative"><span class="pointer-events-none absolute inset-y-0 left-2.5 flex items-center text-sm text-gray-500">@</span><input list="target-members" name="targetLogin" required maxlength="39" value={suggestedTargetLogins.has(mannequin.login.toLowerCase()) ? mannequin.login : ""} aria-label={`Target GitHub user for ${mannequin.login}`} placeholder="Choose target member" class="h-9 w-full rounded-md border border-gray-600 bg-gray-900 pr-2 pl-7 text-sm text-gray-100 outline-none placeholder:text-gray-600 hover:border-gray-500 focus:border-blue-500 focus:ring-1 focus:ring-blue-500" /></div>
										{#if form?.mannequinId === mannequin.id}<p aria-live="polite" class="mt-1.5 text-xs {form.error ? 'text-red-400' : 'text-green-400'}">{form.error ?? form.success}</p>{/if}
									</div>
									<button type="submit" disabled={submittingId !== null} class="inline-flex h-9 items-center justify-center gap-1.5 rounded-md border border-gray-600 bg-gray-800 px-3 text-sm font-medium text-gray-100 hover:bg-gray-700 disabled:cursor-wait disabled:opacity-50">{#if submittingId === mannequin.id}<Octicon name="sync" size={16} class="animate-spin" />{:else}<Octicon name="plus" size={16} />{/if}Send invite</button>
								</form>
							{/if}
						</li>
					{/each}
				</ul>
				{#if filteredMannequins.length === 0}<p class="py-10 text-center text-sm text-gray-500">No mappings match this view.</p>{/if}
				<Pagination page={data.result.page} totalPages={data.result.totalPages} total={data.result.totalCount} limit={50} onPageChange={goToPage} />
			{/if}
		</section>
	{/if}

	<aside class="border-t border-gray-800 pt-4 text-xs leading-5 text-gray-500">
		Reclaiming changes attribution for migrated issues, pull requests, and comments. It does not add the claimant to repositories, teams, or the organization.
	</aside>
</div>
