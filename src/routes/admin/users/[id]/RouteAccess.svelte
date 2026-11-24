<script lang="ts">
	import { onMount } from "svelte";
	import { enhance } from "$app/forms";
	import Octicon from "$lib/components/Octicon.svelte";
	import { getSourceProviderAdapter } from "$lib/source-provider";
	import type { PageData, SubmitFunction } from "./$types";

	let { data }: { data: PageData } = $props();
	type Grant = PageData["grants"][number];
	const source = $derived(data.profiles.find((p) => p.key === data.selectedSource));
	const sourceGrants = $derived(data.grants.filter((g) => source && g.sourceProvider === source.sourceProvider &&
		g.sourceApiUrl === source.sourceApiUrl && g.namespace === source.namespace));
	const rows = $derived(source?.destinations.map((route) => ({
		route,
		grant: sourceGrants.find((g) => g.targetProfileId === route.targetProfileId &&
			g.targetApiUrl === route.targetApiUrl && g.targetOrg === route.targetOrg)
	})) ?? []);
	const otherGrants = $derived(data.grants.filter((g) => !rows.some((row) => row.grant?.id === g.id)));
	const available = $derived(rows.filter((row) => !row.grant));
	let selected = $state<string[]>([]);
	const count = $derived(available.filter(({ route }) => selected.includes(route.key)).length);
	let interactive = $state(false);
	let saving = $state(false);
	onMount(() => { interactive = true; });
	const assign: SubmitFunction = () => {
		saving = true;
		return async ({ result, update }) => {
			try {
				if (result.type === "success") selected = [];
				await update();
			} finally {
				saving = false;
			}
		};
	};
	const permission = (grant: Grant) => grant.canMigrate ? "View and migrate" : "View only";
	const query = $derived(source ? `?source=${encodeURIComponent(source.key)}&` : "?");
</script>

