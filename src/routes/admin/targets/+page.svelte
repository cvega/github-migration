<script lang="ts">
	import { enhance } from "$app/forms";
	import Octicon from "$lib/components/Octicon.svelte";
	import type { PageProps } from "./$types";

	let { data, form }: PageProps = $props();
</script>

<svelte:head><title>Target organizations - GitHub Migration Toolkit</title></svelte:head>

<div class="mx-auto max-w-3xl space-y-6">
	<header>
		<a href="/admin/users" class="inline-flex items-center gap-1 text-sm text-gray-400 hover:text-gray-200"><Octicon name="chevron-left" size={16} />Users</a>
		<h1 class="mt-3 text-2xl font-semibold text-gray-100">Target organizations</h1>
		<p class="mt-1 text-sm text-gray-400">List the GitHub organizations admins can map to a source. Adding one does not create an organization, grant access, or start a migration.</p>
	</header>
	{#if form?.error}<p role="alert" class="rounded-md border border-red-500/40 px-3 py-2 text-sm text-red-300">{form.error}</p>{/if}
	{#if form?.success}<p role="status" class="rounded-md border border-green-500/40 px-3 py-2 text-sm text-green-300">{form.success}</p>{/if}

	{#each data.connections as connection (connection.key)}
		{@const platform = connection.platform === "ghec" ? "Cloud" : "Server"}
		<section aria-label={`${platform} target organizations`} class="min-w-0 space-y-3 text-sm text-gray-300">
			<header class="flex flex-wrap items-center justify-between gap-2">
				<div class="min-w-0">
					<h2 class="flex items-center gap-2 text-base font-semibold text-gray-100"><Octicon name={connection.platform === "ghec" ? "cloud" : "server"} size={16} />{platform} <span class="font-normal text-gray-400">({connection.entries.length})</span></h2>
					<p class="text-machine wrap-anywhere text-gray-400">{connection.apiUrl}</p>
				</div>
				<form method="POST" action="?/discover" use:enhance>
					<input type="hidden" name="connection" value={connection.key} />
					<button type="submit" class="min-h-9 rounded-md border border-gray-600 px-3 hover:bg-gray-800">Find organizations</button>
				</form>
			</header>
			{#if connection.entries.length}
				<ul class="divide-y divide-gray-700 rounded-md border border-gray-700">
					{#each connection.entries as entry (entry.org)}
						<li class="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
							<strong class="text-machine min-w-0 wrap-anywhere text-gray-100">{entry.org}</strong>
							{#if entry.configured}<span class="text-gray-400">From configuration</span>
							{:else}
								<div class="flex flex-wrap items-center gap-3">
									{#if connection.scopePinned}<span class="text-gray-400">View-only mappings</span>{/if}
									<form method="POST" action="?/remove" use:enhance>
										<input type="hidden" name="connection" value={connection.key} /><input type="hidden" name="org" value={entry.org} />
										<button type="submit" aria-label={`Remove ${entry.org} from ${platform}`} class="min-h-8 text-gray-400 hover:text-red-300">Remove</button>
									</form>
								</div>
							{/if}
						</li>
					{/each}
				</ul>
			{:else}<p class="text-gray-400">No target organizations listed on this connection.</p>{/if}
			{#if form?.discovery?.key === connection.key}
				<div>
					<h3 class="font-medium text-gray-200">Visible to this connection</h3>
					{#if form.discovery.organizations.length}
						<ul>
							{#each form.discovery.organizations as org (org)}
								<li class="flex flex-wrap items-center gap-3 py-1">
									<span class="text-machine wrap-anywhere">{org}</span>
									{#if connection.entries.some((e) => e.org.toLowerCase() === org.toLowerCase())}<span class="text-gray-400">Listed</span>
									{:else}
										<form method="POST" action="?/add" use:enhance>
											<input type="hidden" name="connection" value={connection.key} /><input type="hidden" name="org" value={org} />
											<button type="submit" aria-label={`Add ${org} to ${platform}`} class="min-h-8 text-blue-400 hover:underline">Add</button>
										</form>
									{/if}
								</li>
							{/each}
						</ul>
					{:else}<p class="text-gray-400">The credential returned no organizations on this page. You can still enter a known login.</p>{/if}
					{#if form.discovery.next !== null}
						<form method="POST" action="?/discover" use:enhance>
							<input type="hidden" name="connection" value={connection.key} /><input type="hidden" name="cursor" value={form.discovery.next} />
							<button type="submit" class="min-h-8 text-blue-400 hover:underline">Next page</button>
						</form>
					{/if}
				</div>
			{/if}
			<form method="POST" action="?/add" use:enhance class="flex flex-wrap items-end gap-2">
				<input type="hidden" name="connection" value={connection.key} />
				<label class="min-w-0 text-gray-400">Organization login
					<input required name="org" maxlength="39" autocomplete="off" placeholder="e.g. engineering" class="mt-1 block min-h-9 w-56 max-w-full rounded-md border border-gray-600 bg-gray-950 px-3 text-gray-100" />
				</label>
				<button type="submit" class="min-h-9 rounded-md border border-gray-600 bg-gray-800 px-3 font-medium hover:bg-gray-700">Add target</button>
			</form>
			{#if connection.scopePinned}
				<p class="text-gray-400">Migration is limited to organizations in <code>{connection.platform === "ghec" ? "GH_TARGET_ORG" : "GHES_TARGET_ORG"}</code>. Other listed targets can be mapped for viewing.</p>
			{/if}
		</section>
	{/each}
</div>
