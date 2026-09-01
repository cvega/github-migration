<script lang="ts">
	import Octicon from "$lib/components/Octicon.svelte";
	import { formatElapsed } from "$lib/format";
	import type { UsedIconName as IconName } from "$lib/icons.generated";
	import { STATE_LABELS } from "$lib/migrate/migration-display";
	import type { Counts, Phase, Progress } from "$lib/migrate/types";

	let {
		currentPhase,
		failed = false,
		active = false,
		progress = null,
		source = null,
		target = null,
		showComparison = true,
		view = "all",
	}: {
		currentPhase: Phase;
		failed?: boolean;
		active?: boolean;
		progress?: Progress | null;
		source?: Counts | null;
		target?: Counts | null;
		showComparison?: boolean;
		view?: "all" | "steps" | "activity" | "comparison";
	} = $props();

	const steps: { phase: Phase; label: string; icon: IconName }[] = [
		{ phase: "PENDING_VALIDATION", label: "Validating", icon: "shield-check" },
		{ phase: "QUEUED", label: STATE_LABELS.queued, icon: "clock" },
		{ phase: "EXPORTING", label: "Exporting", icon: "download" },
		{ phase: "IMPORTING_GIT", label: "Git Import", icon: "repo-push" },
		{ phase: "IMPORTING_METADATA", label: "Metadata", icon: "note" },
		{ phase: "SUCCEEDED", label: "Done", icon: "check-circle" },
	];
	const phaseOrder = steps.map((step) => step.phase);
	const currentStepIndex = $derived(Math.max(0, phaseOrder.indexOf(currentPhase)));
	const currentStepLabel = $derived(steps[currentStepIndex]?.label ?? "Preparing");
	const pipelineSummary = $derived(
		failed
			? `Stopped at ${currentStepLabel}`
			: currentPhase === "SUCCEEDED"
				? `${steps.length} of ${steps.length} complete`
				: `${currentStepIndex + 1} of ${steps.length} - ${currentStepLabel}`,
	);
	const metricRows = $derived([
		{
			label: "Commits",
			icon: "git-commit" as const,
			source: source?.commits ?? 0,
			target: target?.commits ?? 0,
			live: progress?.current.commits ?? 0,
		},
		{
			label: "Branches",
			icon: "git-branch" as const,
			source: source?.branches ?? 0,
			target: target?.branches ?? 0,
			live: progress?.current.branches ?? 0,
		},
		{
			label: "Tags",
			icon: "tag" as const,
			source: source?.tags ?? 0,
			target: target?.tags ?? 0,
			live: progress?.current.tags ?? 0,
		},
		{
			label: "Issues",
			icon: "issue-opened" as const,
			source: source?.issues ?? 0,
			target: target?.issues ?? 0,
			live: progress?.current.issues ?? 0,
		},
		{
			label: "Pull Requests",
			icon: "git-pull-request" as const,
			source: source?.pullRequests ?? 0,
			target: target?.pullRequests ?? 0,
			live: progress?.current.pullRequests ?? 0,
		},
		{
			label: "Releases",
			icon: "package" as const,
			source: source?.releases ?? 0,
			target: target?.releases ?? 0,
			live: progress?.current.releases ?? 0,
		},
	]);

	function phaseStatus(phase: Phase): "completed" | "active" | "upcoming" | "failed" {
		if (failed && phase === currentPhase) return "failed";
		const currentIndex = phaseOrder.indexOf(currentPhase);
		const stepIndex = phaseOrder.indexOf(phase);
		if (stepIndex < currentIndex) return "completed";
		if (phase === "SUCCEEDED" && currentPhase === "SUCCEEDED") return "completed";
		if (stepIndex === currentIndex) return "active";
		return "upcoming";
	}
</script>

