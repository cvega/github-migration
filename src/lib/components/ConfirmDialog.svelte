<script lang="ts">
	import type { Snippet } from "svelte";
	import Octicon from "$lib/components/Octicon.svelte";

	let {
		open = $bindable(),
		title,
		confirmPhrase,
		caseSensitive = true,
		submitLabel,
		cancelLabel = "Cancel",
		submitting,
		error,
		inputId = "confirm-action",
		tone = "danger",
		onConfirm,
		body,
	}: {
		open: boolean;
		title: string;
		confirmPhrase: string;
		caseSensitive?: boolean;
		submitLabel: string;
		cancelLabel?: string;
		submitting: boolean;
		error: string;
		inputId?: string;
		tone?: "danger" | "warning";
		onConfirm: () => void;
		body: Snippet;
	} = $props();

	let confirmText = $state("");
	const confirmed = $derived(
		caseSensitive
			? confirmText.trim() === confirmPhrase
			: confirmText.trim().toLowerCase() === confirmPhrase.toLowerCase(),
	);
	const accent = $derived(
		tone === "warning"
			? {
					icon: "text-orange-400",
					button: "bg-orange-600 hover:bg-orange-500",
					focus: "focus:border-orange-500 focus:ring-orange-500",
				}
			: {
					icon: "text-red-400",
					button: "bg-red-600 hover:bg-red-500",
					focus: "focus:border-red-500 focus:ring-red-500",
				},
	);

	function openDialog(node: HTMLDialogElement) {
		node.showModal();
	}
</script>

{#if open}
<dialog
	{@attach openDialog}
	aria-labelledby={`${inputId}-title`}
	oncancel={(event) => {
		if (submitting) event.preventDefault();
	}}
	onclose={() => {
		open = false;
		confirmText = "";
	}}
	onclick={(event) => {
		if (event.target === event.currentTarget && !submitting) event.currentTarget.close();
	}}
	class="m-auto w-[calc(100%-2rem)] max-w-md rounded-lg border border-gray-700 bg-gray-900 text-gray-50 shadow-xl backdrop:bg-black/60 backdrop:backdrop-blur-sm"
>
	<div class="flex items-center justify-between border-b border-gray-700 px-5 py-4">
		<h2 id={`${inputId}-title`} class="flex items-center gap-2 text-lg font-semibold text-gray-50">
			<Octicon name="alert" size={24} class={accent.icon} />{title}
		</h2>
		<button
			type="button"
			onclick={(event) => event.currentTarget.closest("dialog")?.close()}
			disabled={submitting}
			aria-label="Close"
			class="text-gray-400 transition-colors hover:text-gray-50"
		>
			<Octicon name="x" size={24} />
		</button>
	</div>

	<div class="space-y-4 p-5">
		{@render body()}
		<div>
			<label for={inputId} class="mb-1 block text-sm font-medium text-gray-400">
				Type <span class="break-all font-mono text-gray-200">{confirmPhrase}</span> to confirm
			</label>
			<input
				id={inputId}
				type="text"
				autocomplete="off"
				bind:value={confirmText}
				placeholder={confirmPhrase}
				class="w-full rounded-md border border-gray-700 bg-gray-800 px-3 py-2 font-mono text-sm text-gray-50 placeholder-gray-500 focus:ring-1 focus:outline-none {accent.focus}"
			/>
		</div>

		{#if error}
			<div
				role="alert"
				class="rounded-md border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400"
			>
				{error}
			</div>
		{/if}

		<div class="flex items-center justify-end gap-3 border-t border-gray-700 pt-4">
			<button
				type="button"
				onclick={(event) => event.currentTarget.closest("dialog")?.close()}
				disabled={submitting}
				class="rounded-md bg-gray-700 px-5 py-2 text-sm font-medium text-gray-50 transition-colors hover:bg-gray-600"
			>
				{cancelLabel}
			</button>
			<button
				type="button"
				disabled={submitting || !confirmed}
				onclick={onConfirm}
				class="flex items-center gap-1.5 rounded-md px-5 py-2 text-sm font-medium text-white transition-colors disabled:cursor-not-allowed disabled:opacity-50 {accent.button}"
			>
				{#if submitting}
					Working...
				{:else}
					<Octicon name="check-circle" size={16} />{submitLabel}
				{/if}
			</button>
		</div>
	</div>
</dialog>
{/if}