{#snippet remove(grant: Grant)}
	<form method="POST" action={`${query}/removeAssignment`} use:enhance>
		<input type="hidden" name="grantId" value={grant.id} />
		<button type="submit" aria-label={`Remove ${grant.namespace} (${grant.sourceProvider}) to ${grant.targetOrg} (${grant.targetProfileId})`}
			class="min-h-9 rounded px-2 font-medium text-gray-400 hover:bg-red-500/10 hover:text-red-300">Remove</button>
	</form>
{/snippet}

<section aria-labelledby="profiles-heading" class="min-w-0 space-y-4 p-4 text-sm text-gray-300 sm:p-5">
	<header>
		<h2 id="profiles-heading" class="text-lg font-semibold text-gray-100">Migration access</h2>
		<p class="mt-1 text-gray-400">
			Sources come from completed <a href="/profile" class="text-blue-400 hover:underline">profiles</a>.
			Target organizations are listed in <a href="/setup" class="text-blue-400 hover:underline">Setup</a>.
		</p>
	</header>

	{#if !data.user.isActive || data.user.role !== "operator"}
		<p>Only active operators can receive route assignments.</p>
	{:else if !data.profiles.length}
		<p>No destinations available. Complete a source profile and configure a supported target organization.</p>
	{:else}
		<div>
			<p class="mb-1 font-medium text-gray-300">Source profile</p>
			<div class="flex flex-wrap items-start gap-x-3 gap-y-1">
				<details class="group min-w-0 max-w-full">
					<summary aria-label={`Choose a source: ${source?.label ?? "none selected"}`}
						class="flex w-fit max-w-full cursor-pointer list-none items-center gap-2 rounded-md border border-gray-600 bg-gray-800 px-3 py-2 text-gray-100 hover:bg-gray-700 [&::-webkit-details-marker]:hidden">
						{#if source}
							<Octicon name={getSourceProviderAdapter(source.sourceProvider).sourcePlatform(source.sourceApiUrl).icon} size={16} class="shrink-0" />
							<span class="flex min-w-0 flex-wrap items-baseline gap-x-2">
								<strong class="text-machine max-w-full wrap-anywhere">{source.namespace}</strong>
								<span class="whitespace-nowrap text-gray-400">{getSourceProviderAdapter(source.sourceProvider).displayName}</span>
							</span>
						{:else}Choose a source{/if}
						<Octicon name="chevron-down" size={16} class="shrink-0 text-gray-400 group-open:rotate-180" />
					</summary>
					<nav aria-label="Choose a source" class="mt-1 max-h-56 overflow-y-auto">
						{#each data.profiles as profile (profile.key)}
							<a href={`?source=${encodeURIComponent(profile.key)}`} aria-current={source?.key === profile.key ? "page" : undefined}
								class="block rounded-md px-3 py-2 wrap-anywhere hover:bg-gray-800 aria-[current=page]:text-blue-300">{profile.label}</a>
						{/each}
					</nav>
				</details>
				{#if source}
					<a href={`/profile/${encodeURIComponent(source.id)}`} aria-label="View report for {source.namespace}"
						class="inline-flex min-h-9 items-center gap-1 whitespace-nowrap text-blue-400 hover:underline">
						View report<Octicon name="arrow-right" size={16} />
					</a>
				{/if}
			</div>
		</div>

		{#if source}
			<fieldset class="min-w-0">
				<legend class="mb-2 font-semibold text-gray-100">GitHub destinations<span class="sr-only"> for {source.namespace}</span></legend>
				<ul class="divide-y divide-gray-700 overflow-hidden rounded-md border border-gray-700">
					{#each rows as { route, grant }, index (route.key)}
						{@const platform = route.platform === "ghec" ? "Cloud" : "Server"}
						{@const inputId = `route-destination-${index}`}
						<li class="grid min-w-0 grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-x-3 px-3 py-2 has-checked:bg-blue-500/10 sm:px-4">
							{#if grant}
								<Octicon name="check" size={16} class="mt-0.5 self-start text-green-400 sm:mt-0 sm:self-center" />
							{:else}
								<input id={inputId} form="assign-destinations" type="checkbox" name="route" value={route.key}
									bind:group={selected} class="mt-0.5 h-4 w-4 cursor-pointer self-start accent-blue-500 sm:mt-0 sm:self-center" />
							{/if}
							<svelte:element this={grant ? "div" : "label"} for={grant ? undefined : inputId}
								class="col-span-2 grid min-h-9 min-w-0 content-center gap-y-0.5 sm:grid-cols-[3.5rem_minmax(0,1fr)] sm:items-baseline sm:gap-x-2 {grant ? 'sm:col-span-1' : 'cursor-pointer'}">
								<span class="font-semibold text-gray-100">{platform}</span>
								<span class="text-machine min-w-0 wrap-anywhere text-gray-300">{route.targetOrg}</span>
							</svelte:element>
							{#if grant}
								<div class="col-span-2 col-start-2 flex flex-wrap items-center justify-between gap-x-3 sm:col-span-1 sm:col-start-3">
									<span class="text-gray-300"><span class="sr-only">Assigned: </span>{permission(grant)}</span>
									{@render remove(grant)}
								</div>
							{/if}
						</li>
					{/each}
				</ul>
			</fieldset>
			{#if available.length}
				<form id="assign-destinations" method="POST" action={`${query}/assign`} use:enhance={assign}
					class="flex flex-wrap items-end gap-x-3 gap-y-2">
					<input type="hidden" name="source" value={source.key} />
					<label class="block text-gray-400">Permission for new destinations
						<select name="permission" class="mt-1 block min-h-9 w-full rounded-md border border-gray-600 bg-gray-800 px-2 text-gray-100">
							<option value="view">View only</option><option value="migrate">View and migrate</option>
						</select>
					</label>
					<div class="flex flex-wrap items-center gap-3">
						<button type="submit" disabled={saving || (interactive && !count)}
							class="min-h-9 rounded-md bg-green-600 px-3 font-semibold text-white hover:bg-green-500 disabled:cursor-not-allowed disabled:bg-gray-800 disabled:text-gray-400">
							{saving ? "Assigning…" : "Assign destinations"}
						</button>
						{#if interactive}<span aria-live="polite" class="tabular-nums text-gray-400">{count} selected</span>{/if}
					</div>
				</form>
			{:else}
				<p class="text-gray-400">All available destinations are assigned for this source.</p>
			{/if}
		{:else}
			<p>Choose a source to see its destinations.</p>
		{/if}
	{/if}

	{#if otherGrants.length}
		<details open={!source}>
			<summary class="w-fit cursor-pointer py-1 font-medium text-gray-300">{source ? "Other assigned routes" : "Assigned routes"} ({otherGrants.length})</summary>
			<ul class="divide-y divide-gray-700">
				{#each otherGrants as grant (grant.id)}
					<li class="flex flex-wrap items-center justify-between gap-2 py-2">
						<div class="min-w-0 wrap-anywhere">
							<p class="font-medium text-gray-100">{grant.namespace} → {grant.targetOrg}</p>
							<p class="text-gray-400">{getSourceProviderAdapter(grant.sourceProvider).displayName} · {grant.targetProfileId} · {permission(grant)}</p>
						</div>
						{@render remove(grant)}
					</li>
				{/each}
			</ul>
		</details>
	{/if}
</section>
