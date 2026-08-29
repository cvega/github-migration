<script lang="ts">
	import { goto } from "$app/navigation";
	import Octicon from "$lib/components/Octicon.svelte";
	import { formatDateTime, formatElapsed, formatRepoSize } from "$lib/format";
	import type { UsedIconName as IconName } from "$lib/icons.generated";
	import { STATE_ICONS, STATE_LABELS, STATE_STYLES } from "$lib/migrate/migration-display";
	import { buildMigrationReport } from "$lib/migrate/report";
	import type { Counts, Migration, Phase, Snapshot } from "$lib/migrate/types";
	import { isActiveMigrationState } from "$lib/migration-state";
	import { getTargetPlatformPresentation } from "$lib/migration-target";
	import { getSourceProviderAdapter } from "$lib/source-provider";

	let {
		migration,
		live,
		now,
	}: {
		migration: Migration;
		live?: { snapshot: Snapshot; sourceCounts: Counts | null };
		now?: number;
	} = $props();

	const phaseMeta: Record<Phase, { label: string; icon: IconName }> = {
		QUEUED: { label: STATE_LABELS.queued, icon: "clock" },
		PENDING_VALIDATION: { label: "Validating", icon: "shield-check" },
		EXPORTING: { label: "Exporting", icon: "download" },
		IMPORTING_GIT: { label: "Git import", icon: "repo-push" },
		IMPORTING_METADATA: { label: "Metadata", icon: "note" },
		SUCCEEDED: { label: "Done", icon: "check-circle" },
		FAILED: { label: "Failed", icon: "x-circle" },
		UNKNOWN: { label: "Working", icon: "sync" },
	};

	const isActive = $derived(isActiveMigrationState(migration.state));
	const platform = $derived(
		getSourceProviderAdapter(migration.sourceProvider).sourcePlatform(migration.sourceApiUrl),
	);
	const targetPlatform = $derived(getTargetPlatformPresentation(migration.targetPlatform));
	const stateAccent = $derived(
		migration.state === "running"
			? "bg-green-500"
			: migration.state === "pending"
				? "bg-yellow-500"
				: migration.state === "queued"
					? "bg-violet-500"
					: migration.state === "cancelling"
						? "bg-cyan-500"
						: migration.state === "succeeded"
							? "bg-green-500"
							: migration.state === "failed"
								? "bg-red-500"
								: "bg-gray-500",
	);
	const activeState = $derived(
		migration.state === "running"
			? {
					label: STATE_LABELS.running,
					text: "text-green-400",
					dot: "bg-green-400",
					pulse: true,
				}
			: migration.state === "pending"
				? {
						label: STATE_LABELS.pending,
						text: "text-yellow-400",
						dot: "bg-yellow-400",
						pulse: false,
					}
				: migration.state === "queued"
					? {
							label: STATE_LABELS.queued,
							text: "text-violet-400",
							dot: "bg-violet-400",
							pulse: false,
						}
					: migration.state === "cancelling"
						? {
								label: STATE_LABELS.cancelling,
								text: "text-cyan-400",
								dot: "bg-cyan-400",
								pulse: true,
							}
						: {
								label: STATE_LABELS[migration.state],
								text: "text-gray-400",
								dot: "bg-gray-400",
								pulse: false,
							},
	);

	const liveElapsed = $derived(
		isActive && now
			? (now - new Date(migration.startedAt).getTime()) / 1000
			: migration.elapsedSeconds,
	);
	const livePct = $derived.by(() => {
		if (!live?.sourceCounts) return null;
		const total =
			live.sourceCounts.commits + live.sourceCounts.issues + live.sourceCounts.pullRequests;
		if (total <= 0) return null;
		const done = live.snapshot.commits + live.snapshot.issues + live.snapshot.pullRequests;
		return Math.min(100, Math.round((done / total) * 100));
	});

	let copiedError = $state(false);

	async function copyErrorDetails(event: MouseEvent) {
		event.preventDefault();
		event.stopPropagation();
		try {
			await navigator.clipboard.writeText(buildMigrationReport(migration));
			copiedError = true;
			setTimeout(() => (copiedError = false), 1500);
		} catch {
			// Clipboard access can be unavailable in insecure browser contexts.
		}
	}
</script>

<a
	href="/migrate/{migration.id}"
	class="group relative block overflow-hidden rounded-md border border-gray-700 bg-gray-900 transition-all hover:border-gray-600 hover:bg-gray-800"
