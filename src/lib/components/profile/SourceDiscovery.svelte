<script lang="ts">
	import type { SourceProvider } from "$lib/source-provider";

	let {provider, onselect}: {provider: SourceProvider; onselect: (key:string)=>void} = $props();
	let entries = $state<{key:string; name:string}[]>([]);
	let next = $state<number|null>(null);
	let busy = $state(false);
	let message = $state("");
	let host = $state("");
	let filter = $state("");
	let observedAt = $state("");
	const visible = $derived(entries.filter(e => `${e.name} ${e.key}`.toLowerCase().includes(filter.toLowerCase())));

	async function load(cursor=0) {
		busy=true;
		message="";
		try {
			const response=await fetch(`/api/profile/discover?provider=${provider}&cursor=${cursor}`);
			if (!response.ok) throw new Error(`Discovery failed (HTTP ${response.status}). Check source read access and try again.`);
			const page=await response.json();
			entries=[...new Map<string,{key:string;name:string}>((cursor ? [...entries,...page.entries] : page.entries).map((e:{key:string;name:string})=>[e.key,e])).values()];
			host=page.host;
			next=page.next;
			observedAt=page.observedAt;
		} catch (error) {
			message=error instanceof Error ? error.message : "Discovery failed.";
		} finally { busy=false; }
	}
</script>

<section aria-label="Discover source namespaces" class="mt-4 space-y-2 border-t border-gray-700 pt-3">
	<button type="button" disabled={busy} onclick={()=>load()} class="rounded-md border border-gray-600 px-3 py-1.5 text-sm font-medium">{busy ? "Loading…" : host ? "Refresh inventory" : "Discover namespaces"}</button>
	{#if message}<p role="alert" class="text-sm text-red-400">{message}</p>{/if}
	{#if host}
		<p class="text-sm text-gray-400">{entries.length} loaded from {host} within profile scope · {new Date(observedAt).toLocaleTimeString()}</p>
		<label class="block text-sm">Filter loaded namespaces<input bind:value={filter} type="search" class="mt-1 block w-full rounded-md border border-gray-600 bg-gray-950 px-3 py-2" /></label>
		<ul class="max-h-56 overflow-auto">{#each visible as entry (entry.key)}
			<li><button type="button" onclick={()=>onselect(entry.key)} class="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-gray-800">{entry.key}{entry.key !== entry.name ? ` · ${entry.name}` : ""}</button></li>
		{:else}<li class="text-sm text-gray-400">No matching namespaces on the loaded pages.</li>{/each}</ul>
		{#if next !== null}<button type="button" disabled={busy} onclick={()=>load(next ?? 0)} class="text-sm text-blue-400">Load more</button>{/if}
	{/if}
</section>
