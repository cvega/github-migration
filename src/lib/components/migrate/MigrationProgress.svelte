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
	}: {
		currentPhase: Phase;
		failed?: boolean;
		active?: boolean;
		progress?: Progress | null;
		source?: Counts | null;
		target?: Counts | null;
		showComparison?: boolean;
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
	<section
		class="overflow-hidden rounded-md border border-gray-700 bg-gray-900"
		aria-label="Migration pipeline"
	>
		<div class="flex items-center justify-between gap-3 px-4 py-2.5">
			<div class="flex items-center gap-2 text-xs font-medium text-gray-300">
				<Octicon name="workflow" size={16} class="text-gray-500" />Migration pipeline
			</div>
			<span
				class="text-[10px] font-semibold uppercase {failed
					? 'text-red-400'
					: currentPhase === 'SUCCEEDED'
						? 'text-green-400'
						: 'text-gray-500'}"
			>
				{pipelineSummary}
			</span>
		</div>

		<div
			class="grid grid-cols-2 gap-px border-t border-gray-700 bg-gray-700 sm:grid-cols-3 lg:grid-cols-6"
		>
			{#each steps as step, index (step.phase)}
				{@const status = phaseStatus(step.phase)}
				<div
					class="relative flex min-w-0 items-center gap-2.5 bg-gray-900 px-3 py-3 {status ===
					'active'
						? 'shadow-[inset_0_-2px_var(--color-green-500)]'
						: status === 'failed'
							? 'bg-red-500/5 shadow-[inset_0_-2px_var(--color-red-500)]'
							: ''}"
				>
					<span
						class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border {status ===
						'completed'
							? 'border-green-500/30 bg-green-500/10 text-green-400'
							: status === 'active'
								? 'border-green-500/40 bg-green-500/10 text-green-400'
								: status === 'failed'
									? 'border-red-500/40 bg-red-500/10 text-red-400'
									: 'border-gray-700 bg-gray-950/60 text-gray-600'}"
					>
						{#if status === "completed"}
							<Octicon name="check" size={16} />
						{:else if status === "failed"}
							<Octicon name="x" size={16} />
						{:else}
							<Octicon name={step.icon} size={16} />
						{/if}
					</span>
					<span class="min-w-0">
						<span class="block text-[9px] font-semibold uppercase text-gray-600"
							>Phase {index + 1}</span
						>
						<span class="mt-0.5 block truncate text-xs font-medium text-gray-300">{step.label}</span>
						<span class="mt-0.5 block text-[9px] text-gray-600">
							{status === "completed"
								? "Complete"
								: status === "active"
									? "Current"
									: status === "failed"
										? "Failed"
										: "Waiting"}
						</span>
					</span>
				</div>
				{/each}
		</div>
	</section>

	{#if active && progress}
		<section class="rounded-md border border-green-500/20 bg-green-500/5 p-4">
			<div class="mb-3 flex items-center justify-between">
				<h2 class="flex items-center gap-2 text-sm font-semibold uppercase text-green-400">
					<Octicon name="pulse" size={16} />Live Progress
				</h2>
				<span class="inline-flex items-center gap-1 text-xs text-gray-500">
					<Octicon name="stopwatch" size={12} />{formatElapsed(progress.current.elapsed)} elapsed
				</span>
			</div>
			<div class="grid grid-cols-3 gap-3 sm:grid-cols-6">
				{#each metricRows as row (row.label)}
					{@const percent =
						row.source > 0 ? Math.min(100, Math.round((row.live / row.source) * 100)) : 0}
					<div class="text-center">
						<div class="text-lg font-bold text-gray-50">{row.live.toLocaleString()}</div>
						<div class="inline-flex items-center gap-1 text-xs text-gray-500">
							<Octicon name={row.icon} size={12} />{row.label}
						</div>
						{#if row.source > 0}
							<div class="mt-1 h-1 overflow-hidden rounded-full bg-gray-800">
								<div class="h-full rounded-full bg-green-500" style="width: {percent}%"></div>
							</div>
							<div class="mt-0.5 text-[10px] text-gray-600">{percent}% of {row.source.toLocaleString()}</div>
						{/if}
					</div>
				{/each}
			</div>
			{#if progress.commitsPerMin > 0 || progress.issuesPerMin > 0}
				<div class="mt-3 flex gap-4 border-t border-green-500/10 pt-2 text-xs text-gray-400">
					{#if progress.commitsPerMin > 0}<span>{Math.round(progress.commitsPerMin)} commits/min</span>{/if}
					{#if progress.issuesPerMin > 0}<span>{Math.round(progress.issuesPerMin)} issues/min</span>{/if}
				</div>
			{/if}
		</section>
	{/if}

	{#if showComparison && (source || target)}
		<div class="overflow-hidden rounded-md border border-gray-700 bg-gray-900">
			<table class="w-full text-sm">
				<thead>
					<tr class="border-b border-gray-700 text-gray-400">
						<th class="px-4 py-2.5 text-left font-medium">Resource</th>
						<th class="px-4 py-2.5 text-right font-medium">Source</th>
						<th class="px-4 py-2.5 text-right font-medium">Target</th>
						<th class="px-4 py-2.5 text-right font-medium">Match</th>
					</tr>
				</thead>
				<tbody>
					{#each metricRows as row (row.label)}
						{@const matches = row.source > 0 ? row.target >= row.source : row.target === 0}
						<tr class="border-b border-gray-800/50 last:border-0">
							<td class="px-4 py-2 text-gray-300">
								<span class="inline-flex items-center gap-2"
									><Octicon name={row.icon} size={16} class="text-gray-500" />{row.label}</span
								>
							</td>
							<td class="px-4 py-2 text-right text-gray-400">{row.source.toLocaleString()}</td>
							<td class="px-4 py-2 text-right text-gray-50">{row.target.toLocaleString()}</td>
							<td class="px-4 py-2 text-right">
								{#if matches}
									<span class="text-green-400"><Octicon name="check-circle" size={16} /></span>
								{:else}
									<span class="text-yellow-400"
										>{row.source > 0
											? `${Math.floor((row.target / row.source) * 10000) / 100}%`
											: "-"}</span
									>
								{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</div>