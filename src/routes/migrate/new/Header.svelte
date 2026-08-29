<script lang="ts">
	import Octicon from "$lib/components/Octicon.svelte";
	import type { NewMigrationController } from "./workflow.svelte";

	let { controller }: { controller: NewMigrationController } = $props();

	const title = $derived(
		controller.stage === "route"
			? "New migration"
			: controller.stage === "configure"
				? "Configure migration"
				: controller.reviewModel.title,
	);
	const description = $derived(
		controller.stage === "route"
			? "Choose the source and target before configuring repositories and execution."
			: controller.stage === "configure"
				? `${controller.sourcePlatformLabel} to ${controller.selectedTargetProfile ? controller.targetDisplayName(controller.selectedTargetProfile) : "GitHub"}`
				: "Review the resolved path and settings before launch.",
	);
	const stageLabel = $derived(
		controller.stage === "route"
			? "Choose path"
			: controller.stage === "configure"
				? "Configure"
				: "Review",
	);
</script>

<header
	class="flex flex-col gap-4 border-b border-gray-700 pb-5 sm:flex-row sm:items-center sm:justify-between"
>
	<div class="flex min-w-0 items-start gap-3">
		<span
			class="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-blue-500/10 text-blue-400"
		>
			<Octicon name="repo-push" size={24} />
		</span>
		<div class="min-w-0">
			<div class="flex flex-wrap items-center gap-2">
				<h1 class="text-xl font-semibold text-gray-50">{title}</h1>
				<span class="rounded-full bg-blue-500/15 px-2.5 py-1 text-xs font-medium text-blue-400"
					>{stageLabel}</span
				>
			</div>
			<p class="mt-1 max-w-2xl text-sm text-gray-400">{description}</p>
		</div>
	</div>
	<div class="flex shrink-0 items-center gap-2 text-xs text-gray-500">
		<Octicon name="pulse" size={16} />
		{controller.activeMigrations} of {controller.maxConcurrent} active
	</div>
</header>