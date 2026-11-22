<script lang="ts">
	import Octicon from "$lib/components/Octicon.svelte";
	import { getSourceProviderAdapter } from "$lib/source-provider";
	import LaunchConfirm from "./LaunchConfirm.svelte";
	import MappingReview from "./MappingReview.svelte";
	import SourceHandling from "./SourceHandling.svelte";
	import type { NewMigrationController } from "./workflow.svelte";

	let { controller }: { controller: NewMigrationController } = $props();
	let repositoryReviewOpen = $state(false);
	const capabilities = $derived(
		getSourceProviderAdapter(controller.sourceProvider || "github").capabilities,
	);

</script>

<section class="overflow-hidden rounded-md border border-gray-700 border-t-2 border-t-green-500 bg-gray-950">
	<header
		class="flex flex-col gap-5 border-b border-gray-700 bg-gray-900/55 px-5 py-5 sm:flex-row sm:items-center sm:justify-between lg:px-7 lg:py-6"
	>
		<div class="flex min-w-0 items-start gap-3">
			<span
				class="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-green-500/15 text-green-400"
			>
				<Octicon name="check-circle-fill" size={24} />
			</span>
			<div class="min-w-0">
				<div class="flex flex-wrap items-center gap-2">
					<h2 class="text-lg font-semibold text-gray-50">Ready to launch</h2>
					<span class="text-xs font-medium text-green-400">All checks passed</span>
				</div>
				<p class="mt-1 text-sm text-gray-400">
					Review the route and repository destination before starting.
				</p>
			</div>
		</div>
		<div class="shrink-0 sm:text-right">
			<p class="text-2xl font-semibold text-gray-50">{controller.reviewModel.repositoryCount}</p>
			<p class="text-xs text-gray-500">
				{controller.reviewModel.repositoryCount === 1 ? "repository" : "repositories"}
			</p>
		</div>
	</header>

	<div class="grid lg:grid-cols-[minmax(0,1fr)_20rem]">
		<div class="min-w-0">
			<section class="border-b border-gray-700 px-5 py-6 lg:px-7">
				<h3 class="text-xs font-semibold uppercase text-gray-500">Migration path</h3>
				<div
					class="mt-4 grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] sm:items-center sm:gap-5"
				>
					<div class="flex min-w-0 items-center gap-3">
						<span
							class="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-gray-800 text-gray-100"
						>
							<Octicon
								name={controller.sourceProvider === "github"
									? "mark-github"
									: controller.sourceProvider === "gitlab"
										? "gitlab-logo"
										: "bitbucket-logo"}
								size={24}
							/>
						</span>
						<div class="min-w-0">
							<p class="text-xs font-medium uppercase text-gray-500">Source</p>
							<p class="mt-0.5 truncate text-base font-semibold text-gray-100">
								{controller.sourcePlatformLabel}
							</p>
						</div>
					</div>

					<div class="flex items-center justify-center gap-2 text-gray-600">
						<span class="h-px w-5 bg-gray-700"></span>
						<span class="rotate-90 sm:rotate-0"><Octicon name="arrow-right" size={16} /></span>
						<span class="h-px w-5 bg-gray-700"></span>
					</div>

					<div class="flex min-w-0 items-center gap-3 sm:justify-end">
						<span
							class="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-gray-800 text-gray-100"
						>
							<Octicon name="mark-github" size={24} />
						</span>
						<div class="min-w-0 sm:text-right">
							<p class="text-xs font-medium uppercase text-gray-500">Target</p>
							<p class="mt-0.5 truncate text-base font-semibold text-gray-100">
								{controller.selectedTargetProfile
									? controller.targetDisplayName(controller.selectedTargetProfile)
									: "GitHub"}
							</p>
						</div>
					</div>
				</div>
			</section>

			<section class="px-5 py-6 lg:px-7">
				<div class="flex flex-wrap items-end justify-between gap-3">
					<div>
						<h3 class="text-xs font-semibold uppercase text-gray-500">Repository mappings</h3>
						<p class="mt-1 text-sm text-gray-400">Resolved source and destination names.</p>
					</div>
					{#if controller.mode === "batch"}
						<button
							type="button"
							onclick={() => (repositoryReviewOpen = true)}
							class="inline-flex h-9 items-center gap-2 rounded-md border border-gray-600 px-3 text-xs font-medium text-gray-300 transition-colors hover:bg-gray-800 hover:text-gray-50"
						>
							<Octicon name="list-unordered" size={16} />
							Review all {controller.reviewModel.repositoryCount}
						</button>
					{/if}
				</div>

				<div class="mt-4 overflow-hidden rounded-md border border-gray-700 bg-gray-900/45">
					<div
						class="hidden grid-cols-[minmax(0,1fr)_2rem_minmax(0,1fr)] border-b border-gray-700 px-4 py-2 text-xs font-medium uppercase text-gray-500 sm:grid"
					>
						<span>Source repository</span>
						<span></span>
						<span>Target repository</span>
					</div>
					<div class="divide-y divide-gray-700">
						{#each controller.reviewModel.repositoryMappings as mapping, index (`${mapping.source}:${index}`)}
							<div
								class="grid gap-2 px-4 py-3.5 text-sm sm:grid-cols-[minmax(0,1fr)_2rem_minmax(0,1fr)] sm:items-center sm:gap-0"
							>
								<span class="truncate font-mono text-gray-300">{mapping.source}</span>
								<span class="hidden justify-self-center text-gray-600 sm:block">
									<Octicon name="arrow-right" size={12} />
								</span>
								<span class="truncate font-mono font-medium text-gray-100">{mapping.target}</span>
							</div>
						{/each}
					</div>
				</div>
				{#if controller.reviewModel.additionalRepositoryCount > 0}
					<p class="mt-2 text-xs text-gray-500">
						+ {controller.reviewModel.additionalRepositoryCount} more
					</p>
				{/if}
			</section>
		</div>

		<aside class="border-t border-gray-700 bg-gray-900/35 px-5 py-6 lg:border-l lg:border-t-0 lg:px-6">
			<h3 class="text-base font-semibold text-gray-100">Launch settings</h3>
			<p class="mt-1 text-xs text-gray-500">Execution behavior and current availability.</p>

			<div class="mt-5 border-t border-gray-700 pt-5">
				{#if capabilities.migrationMode}
					<SourceHandling {controller} compact />
				{:else}
					<div class="mt-3 flex items-start gap-3">
						<span
							class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-blue-500/10 text-blue-400"
						>
							<Octicon name="gear" size={16} />
						</span>
						<div>
							<p class="text-sm font-medium text-gray-200">Server managed</p>
							<p class="mt-0.5 text-xs leading-5 text-gray-500">
								The source adapter controls source handling. Launching writes repository data to the destination.
							</p>
						</div>
					</div>
				{/if}
			</div>

			<div class="mt-5 border-t border-gray-700 pt-5">
				<p class="text-xs font-semibold uppercase text-gray-500">Capacity</p>
				<div class="mt-3 flex items-start gap-3">
					<span
						class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md {controller.atCapacity
							? 'bg-amber-500/10 text-amber-400'
							: 'bg-green-500/10 text-green-400'}"
					>
						<Octicon name={controller.atCapacity ? "hourglass" : "pulse"} size={16} />
					</span>
					<p class="pt-1 text-sm leading-5 text-gray-300">{controller.reviewModel.queueMessage}</p>
				</div>
			</div>
		</aside>
	</div>

	<footer
		class="flex flex-col-reverse gap-3 border-t border-gray-700 bg-gray-900/45 px-5 py-4 sm:flex-row sm:items-center sm:justify-between lg:px-7"
	>
		<button
			type="button"
			onclick={() => controller.goBack()}
			class="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-gray-600 px-4 text-sm font-medium text-gray-300 transition-colors hover:bg-gray-800 hover:text-gray-50"
		>
			<Octicon name="chevron-left" size={16} />
			Back
		</button>
		<button
			type="submit"
			disabled={controller.submitting || !controller.readyForSubmission}
			class="inline-flex h-10 items-center justify-center gap-2 rounded-md px-5 text-sm font-semibold text-white shadow-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 {controller
				.form.state.migrationMode === 'production'
				? 'bg-amber-600 hover:bg-amber-500'
				: 'bg-green-600 hover:bg-green-500'}"
		>
			{#if controller.submitting}
				Starting...
			{:else}
				<Octicon name="rocket" size={16} />
				{controller.reviewModel.launchLabel}
			{/if}
		</button>
	</footer>
</section>

<MappingReview bind:open={repositoryReviewOpen} mappings={controller.reviewModel.allRepositoryMappings} />
<LaunchConfirm bind:open={controller.productionConfirmationOpen} repositoryCount={controller.reviewModel.repositoryCount} submitting={controller.submitting} error={controller.error} onConfirm={() => controller.confirmProductionLaunch()} />