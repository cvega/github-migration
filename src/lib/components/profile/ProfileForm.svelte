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
			iconClass: "bg-gray-700/70 text-gray-100",
			description: "Organization profile",
		},
		{
			provider: "gitlab",
			label: "GitLab",
			icon: "gitlab-logo",
			iconClass: "bg-orange-500/10 text-orange-400",
			description: "Namespace profile",
		},
		{
			provider: "bitbucket-server",
			label: "Bitbucket Server",
			icon: "bitbucket-logo",
			iconClass: "bg-blue-500/10 text-blue-400",
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
	const selectedOption = $derived(options.find((option) => option.provider === sourceProvider) ?? options[0]);

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

<section id="start-profile" class="scroll-mt-4 overflow-hidden rounded-md border border-gray-700 bg-gray-900">
	<header class="border-b border-gray-700 px-4 py-3">
		<h2 class="text-sm font-semibold text-gray-100">Start a new profile</h2>
		<p class="mt-0.5 text-xs text-gray-500">Choose a source and enter the namespace to analyze.</p>
	</header>

	<div class="grid md:grid-cols-[15rem_minmax(0,1fr)]">
		<fieldset class="min-w-0 border-b border-gray-700 p-3 md:border-r md:border-b-0">
			<legend class="sr-only">Source provider</legend>
			<div class="space-y-1">
				{#each options as option (option.provider)}
					{@const selected = option.provider === sourceProvider}
					{@const ready = providerAuthAvailable[option.provider]}
					<label
						class="relative flex min-w-0 cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 outline-none transition-colors focus-within:ring-2 focus-within:ring-blue-400 {selected ? 'bg-gray-800' : 'hover:bg-gray-800/60'}"
					>
						<input
							class="sr-only"
							type="radio"
							name="source-provider"
							value={option.provider}
							checked={selected}
							onchange={() => selectProvider(option.provider)}
						/>
						<span class="flex size-8 shrink-0 items-center justify-center rounded-md {option.iconClass}">
							<Octicon name={option.icon} size={16} />
						</span>
						<span class="min-w-0 flex-1">
							<span class="block truncate text-sm font-semibold {selected ? 'text-gray-50' : 'text-gray-300'}">{option.label}</span>
							<span class="mt-0.5 flex items-center gap-1.5 text-xs {ready ? 'text-green-400' : 'text-amber-400'}">
								<span class="size-1.5 rounded-full {ready ? 'bg-green-400' : 'bg-amber-400'}"></span>
								{ready ? "Ready" : "Setup required"}
							</span>
						</span>
						{#if selected}<Octicon name="check" size={16} class="shrink-0 text-blue-400" />{/if}
					</label>
				{/each}
			</div>
		</fieldset>

		<div class="min-w-0 p-4 sm:p-5">
			<div class="flex flex-col items-start gap-3 sm:flex-row sm:justify-between sm:gap-4">
				<div class="flex min-w-0 items-center gap-3">
					<span class="flex size-11 shrink-0 items-center justify-center rounded-md ring-1 ring-inset ring-gray-700 {selectedOption.iconClass}">
						<Octicon name={selectedOption.icon} size={24} />
					</span>
					<div class="min-w-0">
						<h3 class="truncate text-lg font-semibold text-gray-50">{sourceAdapter.displayName}</h3>
						<p class="mt-0.5 text-sm text-gray-400">{selectedOption.description}</p>
					</div>
				</div>
				<span class="inline-flex shrink-0 items-center gap-1.5 text-xs font-medium {authAvailable ? 'text-green-400' : 'text-amber-400'}">
					<Octicon name={authAvailable ? "check-circle-fill" : "alert"} size={12} />
					{authAvailable ? "Credentials configured" : "Setup required"}
				</span>
			</div>

			{#if authAvailable}
				<form onsubmit={startProfile} class="mt-5 flex flex-wrap items-end gap-3 border-t border-gray-700 pt-4">
					<div class="min-w-0 flex-[1_1_16rem]">
						<label for="profile-org" class="mb-1.5 block text-sm font-medium text-gray-200">
							{sourceAdapter.namespaceLabel}
						</label>
						<div class="flex h-10 overflow-hidden rounded-md border border-gray-600 bg-gray-950 transition-colors focus-within:border-blue-500 focus-within:ring-1 focus-within:ring-blue-500">
							<span class="flex w-10 shrink-0 items-center justify-center border-r border-gray-700 text-gray-500">
								<Octicon name={selectedOption.icon} size={16} />
							</span>
							<input
								id="profile-org"
								list={sourceProvider === "github"
									? "source-orgs"
									: sourceProvider === "bitbucket-server"
										? "bitbucket-project-keys"
										: undefined}
								bind:value={org}
								required
								placeholder={sourceProvider === "gitlab"
									? "group/subgroup"
									: sourceProvider === "bitbucket-server"
										? "PROJECT"
										: "octo-org"}
								autocomplete="off"
								class="min-w-0 flex-1 bg-transparent px-3 text-sm text-gray-50 outline-none placeholder:text-gray-600"
							/>
						</div>
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
						class="inline-flex h-10 items-center gap-1.5 rounded-md bg-green-600 px-4 text-sm font-semibold text-white transition-colors hover:bg-green-500 disabled:cursor-not-allowed disabled:opacity-50"
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
				<p class="mt-5 flex items-center gap-2 rounded-md border border-amber-500/20 bg-amber-500/5 p-3 text-sm text-gray-300">
					<Octicon name="shield-lock" size={16} class="shrink-0 text-amber-400" />
					{sourceAdapter.displayName} source credentials must be configured on the server before a profile can start.
				</p>
			{/if}
		</div>
	</div>
</section>