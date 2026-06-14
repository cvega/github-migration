<!-- Shared restart-migration modal: dialog shell + auth fields + run options. -->
<!-- Used by the single-migration ([id]) and batch (batches/[id]) detail pages, -->
<!-- which differ only in title, info content, submit label, and a few option -->
<!-- wordings — all passed in as props so neither page's UI text changes. -->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import AuthModeFields from '$lib/components/AuthModeFields.svelte';
	import Octicon from '$lib/components/Octicon.svelte';
	import type { createMigrationForm } from '$lib/migrate/migration-form.svelte';

	let {
		open = $bindable(),
		form,
		submitting,
		error,
		title,
		submitLabel,
		productionLockText,
		directPassthroughLabel = 'Direct passthrough',
		sslVerifyLabel = 'Skip SSL verification',
		visibilityId = 'restart-visibility',
		sourceEnvApp,
		sourceEnvPat,
		targetEnvApp,
		targetEnvPat,
		allowOverride,
		onsubmit,
		info
	}: {
		open: boolean;
		form: ReturnType<typeof createMigrationForm>;
		submitting: boolean;
		error: string;
		title: string;
		submitLabel: string;
		productionLockText: string;
		directPassthroughLabel?: string;
		sslVerifyLabel?: string;
		visibilityId?: string;
		sourceEnvApp: boolean;
		sourceEnvPat: boolean;
		targetEnvApp: boolean;
		targetEnvPat: boolean;
		allowOverride: boolean;
		onsubmit: (e: Event) => void;
		info: Snippet;
	} = $props();

	let dialog = $state<HTMLDialogElement>();

	// Drive the native <dialog> from the bound `open` prop.
	$effect(() => {
		if (open) dialog?.showModal();
		else dialog?.close();
	});
</script>

<dialog
	bind:this={dialog}
	onclose={() => (open = false)}
	onclick={(e) => {
		if (e.target === dialog) dialog?.close();
	}}
	class="m-auto w-[calc(100%-2rem)] max-w-lg max-h-[85vh] overflow-y-auto rounded-lg border border-gray-700 bg-gray-900 text-gray-50 shadow-xl backdrop:bg-black/60 backdrop:backdrop-blur-sm"
>
	<div
		class="sticky top-0 z-10 flex items-center justify-between border-b border-gray-700 bg-gray-900 px-5 py-4"
	>
		<h2 class="flex items-center gap-2 text-lg font-semibold text-gray-50">
			<Octicon name="sync" size={24} />
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

	<form class="space-y-5 p-5" {onsubmit}>
		{@render info()}

		{#if error}
			<div class="rounded-md border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
				{error}
			</div>
		{/if}

		<!-- Source Auth -->
		<AuthModeFields
			title="Source Authentication"
			icon="server"
			envApp={sourceEnvApp}
			envPat={sourceEnvPat}
			{allowOverride}
			bind:mode={form.state.sourceAuthMode}
			bind:token={form.state.sourceToken}
			bind:appId={form.state.sourceAppId}
			bind:installationId={form.state.sourceAppInstallationId}
			bind:appKey={form.state.sourceAppKey}
		/>

		<!-- Target Auth -->
		<AuthModeFields
			title="Target Authentication"
			icon="repo-push"
			envApp={targetEnvApp}
			envPat={targetEnvPat}
			{allowOverride}
			bind:mode={form.state.targetAuthMode}
			bind:token={form.state.targetToken}
			bind:appId={form.state.targetAppId}
			bind:installationId={form.state.targetAppInstallationId}
			bind:appKey={form.state.targetAppKey}
		/>

		<!-- Options -->
		<div class="space-y-3">
			<h3 class="inline-flex items-center gap-1.5 text-sm font-medium text-gray-300">
				<Octicon name="gear" size={16} />Options
			</h3>

			<div>
				<span class="block text-sm font-medium text-gray-400 mb-1.5">Migration Mode</span>
				<div class="flex gap-1 rounded-md bg-gray-800 p-0.5">
					<button
						type="button"
						class="flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors {form.state
							.migrationMode === 'dry-run'
							? 'bg-gray-700 text-gray-50'
							: 'text-gray-400 hover:text-gray-200'}"
						onclick={() => (form.state.migrationMode = 'dry-run')}
					>
						Dry Run
					</button>
					<button
						type="button"
						class="flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors {form.state
							.migrationMode === 'production'
							? 'bg-amber-600 text-white'
							: 'text-gray-400 hover:text-gray-200'}"
						onclick={() => (form.state.migrationMode = 'production')}
					>
						Production
					</button>
				</div>
				{#if form.state.migrationMode === 'production'}
					<div
						class="mt-2 flex items-center gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-400"
					>
						<Octicon name="alert" size={12} class="shrink-0" />
						{productionLockText}
					</div>
				{/if}
			</div>

			<div>
				<label for={visibilityId} class="block text-sm font-medium text-gray-400 mb-1">
					Repository Visibility <span class="text-gray-600">(optional)</span>
				</label>
				<select
					id={visibilityId}
					bind:value={form.state.targetRepoVisibility}
					class="w-full rounded-md border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-50 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
				>
					<option value="">Default</option>
					<option value="private">Private</option>
					<option value="public">Public</option>
					<option value="internal">Internal</option>
				</select>
			</div>

			<label class="flex items-center gap-3">
				<input
					type="checkbox"
					bind:checked={form.state.skipReleases}
					class="rounded border-gray-600 bg-gray-800 text-blue-600 focus:ring-blue-500"
				/>
				<span class="text-sm text-gray-400">Skip releases</span>
			</label>

			<label class="flex items-center gap-3">
				<input
					type="checkbox"
					bind:checked={form.state.directPassthrough}
					class="rounded border-gray-600 bg-gray-800 text-blue-600 focus:ring-blue-500"
				/>
				<span class="text-sm text-gray-400">{directPassthroughLabel}</span>
			</label>

			<label class="flex items-center gap-3">
				<input
					type="checkbox"
					bind:checked={form.state.noSslVerify}
					class="rounded border-gray-600 bg-gray-800 text-blue-600 focus:ring-blue-500"
				/>
				<span class="text-sm text-gray-400">{sslVerifyLabel}</span>
			</label>
		</div>

		<!-- Actions -->
		<div class="flex items-center justify-end gap-3 border-t border-gray-700 pt-4">
			<button
				type="button"
				onclick={() => dialog?.close()}
				class="text-sm text-gray-400 hover:text-gray-50 transition-colors"
			>
				Cancel
			</button>
			<button
				type="submit"
				disabled={submitting}
				class="flex items-center gap-1.5 rounded-md bg-blue-600 px-5 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
			>
				{#if submitting}
					Restarting...
				{:else}
					<Octicon name="sync" size={16} />
					{submitLabel}
				{/if}
			</button>
		</div>
	</form>
</dialog>
