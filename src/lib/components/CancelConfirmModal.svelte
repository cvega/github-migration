<!-- Shared "type to confirm" cancellation modal. Used by the single-migration -->
<!-- ([id]) and batch (batches/[id]) detail pages, which differ only in title, -->
<!-- body prose, the confirm phrase + its case-sensitivity, and the submit label -->
<!-- — all passed as props, so neither page's wording or behaviour changes. -->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import Octicon from '$lib/components/Octicon.svelte';

	let {
		open = $bindable(),
		title,
		confirmPhrase,
		caseSensitive = true,
		submitLabel,
		submitting,
		error,
		inputId = 'cancel-confirm',
		onConfirm,
		body
	}: {
		open: boolean;
		title: string;
		/** The exact text the user must type to enable the destructive action. */
		confirmPhrase: string;
		/** Whether the typed text must match `confirmPhrase` exactly (default) or case-insensitively. */
		caseSensitive?: boolean;
		submitLabel: string;
		submitting: boolean;
		error: string;
		inputId?: string;
		onConfirm: () => void;
		/** Read-only explanation of what cancelling does (page-specific prose). */
		body: Snippet;
	} = $props();

	let dialog = $state<HTMLDialogElement>();
	let confirmText = $state('');

	const confirmed = $derived(
		caseSensitive
			? confirmText.trim() === confirmPhrase
			: confirmText.trim().toLowerCase() === confirmPhrase
	);

	// Drive the native <dialog> from the bound `open` prop.
	$effect(() => {
		if (open) dialog?.showModal();
		else dialog?.close();
	});
</script>

<dialog
	bind:this={dialog}
	onclose={() => {
		open = false;
		// Clear the typed confirmation so a reopened modal starts blank.
		confirmText = '';
	}}
	onclick={(e) => {
		if (e.target === dialog) dialog?.close();
	}}
	class="m-auto w-[calc(100%-2rem)] max-w-md rounded-lg border border-gray-700 bg-gray-900 text-gray-50 shadow-xl backdrop:bg-black/60 backdrop:backdrop-blur-sm"
>
	<div class="flex items-center justify-between border-b border-gray-700 px-5 py-4">
		<h2 class="flex items-center gap-2 text-lg font-semibold text-gray-50">
			<Octicon name="alert" size={24} class="text-red-400" />
			{title}
		</h2>
		<button
			type="button"
			onclick={() => dialog?.close()}
			class="text-gray-400 hover:text-gray-50 transition-colors"
		>
			<Octicon name="x" size={24} />
		</button>
	</div>

	<div class="space-y-4 p-5">
		{@render body()}

		<div>
			<label for={inputId} class="block text-sm font-medium text-gray-400 mb-1">
				Type <span class="font-mono text-gray-200">{confirmPhrase}</span> to confirm
			</label>
			<input
				id={inputId}
				type="text"
				autocomplete="off"
				bind:value={confirmText}
				placeholder={confirmPhrase}
				class="w-full rounded-md border border-gray-700 bg-gray-800 px-3 py-2 font-mono text-sm text-gray-50 placeholder-gray-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
			/>
		</div>

		{#if error}
			<div class="rounded-md border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
				{error}
			</div>
		{/if}

		<div class="flex items-center justify-end gap-3 border-t border-gray-700 pt-4">
			<button
				type="button"
				onclick={() => dialog?.close()}
				class="rounded-md bg-gray-700 px-5 py-2 text-sm font-medium text-gray-50 hover:bg-gray-600 transition-colors"
			>
				Keep running
			</button>
			<button
				type="button"
				disabled={submitting || !confirmed}
				onclick={onConfirm}
				class="flex items-center gap-1.5 rounded-md bg-red-600 px-5 py-2 text-sm font-medium text-white hover:bg-red-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
			>
				{#if submitting}
					Cancelling...
				{:else}
					<Octicon name="x-circle" size={16} />
					{submitLabel}
				{/if}
			</button>
		</div>
	</div>
</dialog>
