<script lang="ts">
	import { tick } from "svelte";
	import Octicon from "$lib/components/Octicon.svelte";
	import type { UsedIconName } from "$lib/icons.generated";
	import Destination from "./Destination.svelte";
	import Options from "./Options.svelte";
	import Repo from "./Repo.svelte";
	import SourceAccess from "./SourceAccess.svelte";
	import type {
		MigrationConfigurationStep,
		NewMigrationController,
	} from "./workflow.svelte";

	let { controller }: { controller: NewMigrationController } = $props();

	const steps = [
		{
			id: "repositories",
			label: "Repositories",
			title: "Which repositories are moving?",
			description: "Choose one repository or provide a normalized batch list.",
			icon: "repo",
		},
		{
			id: "source-access",
			label: "Source access",
			title: "Confirm source access",
			description: "Review the source host and credentials used to read migration data.",
			icon: "shield-lock",
		},
		{
			id: "destination",
			label: "Target",
			title: "Configure the target",
			description: "Choose the target organization, repository name, and access method.",
			icon: "repo-push",
		},
		{
			id: "options",
			label: "Options",
			title: "Set migration behavior",
			description: "Review execution and compatibility settings before readiness.",
			icon: "gear",
		},
	] as const satisfies readonly {
		id: MigrationConfigurationStep;
		label: string;
		title: string;
		description: string;
		icon: UsedIconName;
	}[];

	const activeIndex = $derived(
		steps.findIndex((step) => step.id === controller.configurationStep),
	);
	const activeStep = $derived(steps[activeIndex] ?? steps[0]);
	const activePosition = $derived(activeIndex + 2);
	const totalPositions = steps.length + 1;
	const activeIssues = $derived(
		controller.issues.filter((issue) => issue.step === controller.configurationStep),
	);
	const continueLabel = $derived(
		controller.configurationStep === "options"
			? "Continue to readiness"
			: `Continue to ${steps[activeIndex + 1]?.label.toLowerCase() ?? "readiness"}`,
	);
	let configurationSection = $state<HTMLElement>();

	async function continueWorkflow(): Promise<void> {
		if (controller.goForward()) return;
		await tick();
		const issue = controller.issues[0];
		if (!issue) return;
		const field = configurationSection?.querySelector<HTMLElement>(
			`[data-migration-field="${issue.field}"]`,
		);
		const focusTarget = field?.matches("input, textarea, select")
			? field
			: (field?.querySelector<HTMLElement>("input:not([type='hidden']), textarea, select") ??
				field?.querySelector<HTMLElement>("button, [tabindex]"));
		(focusTarget ?? field)?.focus();
	}
</script>

<section
	bind:this={configurationSection}
	class="overflow-hidden rounded-md border border-gray-700 bg-gray-950"
>
	<div class="guided-layout grid">
		<aside class="border-b border-gray-700 bg-gray-900/45 p-4 lg:border-b-0 lg:border-r lg:p-5">
			<div class="mb-3 flex items-center justify-between text-xs text-gray-500">
				<span>Migration setup</span><span>{activePosition} of {totalPositions}</span>
			</div>
			<div class="h-1.5 overflow-hidden rounded-full bg-gray-800">
				<div
					class="progress-bar h-full bg-blue-500"
					style:width={`${(activePosition / totalPositions) * 100}%`}
				></div>
			</div>
			<ol class="step-list mt-4 grid grid-cols-5 gap-1 lg:block">
				<li>
					<button
						type="button"
						onclick={() => controller.goToRoute()}
						class="flex w-full items-center justify-center gap-2 rounded-md py-2 text-sm text-green-400 lg:justify-start lg:px-2 lg:text-left lg:hover:bg-gray-800"
					>
						<span
							class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-green-500/15"
							><Octicon name="check" size={12} /></span
						><span class="hidden lg:block">Path</span>
					</button>
				</li>
				{#each steps as step, index (step.id)}
					<li>
						<button
							type="button"
							aria-current={controller.configurationStep === step.id ? "step" : undefined}
							onclick={() => controller.goToConfigurationStep(step.id)}
							class="flex w-full items-center justify-center gap-2 rounded-md py-2 text-sm transition-colors lg:justify-start lg:px-2 lg:text-left {controller
								.configurationStep === step.id
								? 'font-semibold text-gray-50 lg:bg-blue-500/10 lg:shadow-[inset_2px_0_0_var(--fgColor-accent)]'
								: index < activeIndex
									? 'text-green-400 lg:hover:bg-gray-800'
									: 'text-gray-400 lg:hover:bg-gray-800'}"
						>
							<span
								class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full {controller
									.configurationStep === step.id
									? 'bg-blue-500/20 text-blue-400 ring-2 ring-blue-500/60'
									: index < activeIndex
										? 'bg-green-500/15'
										: 'border border-gray-700'}"
							>
								{#if index < activeIndex}<Octicon name="check" size={12} />{:else}<span
										class="text-xs">{index + 2}</span
									>{/if}
							</span>
							<span class="hidden lg:block">{step.label}</span>
						</button>
					</li>
				{/each}
			</ol>
		</aside>

		<div class="min-w-0">
			<header class="flex items-start gap-3 border-b border-gray-700 px-5 py-5 lg:px-7">
				<span
					class="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-blue-500/10 text-blue-400"
					><Octicon name={activeStep.icon} size={16} /></span
				>
				<div>
					<h2 class="text-base font-semibold text-gray-50">{activeStep.title}</h2>
					<p class="mt-1 text-sm text-gray-400">{activeStep.description}</p>
				</div>
			</header>

			<div class="px-5 py-6 lg:px-7">
				{#if controller.configurationStep === "repositories"}<Repo {controller} />
				{:else if controller.configurationStep === "source-access"}<SourceAccess {controller} />
				{:else if controller.configurationStep === "destination"}<Destination {controller} />
				{:else}<Options {controller} />{/if}
				{#if activeIssues.length > 0}
					<div
						role="alert"
						aria-live="assertive"
						class="mt-5 rounded-md border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400"
					>
						<ul class="space-y-1">
							{#each activeIssues as issue (`${issue.field}:${issue.message}`)}
								<li id={`migration-error-${issue.field}`}>{issue.message}</li>
							{/each}
						</ul>
					</div>
				{/if}
			</div>

			<footer
				class="flex flex-col gap-3 border-t border-gray-700 px-5 py-4 sm:flex-row sm:items-center sm:justify-center lg:px-7"
			>
				<button
					type="button"
					onclick={() => controller.goBack()}
					class="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-gray-600 px-4 text-sm font-medium text-gray-300 transition-colors hover:bg-gray-800 hover:text-gray-50"
					><Octicon name="chevron-left" size={16} />Back</button
				>
				<button
					type="button"
					onclick={continueWorkflow}
					class="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-green-600 px-5 text-sm font-semibold text-white transition-colors hover:bg-green-500"
					>{continueLabel}<Octicon name="arrow-right" size={16} /></button
				>
			</footer>
		</div>
	</div>
</section>

<style>
	@media (prefers-reduced-motion: no-preference) {
		.progress-bar {
			transition: width 160ms ease;
		}
	}

	@media (min-width: 64rem) {
		.guided-layout {
			grid-template-columns: 15rem minmax(0, 1fr);
		}
	}
</style>