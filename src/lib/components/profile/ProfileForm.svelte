<script lang="ts">
	import { goto } from "$app/navigation";
	import Octicon from "$lib/components/Octicon.svelte";
	import {
		getSourceProviderAdapter,
		SOURCE_PROVIDERS,
		type SourceProvider,
	} from "$lib/source-provider";

	let {
		providerAuthAvailable,
		sourceOrgs,
		bitbucketProjectKeys,
	}: {
		providerAuthAvailable: Record<SourceProvider, boolean>;
		sourceOrgs: string[];
		bitbucketProjectKeys: string[];
	} = $props();

	const options = [
		{
			provider: "github",
			label: "GitHub",
			icon: "mark-github",
			description: "Organization profile",
		},
		{
			provider: "gitlab",
			label: "GitLab",
			icon: "gitlab-logo",
			description: "Namespace profile",
		},
		{
			provider: "bitbucket-server",
			label: "Bitbucket Server",
			icon: "bitbucket-logo",
			description: "Project profile",
		},
	] as const;

	let org = $state("");
	let sourceProvider = $state<SourceProvider>(
		SOURCE_PROVIDERS.find((provider) => providerAuthAvailable[provider]) ?? "github",
	);
	let submitting = $state(false);
	let error = $state("");
	const authAvailable = $derived(providerAuthAvailable[sourceProvider]);
	const sourceAdapter = $derived(getSourceProviderAdapter(sourceProvider));

	function selectProvider(provider: SourceProvider): void {
		sourceProvider = provider;
		org = "";
		error = "";
	}

	async function startProfile(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		const namespace = org.trim();
		if (!namespace) return;
		submitting = true;
		error = "";
		try {
			const response = await fetch("/api/profile", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ sourceProvider, org: namespace }),
			});
			if (!response.ok) {
				const body = (await response.json().catch(() => ({}))) as { error?: string };
				error = body.error ?? `HTTP ${response.status}`;
				return;
			}
			const run = (await response.json()) as { id: string };
			await goto(`/profile/${run.id}`);
		} catch (cause) {
			error = cause instanceof Error ? cause.message : "Failed to start profile";
		} finally {
			submitting = false;
		}
	}
</script>

<section id="start-profile" class="scroll-mt-4 rounded-lg border border-gray-700 bg-gray-900 p-5">
	<fieldset class="mb-4 min-w-0">
		<legend class="mb-1.5 text-xs font-medium uppercase text-gray-500">Source provider</legend>
		<div class="grid overflow-hidden rounded-md border border-gray-700 bg-gray-950 sm:grid-cols-3 sm:divide-x sm:divide-gray-700">
			{#each options as option (option.provider)}
				{@const selected = option.provider === sourceProvider}
				{@const ready = providerAuthAvailable[option.provider]}
				<label
					class="relative min-w-0 cursor-pointer border-b border-gray-700 px-3 py-3 transition-colors last:border-b-0 focus-within:ring-2 focus-within:ring-inset focus-within:ring-green-400 sm:border-b-0 {selected ? 'bg-green-500/10 shadow-[inset_0_-2px_0_var(--color-green-500)]' : 'hover:bg-gray-900'}"
				>
					<input
						class="sr-only"
						type="radio"
						name="source-provider"
						value={option.provider}
						checked={selected}
						onchange={() => selectProvider(option.provider)}
					/>
					<span class="flex items-start gap-2.5">
						<span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-gray-800 text-gray-200">
							<Octicon name={option.icon} size={16} />
						</span>
						<span class="min-w-0 flex-1">
							<span class="block text-sm font-semibold {selected ? 'text-gray-50' : 'text-gray-300'}">{option.label}</span>
							<span class="mt-0.5 block text-xs text-gray-500">{option.description}</span>
							<span class="mt-1.5 inline-flex items-center gap-1.5 text-xs font-medium {ready ? 'text-green-400' : 'text-amber-400'}">
								<span class="h-1.5 w-1.5 rounded-full {ready ? 'bg-green-400' : 'bg-amber-400'}"></span>
								{ready ? "Ready" : "Setup required"}
							</span>
						</span>
					</span>
				</label>
			{/each}
		</div>
	</fieldset>

	{#if authAvailable}
		<form onsubmit={startProfile} class="flex flex-wrap items-end gap-3">
			<div class="min-w-64 flex-1">
				<label for="profile-org" class="mb-1 block text-sm font-medium text-gray-300">
					{sourceAdapter.displayName} {sourceAdapter.namespaceLabel}
				</label>
				<input
					id="profile-org"
					list={sourceProvider === "github"
						? "source-orgs"
						: sourceProvider === "bitbucket-server"
							? "bitbucket-project-keys"
							: undefined}
					bind:value={org}
					placeholder={sourceProvider === "gitlab"
						? "group/subgroup"
						: sourceProvider === "bitbucket-server"
							? "PROJECT"
							: "octo-org"}
					autocomplete="off"
					class="w-full rounded-md border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-gray-50 placeholder:text-gray-600 focus:border-green-500 focus:outline-none"
				/>
				{#if sourceProvider === "github" && sourceOrgs.length > 0}
					<datalist id="source-orgs">
						{#each sourceOrgs as sourceOrg (sourceOrg)}<option value={sourceOrg}></option>{/each}
					</datalist>
				{/if}
				{#if sourceProvider === "bitbucket-server" && bitbucketProjectKeys.length > 0}
					<datalist id="bitbucket-project-keys">
						{#each bitbucketProjectKeys as key (key)}<option value={key}></option>{/each}
					</datalist>
				{/if}
			</div>
			<button
				type="submit"
				disabled={submitting || !org.trim()}
				class="inline-flex items-center gap-1.5 rounded-md bg-green-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-green-500 disabled:cursor-not-allowed disabled:opacity-50"
			>
				<Octicon name={submitting ? "sync" : "play"} size={16} class={submitting ? "animate-spin" : ""} />
				{submitting ? "Starting..." : "Start profile"}
			</button>
		</form>
		{#if error}
			<p class="mt-3 flex items-center gap-1.5 text-sm text-red-400" role="alert">
				<Octicon name="alert" size={16} />{error}
			</p>
		{/if}
	{:else}
		<p class="flex items-center gap-2 text-sm text-gray-400">
			<Octicon name="shield-lock" size={16} class="text-gray-500" />
			{sourceAdapter.displayName} source credentials must be configured on the server before a profile can start.
		</p>
	{/if}
</section>