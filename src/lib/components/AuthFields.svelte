<script lang="ts">
	import Octicon from "$lib/components/Octicon.svelte";
	import type { UsedIconName as IconName } from "$lib/icons.generated";
	import type { AuthFieldMode } from "$lib/migrate/types";

	let {
		title,
		icon,
		variant = "section",
		envApp,
		envPat,
		allowOverride = true,
		required = false,
		serverBadgeInHeader = false,
		mode = $bindable(),
		token = $bindable(),
		appId = $bindable(),
		installationId = $bindable(),
		appKey = $bindable(),
	}: {
		title?: string;
		icon?: IconName;
		variant?: "section" | "inline";
		envApp: boolean;
		envPat: boolean;
		allowOverride?: boolean;
		required?: boolean;
		serverBadgeInHeader?: boolean;
		mode: AuthFieldMode;
		token: string;
		appId: string;
		installationId: string;
		appKey: string;
	} = $props();

	const hasEnv = $derived(envApp || envPat);
	const envMode = $derived<AuthFieldMode>(envApp ? "env-app" : "env-pat");
	const usingServer = $derived(mode === "env-app" || mode === "env-pat");
	let showToken = $state(false);
	const serverSummary = $derived(
		envApp
			? "Using your administrator's configured GitHub App - no credentials needed."
			: "Using your administrator's configured token - no credentials needed.",
	);

	function useDifferentCredentials() {
		mode = "pat";
	}

	function useServerCredentials() {
		mode = envMode;
	}
</script>

{#if hasEnv && usingServer && serverBadgeInHeader}
	{#if allowOverride}
		<button
			type="button"
			onclick={useDifferentCredentials}
			class="text-xs font-medium text-blue-400 transition-colors hover:text-blue-300"
		>
			Use different credentials
		</button>
	{/if}
{:else}
	<div class="space-y-3">
		{#if variant === "section"}
			<h3 class="inline-flex items-center gap-1.5 text-sm font-medium text-gray-300">
				{#if icon}<Octicon name={icon} size={16} />{/if}{title}
			</h3>
		{:else if !(hasEnv && usingServer)}
			<span class="block text-sm font-medium text-gray-400">Authentication</span>
		{/if}

		{#if hasEnv && usingServer}
			<div class="flex flex-wrap items-center gap-x-3 gap-y-1">
				<span
					class="inline-flex items-center gap-1.5 rounded-full bg-green-500/15 px-2.5 py-1 text-xs font-medium text-green-400"
					title={serverSummary}
				>
					<Octicon name="shield-check" size={12} />
					Authenticated
				</span>
				{#if allowOverride}
					<button
						type="button"
						onclick={useDifferentCredentials}
						class="text-xs font-medium text-blue-400 transition-colors hover:text-blue-300"
					>
						Use different credentials
					</button>
				{/if}
			</div>
		{:else}
			{@render credentialEntry()}
			{#if hasEnv}
				<button
					type="button"
					onclick={useServerCredentials}
					class="text-xs font-medium text-blue-400 transition-colors hover:text-blue-300"
				>
					Use administrator-managed credentials instead
				</button>
			{/if}
		{/if}
	</div>
{/if}

{#snippet credentialEntry()}
	<div class="grid grid-cols-2 rounded-md border border-gray-700 bg-gray-950/40 p-1">
		<button
			type="button"
			aria-pressed={mode === "pat"}
			class="inline-flex items-center justify-center gap-1.5 rounded px-3 py-1.5 text-xs font-medium transition-colors {mode ===
			'pat'
				? 'bg-gray-700 text-gray-50 shadow-sm'
				: 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'}"
			onclick={() => (mode = "pat")}
		>
			<Octicon name="key" size={12} /> PAT
		</button>
		<button
			type="button"
			aria-pressed={mode === "app"}
			class="inline-flex items-center justify-center gap-1.5 rounded px-3 py-1.5 text-xs font-medium transition-colors {mode ===
			'app'
				? 'bg-gray-700 text-gray-50 shadow-sm'
				: 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'}"
			onclick={() => (mode = "app")}
		>
			<Octicon name="apps" size={12} /> GitHub App
		</button>
	</div>
	{#if mode === "app"}
		<div class="space-y-3 rounded-md border border-gray-700 bg-gray-950/30 p-3">
			<div class="grid gap-3 sm:grid-cols-2">
				<label class="block text-xs font-medium text-gray-400">
					App ID
					<input
						type="text"
						{required}
						bind:value={appId}
						placeholder="123456"
						class="mt-1 w-full rounded-md border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-50 placeholder-gray-600 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
					/>
				</label>
				<label class="block text-xs font-medium text-gray-400">
					Installation ID
					<input
						type="text"
						{required}
						bind:value={installationId}
						placeholder="12345678"
						class="mt-1 w-full rounded-md border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-50 placeholder-gray-600 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
					/>
				</label>
			</div>
			<label class="block text-xs font-medium text-gray-400">
				Private key
				<textarea
					{required}
					bind:value={appKey}
					placeholder="-----BEGIN RSA PRIVATE KEY-----"
					rows="3"
					class="mt-1 w-full rounded-md border border-gray-700 bg-gray-800 px-3 py-2 font-mono text-sm text-gray-50 placeholder-gray-600 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
				></textarea>
			</label>
		</div>
	{:else}
		<div class="text-xs font-medium text-gray-400">
			<span>Personal access token</span>
			<span class="mt-1 flex items-center rounded-md border border-gray-700 bg-gray-800 transition-colors focus-within:border-blue-500 focus-within:ring-1 focus-within:ring-blue-500">
				<span class="flex h-9 w-9 shrink-0 items-center justify-center border-r border-gray-700 text-gray-500"><Octicon name="key" size={16} /></span>
				<input
					type={showToken ? "text" : "password"}
					{required}
					bind:value={token}
					placeholder="ghp_..."
					autocomplete="off"
					aria-label="Personal access token"
					class="min-w-0 flex-1 border-0 bg-transparent px-3 py-2 font-mono text-sm text-gray-50 placeholder-gray-600 focus:outline-none"
				/>
				<button
					type="button"
					onclick={() => (showToken = !showToken)}
					aria-label={showToken ? "Hide personal access token" : "Show personal access token"}
					title={showToken ? "Hide token" : "Show token"}
					class="flex h-9 w-9 shrink-0 items-center justify-center border-l border-gray-700 text-gray-500 transition-colors hover:text-gray-200"
				>
					<Octicon name={showToken ? "eye-closed" : "eye"} size={16} />
				</button>
			</span>
			<span class="mt-1.5 block text-xs font-normal text-gray-500">Enter a token authorized for this GitHub host.</span>
		</div>
	{/if}
{/snippet}