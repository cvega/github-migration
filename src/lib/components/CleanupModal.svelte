<!-- Guarded target-repo cleanup modal: shows the safety-gate checklist and
     requires a typed confirmation before renaming or deleting. -->
<script lang="ts">
	import Octicon from '$lib/components/Octicon.svelte';
	import { untrack } from 'svelte';

	type CleanupAction = 'rename' | 'delete';

	interface GateStatus {
		reason: string;
		label: string;
		passed: boolean;
		detail: string;
	}

	interface Preview {
		gates: GateStatus[];
		ready: boolean;
		confirmationPhrase: string;
	}

	let {
		migrationId,
		targetOrg,
		targetRepo,
		mode,
		open = $bindable(),
		onDone
	}: {
		migrationId: string;
		targetOrg: string;
		targetRepo: string;
		/** Effective cleanup mode from the server: 'rename' or 'delete'. */
		mode: CleanupAction;
		open: boolean;
		/** Called after a successful action so the parent can refresh. */
		onDone?: (detail: string) => void;
	} = $props();

	let dialog = $state<HTMLDialogElement>();
	// Default to the least destructive action available.
	let action = $state<CleanupAction>('rename');
	let preview = $state<Preview | null>(null);
	let loading = $state(false);
	let submitting = $state(false);
	let confirmText = $state('');
	let errorMsg = $state('');
	let result = $state<string>('');

	const phrase = $derived(`${targetOrg}/${targetRepo}`);
	const canDelete = $derived(mode === 'delete');
	const confirmed = $derived(confirmText === phrase);
	const canSubmit = $derived(!!preview?.ready && confirmed && !submitting);

	async function loadPreview() {
		loading = true;
		errorMsg = '';
		try {
			const res = await fetch(
				`/api/migrations/${migrationId}/cleanup?action=${action}`
			);
			if (res.ok) {
				preview = await res.json();
			} else {
				const body = await res.json().catch(() => ({}));
				errorMsg = body.error || `HTTP ${res.status}`;
			}
		} catch (err) {
			errorMsg = err instanceof Error ? err.message : 'Failed to load gate status';
		} finally {
			loading = false;
		}
	}

	// Drive the native <dialog> and (re)load the checklist when opened or when
	// the chosen action changes.
	$effect(() => {
		if (open) {
			dialog?.showModal();
			untrack(() => loadPreview());
		} else {
			dialog?.close();
		}
	});

	function reset() {
		confirmText = '';
		result = '';
		errorMsg = '';
		preview = null;
	}

	function close() {
		reset();
		open = false;
	}

	function selectAction(next: CleanupAction) {
		if (action === next) return;
		action = next;
		// Re-fetch the checklist for the new action.
		void loadPreview();
	}

	async function submit() {
		if (!canSubmit) return;
		submitting = true;
		errorMsg = '';
		try {
			const res = await fetch(`/api/migrations/${migrationId}/cleanup`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action, confirmation: confirmText })
			});
			const body = await res.json().catch(() => ({}));
			if (res.ok) {
				result = body.detail || 'Done.';
				onDone?.(result);
			} else {
				errorMsg = body.error || `HTTP ${res.status}`;
			}
		} catch (err) {
			errorMsg = err instanceof Error ? err.message : 'Action failed';
		} finally {
			submitting = false;
		}
	}
</script>

<dialog
	bind:this={dialog}
	onclose={close}
	onclick={(e) => {
		if (e.target === dialog) close();
	}}
	class="w-[calc(100%-2rem)] max-w-xl max-h-[85vh] overflow-y-auto rounded-lg border border-gray-700 bg-gray-900 text-gray-50 shadow-xl backdrop:bg-black/60 backdrop:backdrop-blur-sm"
