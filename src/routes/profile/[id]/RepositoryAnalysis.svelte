<script lang="ts">
	import { enhance } from "$app/forms";
	import { invalidateAll } from "$app/navigation";
	import Octicon from "$lib/components/Octicon.svelte";
	import type { UsedIconName } from "$lib/icons.generated";
	import type { RepositoryAnalysisDetail } from "$lib/profile/repository-analysis";

	let {
		analysis,
		available,
		form,
	}: {
		analysis: RepositoryAnalysisDetail | null;
		available: boolean;
		form?: { analysisError?: string; analysisSuccess?: string } | null;
	} = $props();

	let submitting = $state(false);
	const active = $derived(
		analysis !== null && ["queued", "running", "finalizing"].includes(analysis.run.state),
	);
	const processedJobs = $derived(
		analysis ? analysis.run.completedRepoCount + analysis.run.failedRepoCount : 0,
	);
	const progress = $derived(
		analysis && analysis.run.selectedRepoCount > 0
			? Math.round((processedJobs / analysis.run.selectedRepoCount) * 100)
			: 0,
	);
	const presentation = $derived.by((): {
		title: string;
		detail: string;
		icon: UsedIconName;
		tone: string;
	} => {
		if (!analysis) {
			return {
				title: "Git data not analyzed",
				detail: "Add mirror size and historical LFS data to each repository.",
				icon: "database",
				tone: "text-gray-400",
			};
		}
		if (active) {
			return {
				title: "Analyzing Git data",
				detail: `${processedJobs} of ${analysis.run.selectedRepoCount} repositories complete`,
				icon: "sync",
				tone: "text-blue-400",
			};
		}
		if (analysis.run.state === "cancelled") {
			return {
				title: "Git analysis cancelled",
				detail: `${analysis.run.completedRepoCount} of ${analysis.run.selectedRepoCount} repositories completed before cancellation`,
				icon: "stop",
				tone: "text-gray-400",
			};
		}
		if (analysis.run.state === "failed") {
			return {
				title: "Git analysis failed",
				detail: analysis.run.failureReason ?? "Repository Git data could not be collected.",
				icon: "x-circle",
				tone: "text-red-400",
			};
		}
		if (analysis.run.failedRepoCount > 0) {
			return {
				title: "Git analysis needs attention",
				detail: `${analysis.run.completedRepoCount} analyzed · ${analysis.run.failedRepoCount} failed`,
				icon: "alert",
				tone: "text-yellow-400",
			};
		}
		return {
			title: "Git data analyzed",
			detail: `${analysis.run.completedRepoCount} repositories include Git and LFS measurements`,
			icon: "check-circle",
			tone: "text-green-400",
		};
	});

	$effect(() => {
		if (!active) return;
		const timer = setInterval(() => void invalidateAll(), 2_000);
		return () => clearInterval(timer);
	});

	function formatBytes(bytes: number): string {
		if (bytes <= 0) return "Unknown";
		const units = ["B", "KiB", "MiB", "GiB", "TiB"];
		let value = bytes;
		let index = 0;
		while (value >= 1024 && index < units.length - 1) {
			value /= 1024;
			index += 1;
		}
		return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
	}

</script>

<div class="rounded-md border border-gray-700 bg-gray-950/40 px-4 py-3">
	<div class="flex flex-wrap items-center justify-between gap-3">
		<div class="flex min-w-0 items-start gap-2.5">
			<Octicon
				name={presentation.icon}
				size={16}
				class="mt-0.5 shrink-0 {presentation.tone} {active ? 'animate-spin' : ''}"
			/>
			<div class="min-w-0">
				<p class="text-sm font-medium text-gray-100">{presentation.title}</p>
				<p class="mt-0.5 text-xs text-gray-400">{presentation.detail}</p>
				{#if analysis}
					<p class="mt-1 text-xs text-gray-500">
						{formatBytes(analysis.run.estimatedCloneBytes)} source estimate
						<span aria-hidden="true"> · </span>
						{formatBytes(analysis.run.estimatedPeakWorkspaceBytes)} peak workspace
						{#if analysis.run.unknownSizeRepoCount > 0}
							<span aria-hidden="true"> · </span>
							{analysis.run.unknownSizeRepoCount} unknown {analysis.run.unknownSizeRepoCount === 1 ? "size" : "sizes"}
						{/if}
					</p>
				{/if}
			</div>
		</div>

		{#if analysis === null || !active}
			<form method="POST" action="?/startAnalysis" use:enhance={() => {
				submitting = true;
				return async ({ update }) => {
					submitting = false;
					await update();
				};
			}}>
				<button
					type="submit"
					disabled={!available || submitting}
					class="inline-flex items-center gap-1.5 rounded-md bg-green-600 px-3 py-2 text-sm font-semibold text-white hover:bg-green-500 disabled:cursor-not-allowed disabled:bg-gray-800 disabled:text-gray-500"
				>
					<Octicon name="play" size={16} />{submitting ? "Queuing..." : analysis ? "Run again" : "Analyze Git data"}
				</button>
			</form>
		{:else if active}
			<form method="POST" action="?/cancelAnalysis" use:enhance>
				<input type="hidden" name="analysisRunId" value={analysis.run.id} />
				<button type="submit" class="inline-flex items-center gap-1.5 rounded-md border border-gray-600 px-3 py-2 text-sm font-medium text-gray-300 hover:border-red-500/50 hover:text-red-300">
					<Octicon name="stop" size={16} />Cancel
				</button>
			</form>
		{/if}
	</div>

	{#if active}
		<div class="mt-3 h-1.5 overflow-hidden rounded-full bg-gray-800" aria-label="Git analysis progress" aria-valuenow={progress} aria-valuemin="0" aria-valuemax="100" role="progressbar">
			<div class="h-full bg-blue-500 transition-[width] duration-300" style={`width: ${progress}%`}></div>
		</div>
	{/if}

	{#if form?.analysisError}
		<p role="alert" class="mt-3 border-t border-red-500/20 pt-2 text-xs text-red-300">{form.analysisError}</p>
	{:else if form?.analysisSuccess}
		<p role="status" class="mt-3 border-t border-green-500/20 pt-2 text-xs text-green-300">{form.analysisSuccess}</p>
	{/if}

	{#if !available && analysis === null}
		<p class="mt-3 border-t border-yellow-500/20 pt-2 text-xs text-yellow-300">Source credentials are required to analyze Git data.</p>
	{/if}
</div>