>
	<span class="absolute inset-y-0 left-0 w-1 {stateAccent}"></span>
	<div class="p-4 pl-5">
		<div
			class="grid grid-cols-[minmax(0,1fr)_2rem_minmax(0,1fr)] items-center gap-3 md:grid-cols-[minmax(0,1fr)_3rem_minmax(0,1fr)_8.5rem] md:gap-4"
		>
			<div class="min-w-0">
				<div class="text-[10px] font-semibold uppercase text-gray-500">Source repository</div>
				<div class="mt-1.5 flex min-w-0 items-center gap-2">
					<span
						class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-gray-700 bg-gray-950/60 text-gray-400"
					>
						<Octicon name="repo" size={16} />
					</span>
					<span class="truncate text-sm font-semibold text-gray-50"
						>{migration.sourceOrg}/{migration.sourceRepo}</span
					>
				</div>
			</div>

			<div class="flex items-center text-gray-600">
				<span class="h-px flex-1 bg-gray-700"></span>
				<Octicon name="chevron-right" size={16} />
			</div>

			<div class="min-w-0">
				<div class="text-[10px] font-semibold uppercase text-gray-500">Target repository</div>
				<div class="mt-1.5 flex min-w-0 items-center gap-2">
					<span
						class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-gray-700 bg-gray-950/60 text-gray-400"
					>
						<Octicon name="repo" size={16} />
					</span>
					<span class="truncate text-sm font-medium text-gray-300"
						>{migration.targetOrg}/{migration.targetRepo}</span
					>
				</div>
			</div>

			<div
				class="col-span-3 mt-1 flex items-center justify-between border-t border-gray-700/70 pt-3 md:col-span-1 md:mt-0 md:block md:border-t-0 md:border-l md:pt-0 md:pl-4"
			>
				{#if isActive}
					<span class="inline-flex items-center gap-1.5 text-xs font-medium {activeState.text}">
						<span class="relative flex h-2 w-2" aria-hidden="true">
							{#if activeState.pulse}
								<span
									class="absolute inline-flex h-full w-full animate-ping rounded-full {activeState.dot} opacity-40 motion-reduce:animate-none"
								></span>
							{/if}
							<span class="relative inline-flex h-2 w-2 rounded-full {activeState.dot}"></span>
						</span>
						{activeState.label}
					</span>
				{:else}
					<span
						class="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium {STATE_STYLES[
							migration.state
						]}"
					>
						<Octicon name={STATE_ICONS[migration.state]} size={12} />
						{STATE_LABELS[migration.state]}
					</span>
				{/if}
				{#if liveElapsed}
					<div
						class="inline-flex items-center gap-1 text-sm font-medium tabular-nums {isActive
							? activeState.text
							: 'text-gray-500'} md:mt-2"
						title={migration.completedAt
							? `Started ${formatDateTime(migration.startedAt)}\nFinished ${formatDateTime(migration.completedAt)}`
							: `Started ${formatDateTime(migration.startedAt)}`}
					>
						<Octicon name="stopwatch" size={12} />{formatElapsed(liveElapsed, "")}
					</div>
				{/if}
			</div>
		</div>

		<div
			class="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-gray-700/70 pt-3"
		>
			<div class="flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-gray-500">
				<span
					class="inline-flex items-center gap-1.5 rounded-md border border-gray-700 bg-gray-950/40 px-2 py-1"
					title="{platform.displayName} → {targetPlatform.displayName}"
				>
					<Octicon name={platform.icon} size={12} />{platform.label}
					<span class="text-gray-600">→</span>
					<Octicon name={targetPlatform.icon} size={12} />{targetPlatform.label}
				</span>
				{#if migration.sourceSizeKb != null}
					<span class="inline-flex items-center gap-1 rounded-md bg-gray-800/70 px-2 py-1"
						><Octicon name="database" size={12} />{formatRepoSize(migration.sourceSizeKb)}</span
					>
				{/if}
				{#if migration.batchId}
					<button
						type="button"
						onclick={(event: MouseEvent) => {
							event.preventDefault();
							event.stopPropagation();
							goto(`/migrate/batches/${migration.batchId}`);
						}}
						class="inline-flex cursor-pointer items-center gap-1 rounded-md border-none bg-blue-500/10 px-2 py-1 text-blue-400 hover:bg-blue-500/15 hover:text-blue-300"
						><Octicon name="stack" size={12} />Batch</button
					>
				{/if}
				{#if migration.warningsCount > 0}
					<span
						class="inline-flex items-center gap-1 rounded-md bg-yellow-500/10 px-2 py-1 text-yellow-400"
						><Octicon name="alert" size={12} />{migration.warningsCount} warnings</span
					>
				{/if}
			</div>

			{#if isActive && live}
				{@const snapshot = live.snapshot}
				{@const meta = phaseMeta[snapshot.phase] ?? phaseMeta.UNKNOWN}
				<div class="flex flex-wrap items-center justify-end gap-2 text-xs text-gray-500">
					<span
						class="inline-flex items-center gap-1 rounded-md bg-green-500/10 px-2 py-1 text-green-400"
						><Octicon name={meta.icon} size={12} />{meta.label}</span
					>
					{#if snapshot.commits > 0}
						<span class="inline-flex items-center gap-1"
							><Octicon name="git-commit" size={12} />{snapshot.commits.toLocaleString()}</span
						>
					{/if}
					{#if snapshot.issues > 0}
						<span class="inline-flex items-center gap-1"
							><Octicon name="issue-opened" size={12} />{snapshot.issues.toLocaleString()}</span
						>
					{/if}
					{#if snapshot.pullRequests > 0}
						<span class="inline-flex items-center gap-1"
							><Octicon name="git-pull-request" size={12} />{snapshot.pullRequests.toLocaleString()}</span
						>
					{/if}
					{#if livePct != null}
						<span class="font-medium tabular-nums text-gray-300">{livePct}% complete</span>
					{/if}
				</div>
			{/if}

			{#if migration.failureReason}
				<div class="flex min-w-0 items-center gap-2">
					<p class="min-w-0 truncate text-xs text-red-400/80" title={migration.failureReason}>
						{migration.failureReason}
					</p>
					<button
						type="button"
						onclick={copyErrorDetails}
						title="Copy error details to share with a services engineer"
						class="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-xs text-red-300 transition-colors hover:bg-red-500/20"
					>
						<Octicon name={copiedError ? "check" : "copy"} size={12} />
						{copiedError ? "Copied" : "Copy"}
					</button>
				</div>
			{/if}
		</div>
	</div>
</a>