<div class="space-y-6">
	{#if view === "all" || view === "steps"}
	<section aria-label="Migration pipeline">
		<div class="mb-4 flex items-center justify-between gap-3 lg:block">
			<h2 class="flex items-center gap-2 text-sm font-semibold text-gray-200">
				<Octicon name="workflow" size={16} class="text-gray-500" />Migration pipeline
			</h2>
			<span
				class="text-xs font-medium lg:mt-1 lg:block lg:pl-6 {failed
					? 'text-red-400'
					: currentPhase === 'SUCCEEDED'
						? 'text-green-400'
						: 'text-gray-500'}"
			>
				{pipelineSummary}
			</span>
		</div>

		<ol>
			{#each steps as step (step.phase)}
				{@const status = phaseStatus(step.phase)}
				<li class="relative flex min-w-0 gap-3 pb-4 last:pb-0">
					{#if step.phase !== "SUCCEEDED"}
						<span class="absolute bottom-0 left-2.75 top-6 w-px bg-gray-700" aria-hidden="true"></span>
					{/if}
					<span
						class="relative z-10 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border bg-gray-950 {status ===
						'completed'
							? 'border-green-500/50 text-green-400'
							: status === 'active'
								? 'border-green-500 text-green-400'
								: status === 'failed'
									? 'border-red-500 text-red-400'
									: 'border-gray-700 text-gray-600'}"
					>
						{#if status === "completed"}
							<Octicon name="check" size={12} />
						{:else if status === "failed"}
							<Octicon name="x" size={12} />
						{:else}
							<Octicon name={step.icon} size={12} />
						{/if}
					</span>
					<span class="min-w-0 pt-0.5">
						<span class="block text-sm font-medium {status === 'upcoming' ? 'text-gray-500' : 'text-gray-200'}">{step.label}</span>
						<span class="mt-0.5 block text-xs {status === 'active' ? 'text-green-400' : status === 'failed' ? 'text-red-400' : 'text-gray-600'}">
							{status === "completed"
								? "Complete"
								: status === "active"
									? "Current"
									: status === "failed"
										? "Failed"
										: "Waiting"}
						</span>
					</span>
				</li>
				{/each}
		</ol>
	</section>
	{/if}

	{#if (view === "all" || view === "activity") && active && progress}
		<section aria-labelledby="live-progress-title">
			<div class="mb-3 flex items-center justify-between">
				<h2 id="live-progress-title" class="flex items-center gap-2 text-sm font-semibold text-gray-200">
					<Octicon name="pulse" size={16} class="text-green-400" />Live progress
				</h2>
				<span class="inline-flex items-center gap-1 text-xs text-gray-500">
					<Octicon name="stopwatch" size={12} />{formatElapsed(progress.current.elapsed)} elapsed
				</span>
			</div>
			<div class="grid grid-cols-2 gap-x-6 gap-y-3 border-y border-gray-700 py-3 sm:grid-cols-3 lg:grid-cols-6">
				{#each metricRows as row (row.label)}
					{@const percent =
						row.source > 0 ? Math.min(100, Math.round((row.live / row.source) * 100)) : 0}
					<div>
						<div class="text-base font-semibold tabular-nums text-gray-100">{row.live.toLocaleString()}</div>
						<div class="inline-flex items-center gap-1 text-xs text-gray-500">
							<Octicon name={row.icon} size={12} />{row.label}
						</div>
						{#if row.source > 0}
							<div class="mt-1 h-1 overflow-hidden rounded-full bg-gray-800">
								<div class="h-full rounded-full bg-green-500" style="width: {percent}%"></div>
							</div>
							<div class="mt-0.5 text-xs text-gray-600">{percent}% of {row.source.toLocaleString()}</div>
						{/if}
					</div>
				{/each}
			</div>
			{#if progress.commitsPerMin > 0 || progress.issuesPerMin > 0}
				<div class="mt-3 flex gap-4 text-xs text-gray-400">
					{#if progress.commitsPerMin > 0}<span>{Math.round(progress.commitsPerMin)} commits/min</span>{/if}
					{#if progress.issuesPerMin > 0}<span>{Math.round(progress.issuesPerMin)} issues/min</span>{/if}
				</div>
			{/if}
		</section>
	{/if}

	{#if (view === "all" || view === "comparison") && showComparison && (source || target)}
		<section aria-labelledby="resource-comparison-title">
			<div class="mb-3 flex items-center justify-between gap-4">
				<h2 id="resource-comparison-title" class="text-lg font-semibold text-gray-200">Resource comparison</h2>
				<span class="text-xs text-gray-500">Source <Octicon name="arrow-right" size={12} /> Target</span>
			</div>
			<ul class="border-y border-gray-700">
				{#each metricRows as row (row.label)}
					{@const matches = row.source > 0 ? row.target >= row.source : row.target === 0}
					<li class="grid grid-cols-[minmax(0,1fr)_auto_3rem] items-center gap-3 border-b border-gray-800/70 py-2.5 last:border-0">
						<span class="inline-flex min-w-0 items-center gap-2 text-sm text-gray-300">
							<Octicon name={row.icon} size={16} class="shrink-0 text-gray-500" />
							<span class="truncate">{row.label}</span>
						</span>
						<span class="flex items-center justify-end gap-2 text-sm tabular-nums">
							<span class="text-gray-500">{row.source.toLocaleString()}</span>
							<Octicon name="arrow-right" size={12} class="text-gray-600" />
							<span class="min-w-10 text-right text-gray-200">{active && row.target === 0 ? "—" : row.target.toLocaleString()}</span>
						</span>
						<span class="flex justify-end text-xs tabular-nums">
							{#if active && row.target === 0}
								<span class="text-gray-600"><Octicon name="clock" size={16} /><span class="sr-only">Pending</span></span>
							{:else if matches}
								<span class="text-green-400"><Octicon name="check-circle" size={16} /><span class="sr-only">Matched</span></span>
							{:else}
								<span class="text-yellow-400"
									>{row.source > 0
										? `${Math.floor((row.target / row.source) * 10000) / 100}%`
										: "—"}</span
								>
							{/if}
						</span>
					</li>
				{/each}
			</ul>
		</section>
	{/if}
</div>