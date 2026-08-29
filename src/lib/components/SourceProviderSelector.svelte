<script lang="ts">
	import type { UsedIconName } from "$lib/icons.generated";
	import { SOURCE_PROVIDERS, type SourceProvider } from "$lib/source-provider";
	import Octicon from "./Octicon.svelte";

	type ProviderAvailability = Partial<Record<SourceProvider, boolean>>;
	type Purpose = "profile" | "migration";
	type Accent = "blue" | "violet";
	type ProviderOption = {
		provider: SourceProvider;
		label: string;
		icon: UsedIconName | "gitlab-logo" | "bitbucket-logo";
		iconClass: string;
		profileDescription: string;
		migrationDescription: string;
	};

	const options = [
		{
			provider: "github",
			label: "GitHub",
			icon: "mark-github",
			iconClass: "bg-gray-700/70 text-gray-100",
			profileDescription: "Organization assessment",
			migrationDescription: "Organizations",
		},
		{
			provider: "gitlab",
			label: "GitLab",
			icon: "gitlab-logo",
			iconClass: "bg-orange-500/10 text-orange-400",
			profileDescription: "Namespace assessment",
			migrationDescription: "Namespaces",
		},
		{
			provider: "bitbucket-server",
			label: "Bitbucket Server",
			icon: "bitbucket-logo",
			iconClass: "bg-blue-500/10 text-blue-400",
			profileDescription: "Project assessment",
			migrationDescription: "Projects",
		},
	] as const satisfies readonly ProviderOption[];

	let {
		value = $bindable(),
		onselect,
		purpose = "profile",
		accent = "violet",
		availability,
		collapseSingleReady = false,
		hideLegend = false,
		name = "source-provider",
	}: {
		value: SourceProvider | "";
		onselect: (provider: SourceProvider) => void;
		purpose?: Purpose;
		accent?: Accent;
		availability?: ProviderAvailability;
		collapseSingleReady?: boolean;
		hideLegend?: boolean;
		name?: string;
	} = $props();

	let expanded = $state(false);
	const readyProviders = $derived(
		availability ? SOURCE_PROVIDERS.filter((provider) => availability[provider]) : [],
	);
	const compactOption = $derived(
		collapseSingleReady && readyProviders.length === 1
			? options.find((option) => option.provider === readyProviders[0])
			: undefined,
	);
	const accentText = $derived(accent === "violet" ? "text-violet-400" : "text-blue-400");

	function description(option: ProviderOption): string {
		return purpose === "profile" ? option.profileDescription : option.migrationDescription;
	}
</script>

<fieldset class="min-w-0" aria-label={hideLegend ? "Source provider" : undefined}>
	{#if !hideLegend}<legend class="mb-1.5 text-xs font-medium uppercase text-gray-500">Source provider</legend>{/if}
	{#if compactOption && !expanded}
		<button
			type="button"
			aria-label="Change source provider"
			aria-expanded="false"
			onclick={() => (expanded = true)}
			class="flex w-full items-center gap-3 rounded-md border border-gray-700 bg-gray-950 px-3 py-2.5 text-left outline-none transition-colors hover:border-gray-600 hover:bg-gray-900 focus-visible:ring-2 {accent ===
			'violet'
				? 'focus-visible:ring-violet-400'
				: 'focus-visible:ring-blue-400'}"
		>
			<span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md {compactOption.iconClass}">
				<Octicon name={compactOption.icon} size={16} />
			</span>
			<span class="min-w-0 flex-1">
				<span class="block text-sm font-semibold text-gray-50">{compactOption.label}</span>
				<span class="block truncate text-xs text-gray-500">{description(compactOption)}</span>
			</span>
			<span class="hidden items-center gap-1.5 text-xs font-medium text-green-400 sm:inline-flex">
				<span class="h-1.5 w-1.5 rounded-full bg-green-400"></span>Ready
			</span>
			<span class="text-xs font-medium {accentText}">Change</span>
		</button>
	{:else}
		<div class="grid divide-y divide-gray-700 overflow-hidden rounded-md border border-gray-700 bg-gray-950 sm:grid-cols-3 sm:divide-x sm:divide-y-0 lg:h-21">
			{#each options as option (option.provider)}
				{@const selected = option.provider === value}
				{@const ready = availability?.[option.provider]}
				<label
					class="relative min-w-0 cursor-pointer px-3 py-3 outline-none transition-colors focus-within:z-10 focus-within:ring-2 focus-within:ring-inset lg:min-h-20 {accent ===
					'violet'
						? 'focus-within:ring-violet-400'
						: 'focus-within:ring-blue-400'} {selected
						? accent === 'violet'
							? 'bg-violet-500/10 shadow-[inset_0_-2px_0_var(--fgColor-done)]'
							: 'bg-blue-500/10 shadow-[inset_0_-2px_0_var(--fgColor-accent)]'
						: 'hover:bg-gray-900'}"
				>
					<input
						class="sr-only"
						type="radio"
						{name}
						value={option.provider}
						bind:group={value}
						aria-label={option.label}
						onchange={() => onselect(option.provider)}
					/>
					<span class="flex items-start gap-2.5">
						<span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md {option.iconClass}">
							<Octicon name={option.icon} size={16} />
						</span>
						<span class="min-w-0 flex-1">
							<span class="flex items-center justify-between gap-2">
								<span class="text-sm font-semibold {selected ? 'text-gray-50' : 'text-gray-300'}">{option.label}</span>
								{#if selected}<Octicon name="check" size={12} class="shrink-0 {accentText}" />{/if}
							</span>
							<span class="mt-0.5 block text-xs text-gray-500">{description(option)}</span>
							{#if availability}
								<span class="mt-1.5 inline-flex items-center gap-1.5 text-[11px] font-medium {ready ? 'text-green-400' : 'text-amber-400'}">
									<span class="h-1.5 w-1.5 rounded-full {ready ? 'bg-green-400' : 'bg-amber-400'}"></span>
									{ready ? "Ready" : "Setup required"}
								</span>
							{/if}
						</span>
					</span>
				</label>
			{/each}
		</div>
	{/if}
</fieldset>