<script lang="ts">
	import Octicon from "$lib/components/Octicon.svelte";

	let { open = $bindable(), repositoryCount, submitting, error, onConfirm }: { open: boolean; repositoryCount: number; submitting: boolean; error: string; onConfirm: () => void | Promise<void> } = $props();
	let dialog = $state<HTMLDialogElement>();
	$effect(() => { if (open) dialog?.showModal(); else dialog?.close(); });
</script>

<dialog bind:this={dialog} aria-labelledby="production-launch-title" oncancel={(event) => { if (submitting) event.preventDefault(); }} onclose={() => (open = false)} onclick={(event) => { if (event.target === dialog && !submitting) dialog?.close(); }} class="m-auto w-[calc(100%-2rem)] max-w-lg rounded-md border border-amber-500/30 bg-gray-900 text-gray-50 shadow-xl backdrop:bg-black/60 backdrop:backdrop-blur-sm">
	<header class="flex items-center justify-between gap-3 border-b border-gray-700 px-5 py-4"><h2 id="production-launch-title" class="flex items-center gap-2 text-lg font-semibold text-gray-50"><Octicon name="alert" size={24} class="text-amber-400" />Confirm source lock and archive</h2><button type="button" onclick={() => dialog?.close()} disabled={submitting} aria-label="Close confirmation" class="text-gray-400 transition-colors hover:text-gray-50 disabled:opacity-50"><Octicon name="x" size={24} /></button></header>
	<div class="space-y-4 p-5">
		<p class="text-sm text-gray-300">This will migrate {repositoryCount} {repositoryCount === 1 ? "repository" : "repositories"} and write repository data to the destination.</p>
		<p class="rounded-md border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-300">Each source repository will be locked during migration and archived as read-only after its migration succeeds.</p>
		{#if error}<div role="alert" class="rounded-md border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">{error}</div>{/if}
	</div>
	<footer class="flex flex-col-reverse gap-2 border-t border-gray-700 px-5 py-4 sm:flex-row sm:justify-end"><button type="button" onclick={() => dialog?.close()} disabled={submitting} class="h-10 rounded-md bg-gray-700 px-5 text-sm font-medium text-gray-50 transition-colors hover:bg-gray-600 disabled:opacity-50">Go back</button><button type="button" onclick={() => onConfirm()} disabled={submitting} class="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-amber-600 px-5 text-sm font-semibold text-white transition-colors hover:bg-amber-500 disabled:cursor-not-allowed disabled:opacity-50">{#if submitting}Starting...{:else}<Octicon name="rocket" size={16} />Confirm and start{/if}</button></footer>
</dialog>