<script lang="ts">
	import Octicon from "$lib/components/Octicon.svelte";
	import type { MigrationRepositoryMapping } from "./workflow.svelte";

	let { open = $bindable(), mappings }: { open: boolean; mappings: MigrationRepositoryMapping[] } = $props();
	let dialog = $state<HTMLDialogElement>();
	$effect(() => { if (open) dialog?.showModal(); else dialog?.close(); });
</script>

<dialog bind:this={dialog} aria-labelledby="repository-review-title" onclose={() => (open = false)} onclick={(event) => { if (event.target === dialog) dialog?.close(); }} class="m-auto w-[calc(100%-2rem)] max-w-3xl rounded-md border border-gray-700 bg-gray-900 text-gray-50 shadow-xl backdrop:bg-black/60 backdrop:backdrop-blur-sm">
	<header class="flex items-center justify-between gap-3 border-b border-gray-700 px-5 py-4"><div><h2 id="repository-review-title" class="text-lg font-semibold text-gray-50">Repository mappings</h2><p class="mt-1 text-xs text-gray-500">{mappings.length} normalized {mappings.length === 1 ? "repository" : "repositories"}</p></div><button type="button" onclick={() => dialog?.close()} aria-label="Close repository review" class="text-gray-400 transition-colors hover:text-gray-50"><Octicon name="x" size={24} /></button></header>
	<div class="max-h-[60vh] overflow-y-auto p-5"><div class="divide-y divide-gray-700 overflow-hidden rounded-md border border-gray-700">{#each mappings as mapping, index (`${mapping.source}:${index}`)}<div class="grid gap-1 bg-gray-950 px-4 py-3 text-sm sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] sm:items-center sm:gap-3"><span class="break-all font-mono text-gray-300">{mapping.source}</span><Octicon name="arrow-right" size={12} class="hidden text-gray-600 sm:block" /><span class="break-all font-mono text-gray-100">{mapping.target}</span></div>{/each}</div></div>
	<footer class="flex justify-end border-t border-gray-700 px-5 py-4"><button type="button" onclick={() => dialog?.close()} class="h-10 rounded-md bg-gray-700 px-5 text-sm font-medium text-gray-50 transition-colors hover:bg-gray-600">Done</button></footer>
</dialog>