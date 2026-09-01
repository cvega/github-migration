<script lang="ts">
	import Octicon from "$lib/components/Octicon.svelte";
	import SourceProviderSelector from "$lib/components/SourceProviderSelector.svelte";
	import type { NewMigrationController } from "./workflow.svelte";

	let { controller }: { controller: NewMigrationController } = $props();

	const selectedEndpoints = $derived(
		Number(controller.sourceProvider !== "") + Number(!!controller.selectedTargetProfile),
	);
	const canContinue = $derived(
		controller.sourceProvider !== "" &&
			!!controller.selectedTargetProfile &&
			controller.targetRouteReadiness(controller.selectedTargetProfile) === null,
	);
</script>

<section class="overflow-hidden rounded-md border border-gray-700 bg-gray-950">
	<div
		class="flex flex-col gap-3 border-b border-gray-700 bg-gray-900/70 px-6 py-5 sm:flex-row sm:items-center sm:justify-between lg:px-7 lg:py-6"
	>
		<div>
			<h2 class="text-base font-semibold text-gray-50">Choose source and target</h2>
			<p class="mt-1 text-sm text-gray-400">
				Compatible targets appear after you select the source platform.
			</p>
		</div>
		<div class="flex items-center gap-2 text-xs text-gray-500">
			<Octicon name="git-branch" size={16} />
			{selectedEndpoints} of 2 endpoints selected
		</div>
	</div>

	<div
		class="grid gap-6 p-6 lg:p-8 min-[1120px]:grid-cols-[minmax(0,2fr)_4rem_minmax(0,1fr)] min-[1120px]:gap-0"
	>
		<div class="min-w-0">
			<div class="mb-4 flex items-center justify-between">
				<h3 class="text-xs font-semibold uppercase text-gray-500">Source</h3>
				<span class="text-xs font-medium text-blue-400">Required</span>
			</div>
			<SourceProviderSelector
				bind:value={controller.sourceProvider}
				onselect={(provider) => controller.selectSourceProvider(provider)}
				purpose="migration"
				accent="blue"
				hideLegend
			/>
		</div>

		<div class="flex items-center justify-center text-gray-600">
			<span class="min-[1120px]:hidden"><Octicon name="arrow-down" size={16} /></span>
			<span class="hidden min-[1120px]:block"><Octicon name="arrow-right" size={16} /></span>
		</div>

		<div class="min-w-0">
			<div class="mb-4 flex items-center justify-between">
				<h3 class="text-xs font-semibold uppercase text-gray-500">Target</h3>
				<span
					class="text-xs font-medium {controller.sourceProvider
						? 'text-blue-400'
						: 'text-gray-600'}"
				>
					{controller.sourceProvider ? "Required" : "Choose source first"}
				</span>
			</div>
			{#if !controller.sourceProvider}
				<div
					class="flex h-21 items-center justify-center rounded-md border border-dashed border-gray-700 bg-gray-900/50 px-6 text-center text-sm text-gray-500"
				>
					Select a source platform to reveal compatible targets.
				</div>
			{:else if controller.targetProfiles.length === 0}
				<div
					role="alert"
					class="flex h-21 items-center rounded-md border border-amber-500/30 bg-amber-500/10 px-4 text-sm text-amber-300"
				>
					No configured target supports this source platform.
				</div>
			{:else}
				<div
					class="divide-y divide-gray-700 overflow-hidden rounded-md border border-gray-700 bg-gray-950 lg:h-21"
				>
					{#each controller.targetProfiles as profile (profile.id)}
						{@const readiness = controller.targetRouteReadiness(profile)}
						<button
							type="button"
							aria-pressed={controller.targetProfileId === profile.id}
							disabled={readiness !== null}
							onclick={() => controller.selectTargetProfile(profile.id)}
							class="relative flex min-h-[67px] w-full items-center gap-2.5 px-3 py-3 text-left outline-none transition-colors focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-400 disabled:cursor-not-allowed disabled:opacity-55 lg:h-full lg:min-h-0 {controller
								.targetProfileId === profile.id
								? 'bg-blue-500/10 shadow-[inset_0_-2px_0_var(--fgColor-accent)]'
								: 'hover:bg-gray-900'}"
						>
							<span
								class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-gray-700/70 text-gray-100"
							>
								<Octicon name="mark-github" size={16} />
							</span>
							<span class="min-w-0 flex-1">
								<span class="block text-sm font-semibold text-gray-100"
									>{controller.targetDisplayName(profile)}</span
								>
								<span
									class="mt-0.5 block truncate text-xs {readiness
										? 'text-amber-400'
										: 'text-gray-500'}"
								>
									{readiness ??
										(profile.organizations.length > 0
											? `${profile.organizations.length} configured organization${profile.organizations.length === 1 ? "" : "s"}`
											: "Organization entered during configuration")}
								</span>
							</span>
							{#if controller.targetProfileId === profile.id}
								<Octicon name="check" size={12} class="shrink-0 text-blue-400" />
							{/if}
						</button>
					{/each}
				</div>
			{/if}
		</div>
	</div>

	{#if controller.issues.length > 0}
		<div
			role="alert"
			class="mx-6 mb-6 rounded-md border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400 lg:mx-8 lg:mb-8"
		>
			{controller.issues[0]?.message}
		</div>
	{/if}

	<footer
		class="flex flex-col gap-5 border-t border-gray-700 px-6 py-5 sm:flex-row sm:items-center sm:justify-between lg:px-8 lg:py-6"
	>
		<div>
			<p class="text-sm font-medium text-gray-200">
				{canContinue ? "Path selected" : "Select both endpoints to continue"}
			</p>
			<p class="mt-0.5 text-xs text-gray-500">
				Repository and credential fields are configured next.
			</p>
		</div>
		<div class="flex gap-2">
			<a
				href="/migrate"
				class="inline-flex h-10 items-center justify-center rounded-md border border-gray-600 px-4 text-sm font-medium text-gray-300 transition-colors hover:bg-gray-800 hover:text-gray-50"
				>Cancel</a
			>
			<button
				type="button"
				disabled={!canContinue}
				onclick={() => controller.goForward()}
				class="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-green-600 px-5 text-sm font-semibold text-white transition-colors hover:bg-green-500 disabled:cursor-not-allowed disabled:bg-gray-800 disabled:text-gray-500"
			>
				Continue
				<Octicon name="arrow-right" size={16} />
			</button>
		</div>
	</footer>
</section>