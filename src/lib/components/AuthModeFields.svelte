<!-- Auth-mode toggle + credential fields for a source/target (restart modal style) -->
<script lang="ts">
	import Octicon from '$lib/components/Octicon.svelte';
	import type { IconName } from '@primer/octicons';
	import type { AuthFieldMode } from '$lib/types';

	let {
		title,
		icon,
		envVar,
		envApp,
		envPat,
		envAppId,
		mode = $bindable(),
		token = $bindable(),
		appId = $bindable(),
		installationId = $bindable(),
		appKey = $bindable()
	}: {
		title: string;
		icon: IconName;
		envVar: string;
		envApp: boolean;
		envPat: boolean;
		envAppId: string | undefined;
		mode: AuthFieldMode;
		token: string;
		appId: string;
		installationId: string;
		appKey: string;
	} = $props();
</script>

<div class="space-y-3">
	<h3 class="inline-flex items-center gap-1.5 text-sm font-medium text-gray-300">
		<Octicon name={icon} size={16} />{title}
	</h3>
	<div class="flex gap-1 rounded-md bg-gray-800 p-0.5">
		<button type="button"
			class="flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors {mode === 'pat' ? 'bg-gray-700 text-gray-50' : 'text-gray-400 hover:text-gray-200'}"
			onclick={() => mode = 'pat'}>
			PAT
		</button>
		<button type="button"
			class="flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors {mode === 'app' ? 'bg-gray-700 text-gray-50' : 'text-gray-400 hover:text-gray-200'}"
			onclick={() => mode = 'app'}>
			GitHub App
		</button>
		{#if envApp}
			<button type="button"
				class="flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors {mode === 'env-app' ? 'bg-blue-600/30 text-blue-400' : 'text-gray-400 hover:text-gray-200'}"
				onclick={() => mode = 'env-app'}>
				Env App
			</button>
		{/if}
		{#if envPat}
			<button type="button"
				class="flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors {mode === 'env-pat' ? 'bg-blue-600/30 text-blue-400' : 'text-gray-400 hover:text-gray-200'}"
				onclick={() => mode = 'env-pat'}>
				Env PAT
			</button>
		{/if}
	</div>
	{#if mode === 'pat'}
		<input type="password" bind:value={token} placeholder="ghp_..."
			class="w-full rounded-md border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-50 placeholder-gray-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" />
	{:else if mode === 'app'}
		<div class="space-y-2 rounded-md border border-gray-700/50 bg-gray-800/50 p-3">
			<input type="text" bind:value={appId} placeholder="App ID"
				class="w-full rounded-md border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-50 placeholder-gray-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" />
			<input type="text" bind:value={installationId} placeholder="Installation ID"
				class="w-full rounded-md border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-50 placeholder-gray-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" />
			<textarea bind:value={appKey} placeholder="Private Key (PEM)" rows="3"
				class="w-full rounded-md border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-50 placeholder-gray-500 font-mono focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"></textarea>
		</div>
	{:else if mode === 'env-app'}
		<p class="text-xs text-blue-400/80">Using server-configured GitHub App (App ID: {envAppId ?? '—'}).</p>
	{:else}
		<p class="text-xs text-blue-400/80">Using server-configured PAT ({envVar}).</p>
	{/if}
</div>