>
	<div
		class="sticky top-0 z-10 flex items-center justify-between border-b border-gray-700 bg-gray-900 px-5 py-4"
	>
		<h2 class="flex items-center gap-2 text-lg font-semibold text-gray-50">
			<Octicon name="alert" size={24} class="text-yellow-400" />
			Clean up target repository
		</h2>
		<button
			type="button"
			onclick={close}
			class="text-gray-400 hover:text-gray-50 transition-colors"
		>
			<Octicon name="x" size={24} />
		</button>
	</div>

	<div class="space-y-5 p-5">
		{#if result}
			<div
				class="flex items-center gap-2 rounded-md border border-green-500/30 bg-green-500/10 px-4 py-3 text-sm text-green-400"
			>
				<Octicon name="check-circle" size={16} />
				{result}
			</div>
			<div class="flex justify-end">
				<button
					type="button"
					onclick={close}
					class="rounded-md bg-gray-700 px-5 py-2 text-sm font-medium text-gray-50 hover:bg-gray-600 transition-colors"
				>
					Close
				</button>
			</div>
		{:else}
			<p class="text-sm text-gray-400">
				This acts on <span class="font-mono text-gray-200">{phrase}</span> on the target.
				Every safety check below must pass, and the action is recorded in the event log.
			</p>

			<!-- Action selector -->
			<div class="flex gap-1 rounded-md bg-gray-800 p-0.5">
				<button
					type="button"
					class="flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors {action ===
					'rename'
						? 'bg-gray-700 text-gray-50'
						: 'text-gray-400 hover:text-gray-200'}"
					onclick={() => selectAction('rename')}
				>
					Rename aside (reversible)
				</button>
				<button
					type="button"
					disabled={!canDelete}
					title={canDelete ? '' : 'Delete is not enabled on this server'}
					class="flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors {action ===
					'delete'
						? 'bg-red-600 text-white'
						: 'text-gray-400 hover:text-gray-200'} disabled:opacity-40 disabled:cursor-not-allowed"
					onclick={() => selectAction('delete')}
				>
					Delete (irreversible)
				</button>
			</div>

			<!-- Gate checklist -->
			<div class="rounded-md border border-gray-700 bg-gray-950">
				{#if loading}
					<div class="px-4 py-6 text-center text-sm text-gray-500">Checking gates…</div>
				{:else if preview}
					<ul class="divide-y divide-gray-800/60">
						{#each preview.gates as gate (gate.reason)}
							<li class="flex items-start gap-2 px-4 py-2 text-sm">
								<span class="mt-0.5 shrink-0">
									{#if gate.passed}
										<Octicon name="check-circle" size={16} class="text-green-400" />
									{:else}
										<Octicon name="x-circle" size={16} class="text-red-400" />
									{/if}
								</span>
								<span class="min-w-0">
									<span class={gate.passed ? 'text-gray-300' : 'text-gray-100'}>{gate.label}</span>
									{#if !gate.passed}
										<span class="block text-xs text-gray-500">{gate.detail}</span>
									{/if}
								</span>
							</li>
						{/each}
					</ul>
				{/if}
			</div>

			{#if errorMsg}
				<div
					class="rounded-md border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400"
				>
					{errorMsg}
				</div>
			{/if}

			<!-- Confirmation -->
			<div>
				<label for="cleanup-confirm" class="block text-sm font-medium text-gray-400 mb-1">
					Type <span class="font-mono text-gray-200">{phrase}</span> to confirm
				</label>
				<input
					id="cleanup-confirm"
					type="text"
					autocomplete="off"
					bind:value={confirmText}
					placeholder={phrase}
					class="w-full rounded-md border border-gray-700 bg-gray-800 px-3 py-2 font-mono text-sm text-gray-50 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
				/>
			</div>

			<div class="flex items-center justify-end gap-3 border-t border-gray-700 pt-4">
				<button
					type="button"
					onclick={close}
					class="text-sm text-gray-400 hover:text-gray-50 transition-colors"
				>
					Cancel
				</button>
				<button
					type="button"
					disabled={!canSubmit}
					onclick={submit}
					class="flex items-center gap-1.5 rounded-md px-5 py-2 text-sm font-medium text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed {action ===
					'delete'
						? 'bg-red-600 hover:bg-red-500'
						: 'bg-blue-600 hover:bg-blue-500'}"
				>
					{#if submitting}
						Working…
					{:else}
						<Octicon name={action === 'delete' ? 'trash' : 'pencil'} size={16} />
						{action === 'delete' ? 'Delete repository' : 'Rename aside'}
					{/if}
				</button>
			</div>
		{/if}
	</div>
</dialog>
