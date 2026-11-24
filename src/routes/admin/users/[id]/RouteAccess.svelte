<script lang="ts">
	import { enhance } from "$app/forms";
	import type { PageData } from "./$types";

	let { data }: { data: PageData } = $props();
	const source = $derived(data.profiles.find((p) => p.key === data.selectedSource));
	const grants = $derived(data.grants.filter((g) => source && g.sourceProvider === source.sourceProvider &&
		g.sourceApiUrl === source.sourceApiUrl && g.namespace === source.namespace));
	const choices = $derived(source?.destinations.map((route) => ({ route, existing: grants.find((g) =>
		g.targetProfileId === route.targetProfileId && g.targetApiUrl === route.targetApiUrl && g.targetOrg === route.targetOrg) })) ?? []);
</script>

<p class="text-gray-400">
	Sources come from completed <a href="/profile" class="text-blue-400 underline">source profiles</a>.
	Destinations are organizations configured for supported targets in <a href="/setup" class="text-blue-400 underline">Setup</a>.
	Assigning access does not start a migration.
</p>
{#if data.profiles.length}
	<div class="grid items-start gap-5 sm:grid-cols-[minmax(10rem,2fr)_minmax(0,3fr)]">
		<nav aria-label="Choose a source" class="min-w-0">
			<h3 class="mb-2 font-semibold text-gray-100">Source</h3>
			<ul class="max-h-64 space-y-1 overflow-y-auto">
				{#each data.profiles as profile (profile.key)}
					<li><a href={`?source=${encodeURIComponent(profile.key)}`} aria-current={source?.key === profile.key ? "true" : undefined}
						class="block rounded-md px-3 py-2 break-words hover:bg-gray-800 aria-current:bg-blue-500/10 aria-current:text-blue-300">{profile.label}</a></li>
				{/each}
			</ul>
		</nav>
		{#if source}
			{#key source.key}
				<form method="POST" action={`?source=${encodeURIComponent(source.key)}&/assign`} use:enhance class="min-w-0 space-y-3">
					<input type="hidden" name="source" value={source.key} />
					<fieldset>
						<legend class="mb-2 font-semibold text-gray-100">Destinations for {source.namespace}</legend>
						<a href={`/profile/${encodeURIComponent(source.id)}`} class="mb-2 inline-block text-blue-400 underline">View latest source report</a>
						{#each choices as {route, existing}, index (route.key)}
							<label for={`route-destination-${index}`} class="flex items-baseline gap-2 py-1.5">
								{#if existing}
									<input id={`route-destination-${index}`} type="checkbox" checked disabled />
								{:else}
									<input id={`route-destination-${index}`} type="checkbox" name="route" value={route.key} />
								{/if}
								<span class="break-words">{route.label}{#if existing}<small class="block text-sm text-gray-400">Assigned · {existing.canMigrate ? "View and migrate" : "View only"}</small>{/if}</span>
							</label>
						{/each}
					</fieldset>
					{#if choices.some((choice) => !choice.existing)}
					<label class="block">Permission for new destinations
						<select name="permission" class="mt-1 block max-w-full rounded-md border border-gray-700 bg-gray-800 px-3 py-2">
							<option value="view">View only</option><option value="migrate">View and migrate</option>
						</select>
					</label>
					<button type="submit" class="rounded-md bg-green-600 px-3 py-2 font-medium text-white hover:bg-green-500">Assign destinations</button>
					{:else}
						<p class="text-gray-400">All available destinations are assigned for this source.</p>
					{/if}
				</form>
			{/key}
		{:else}
			<p>Choose an available source to see its destinations.</p>
		{/if}
	</div>
{:else}
	<p>No assignable routes yet. Complete a source profile and configure at least one allowed target organization.</p>
{/if}
