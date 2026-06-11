<!-- Auth-mode fields for a source/target (new-migration form + restart modals).

     When the server already has env-configured credentials for this side, we
     show a clean "authenticated by the server" summary instead of exposing the
     PAT / GitHub App toggle. If credential override is allowed, the operator
     can still switch to manual credentials; when the admin disables override
     (GH_ALLOW_CREDENTIAL_OVERRIDE=false) the side is locked to server creds.

     A side with no env credentials always shows the manual PAT / App entry. -->
<script lang="ts">
	import Octicon from '$lib/components/Octicon.svelte';
	import type { IconName } from '@primer/octicons';
	import type { AuthFieldMode } from '$lib/types';

	let {
		title,
		icon,
		variant = 'section',
		envApp,
		envPat,
		allowOverride = true,
		required = false,
		mode = $bindable(),
		token = $bindable(),
		appId = $bindable(),
		installationId = $bindable(),
		appKey = $bindable()
	}: {
		/** Section heading text (used when variant === 'section'). */
		title?: string;
		/** Section heading icon (used when variant === 'section'). */
		icon?: IconName;
		/** 'section' renders a titled heading (modals); 'inline' a small label. */
		variant?: 'section' | 'inline';
		envApp: boolean;
		envPat: boolean;
		/** Whether the user may override server credentials with their own. */
		allowOverride?: boolean;
		/** Mark manual credential inputs as required (primary create form). */
		required?: boolean;
		mode: AuthFieldMode;
		token: string;
		appId: string;
		installationId: string;
		appKey: string;
	} = $props();

	// Does the server have any env credentials configured for this side?
	const hasEnv = $derived(envApp || envPat);
	// Fallback server mode (a configured App takes precedence over a PAT).
	const envMode = $derived<AuthFieldMode>(envApp ? 'env-app' : 'env-pat');
	// Currently relying on the server's credentials (no user input needed).
	const usingServer = $derived(mode === 'env-app' || mode === 'env-pat');

	const serverSummary = $derived(
		envApp
			? "Authenticated using the server's configured GitHub App — no credentials needed."
			: "Authenticated using the server's configured token — no credentials needed."
	);

	function useDifferentCredentials() {
		mode = 'pat';
	}
	function useServerCredentials() {
		mode = envMode;
	}
</script>

<div class="space-y-3">
	{#if variant === 'section'}
		<h3 class="inline-flex items-center gap-1.5 text-sm font-medium text-gray-300">
			{#if icon}<Octicon name={icon} size={16} />{/if}{title}
		</h3>
	{:else}
		<span class="block text-sm font-medium text-gray-400">Authentication</span>
	{/if}

	{#if hasEnv && usingServer}
		<!-- Server-configured credentials: informative, no toggle required. -->
		<div class="flex items-start gap-2 rounded-md border border-blue-500/20 bg-blue-500/5 px-3 py-2.5">
			<Octicon name="shield-check" size={16} class="mt-0.5 shrink-0 text-blue-400" />
			<div class="min-w-0 text-sm">
				<p class="text-gray-300">{serverSummary}</p>
				{#if allowOverride}
					<button type="button" onclick={useDifferentCredentials}
						class="mt-1 text-xs font-medium text-blue-400 hover:text-blue-300 transition-colors">
						Use different credentials
					</button>
				{/if}
			</div>
		</div>
	{:else}
		{@render credentialEntry()}
		{#if hasEnv}
			<button type="button" onclick={useServerCredentials}
				class="text-xs font-medium text-blue-400 hover:text-blue-300 transition-colors">
				Use the server&rsquo;s credentials instead
			</button>
		{/if}
	{/if}
</div>

{#snippet credentialEntry()}
	<div class="flex gap-1 rounded-md bg-gray-800 p-0.5">
		<button type="button"
			class="flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors {mode === 'pat' ? 'bg-gray-700 text-gray-50' : 'text-gray-400 hover:text-gray-200'}"
			onclick={() => (mode = 'pat')}>
			PAT
		</button>
		<button type="button"
			class="flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors {mode === 'app' ? 'bg-gray-700 text-gray-50' : 'text-gray-400 hover:text-gray-200'}"
			onclick={() => (mode = 'app')}>
			GitHub App
		</button>
	</div>
	{#if mode === 'app'}
		<div class="space-y-2 rounded-md border border-gray-700/50 bg-gray-800/50 p-3">
			<input type="text" {required} bind:value={appId} placeholder="App ID" aria-label="App ID"
				class="w-full rounded-md border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-50 placeholder-gray-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" />
			<input type="text" {required} bind:value={installationId} placeholder="Installation ID" aria-label="Installation ID"
				class="w-full rounded-md border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-50 placeholder-gray-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" />
			<textarea {required} bind:value={appKey} placeholder="Private Key (PEM)" aria-label="Private Key (PEM)" rows="3"
				class="w-full rounded-md border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-50 placeholder-gray-500 font-mono focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"></textarea>
		</div>
	{:else}
		<input type="password" {required} bind:value={token} placeholder="ghp_..." aria-label="Personal access token"
			class="w-full rounded-md border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-50 placeholder-gray-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" />
	{/if}
{/snippet}
