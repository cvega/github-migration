<script lang="ts">
	import type { Snippet } from "svelte";
	import AuthFields from "$lib/components/AuthFields.svelte";
	import Octicon from "$lib/components/Octicon.svelte";
	import type { createMigrationForm } from "$lib/migrate/migration-form.svelte";
	import type { Migration } from "$lib/migrate/types";
	import { getSourceProviderAdapter } from "$lib/source-provider";

	let {
		open = $bindable(),
		form,
		submitting,
		error,
		title,
		submitLabel,
		sourceProvider = "github",
		productionLockText,
		directPassthroughLabel = "Direct transfer",
		sslVerifyLabel = "Skip SSL verification",
		visibilityId = "restart-visibility",
		sourceEnvApp,
		sourceEnvPat,
		targetEnvApp,
		targetEnvPat,
		allowOverride,
		onsubmit,
		info,
	}: {
		open: boolean;
		form: ReturnType<typeof createMigrationForm>;
		submitting: boolean;
		error: string;
		title: string;
		submitLabel: string;
		sourceProvider?: Migration["sourceProvider"] | null;
		productionLockText: string;
		directPassthroughLabel?: string;
		sslVerifyLabel?: string;
		visibilityId?: string;
		sourceEnvApp: boolean;
		sourceEnvPat: boolean;
		targetEnvApp: boolean;
		targetEnvPat: boolean;
		allowOverride: boolean;
		onsubmit: (event: SubmitEvent) => void;
		info: Snippet;
	} = $props();

	const capabilities = $derived(
		getSourceProviderAdapter(sourceProvider ?? "github").capabilities,
	);

	function openDialog(node: HTMLDialogElement) {
		node.showModal();
	}
</script>

{#if open}
	<dialog
		{@attach openDialog}
		aria-labelledby="migration-form-title"
		oncancel={(event) => {
			if (submitting) event.preventDefault();
		}}
		onclose={() => (open = false)}
		onclick={(event) => {
			if (event.target === event.currentTarget && !submitting) event.currentTarget.close();
		}}
		class="m-auto max-h-[85vh] w-[calc(100%-2rem)] max-w-lg overflow-y-auto rounded-lg border border-gray-700 bg-gray-900 text-gray-50 shadow-xl backdrop:bg-black/60 backdrop:backdrop-blur-sm"
	>
		<div
			class="sticky top-0 z-10 flex items-center justify-between border-b border-gray-700 bg-gray-900 px-5 py-4"
		>
			<h2 id="migration-form-title" class="flex items-center gap-2 text-lg font-semibold text-gray-50">
				<Octicon name="sync" size={24} />{title}
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

		<form class="space-y-5 p-5" {onsubmit}>
			{@render info()}

			{#if error}
				<div
					role="alert"
					class="rounded-md border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400"
				>
					{error}
				</div>
			{/if}

			{#if capabilities.requestSourceCredentials}
				<AuthFields
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
			{/if}

			<AuthFields
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

			<div class="space-y-3">
				<h3 class="inline-flex items-center gap-1.5 text-sm font-medium text-gray-300">
					<Octicon name="gear" size={16} />Options
				</h3>

				{#if capabilities.migrationMode}
					<div>
						<span class="mb-1.5 block text-sm font-medium text-gray-400">Migration Mode</span>
						<div class="flex gap-1 rounded-md bg-gray-800 p-0.5">
							<button
								type="button"
								aria-pressed={form.state.migrationMode === "dry-run"}
								class="flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors {form.state
									.migrationMode === 'dry-run'
									? 'bg-gray-700 text-gray-50'
									: 'text-gray-400 hover:text-gray-200'}"
								onclick={() => (form.state.migrationMode = "dry-run")}
							>
								Dry Run
							</button>
							<button
								type="button"
								aria-pressed={form.state.migrationMode === "production"}
								class="flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors {form.state
									.migrationMode === 'production'
									? 'bg-amber-600 text-white'
									: 'text-gray-400 hover:text-gray-200'}"
								onclick={() => (form.state.migrationMode = "production")}
							>
								Production
							</button>
						</div>
						{#if form.state.migrationMode === "production"}
							<div
								class="mt-2 flex items-center gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-400"
							>
								<Octicon name="alert" size={12} class="shrink-0" />{productionLockText}
							</div>
						{/if}
					</div>
				{/if}

				<div>
					<label for={visibilityId} class="mb-1 block text-sm font-medium text-gray-400">
						Repository Visibility <span class="text-gray-600">(optional)</span>
					</label>
					<select
						id={visibilityId}
						bind:value={form.state.targetRepoVisibility}
						class="w-full rounded-md border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-50 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
					>
						<option value="">Default</option>
						<option value="private">Private</option>
						<option value="public">Public</option>
						<option value="internal">Internal</option>
					</select>
				</div>

				{#if capabilities.skipReleases}
					<label class="flex items-center gap-3">
						<input type="checkbox" bind:checked={form.state.skipReleases} />
						<span class="text-sm text-gray-400">Skip releases</span>
					</label>
				{/if}
				{#if capabilities.directPassthrough}
					<label class="flex items-center gap-3">
						<input type="checkbox" bind:checked={form.state.directPassthrough} />
						<span class="text-sm text-gray-400">{directPassthroughLabel}</span>
					</label>
				{/if}
				{#if capabilities.sourceTlsBypass}
					<label class="flex items-center gap-3">
						<input type="checkbox" bind:checked={form.state.noSslVerify} />
						<span class="text-sm text-gray-400">{sslVerifyLabel}</span>
					</label>
				{/if}
			</div>

			<div class="flex items-center justify-end gap-3 border-t border-gray-700 pt-4">
				<button
					type="button"
					onclick={(event) => event.currentTarget.closest("dialog")?.close()}
					disabled={submitting}
					class="text-sm text-gray-400 transition-colors hover:text-gray-50"
				>
					Cancel
				</button>
				<button
					type="submit"
					disabled={submitting}
					class="flex items-center gap-1.5 rounded-md bg-blue-600 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
				>
					{#if submitting}Restarting...{:else}<Octicon name="sync" size={16} />{submitLabel}{/if}
				</button>
			</div>
		</form>
	</dialog>
{/if}