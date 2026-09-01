<script lang="ts">
	import { goto } from "$app/navigation";
	import Octicon from "$lib/components/Octicon.svelte";
	import { formatDateTime, formatElapsed, formatRepoSize } from "$lib/format";
	import type { UsedIconName as IconName } from "$lib/icons.generated";
	import { STATE_ICONS, STATE_LABELS } from "$lib/migrate/migration-display";
	import { buildMigrationReport } from "$lib/migrate/report";
	import type { Counts, Migration, Phase, Snapshot } from "$lib/migrate/types";
	import { isActiveMigrationState } from "$lib/migration-state";
	import { getTargetPlatformPresentation } from "$lib/migration-target";
	import { getSourceProviderAdapter } from "$lib/source-provider";

	let {
		migration,
		live,
		now,
		grouped = false,
	}: {
		migration: Migration;
		live?: { snapshot: Snapshot; sourceCounts: Counts | null };
		now?: number;
		grouped?: boolean;
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
	const stateIconStyle: Record<Migration["state"], string> = {
		queued: "text-violet-400",
		pending: "text-yellow-400",
		running: "text-green-400",
		cancelling: "text-cyan-400",
		succeeded: "text-green-400",
		failed: "text-red-400",
		cancelled: "text-gray-400",
		reconciliation_required: "text-orange-300",
	};

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

<div
	class="group relative overflow-hidden bg-gray-950/40 transition-colors hover:bg-gray-900/60 {grouped
		? 'border-b border-gray-700 last:border-b-0'
		: 'rounded-md border border-gray-700'}"
>
	<div class="flex items-start gap-3 p-4">
		<Octicon name="repo" size={16} class="mt-0.5 shrink-0 text-gray-500" />
		<div class="min-w-0 flex-1">
			<div class="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
				<div class="min-w-0">
					<div class="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-sm">
						<a
							href="/migrate/{migration.id}"
							class="text-machine min-w-0 max-w-full truncate font-semibold text-blue-400 after:absolute after:inset-0 hover:underline focus-visible:outline-2 focus-visible:outline-blue-500"
							>{migration.sourceOrg}/{migration.sourceRepo}</a
						>
						<span class="flex min-w-0 basis-full items-center gap-1.5 sm:basis-auto">
							<Octicon name="arrow-right" size={12} class="shrink-0 text-gray-600" />
							<span class="sr-only">migrated to</span>
							<span class="text-machine min-w-0 truncate font-medium text-gray-300"
								>{migration.targetOrg}/{migration.targetRepo}</span
							>
						</span>
					</div>
					<div
						class="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500"
					>
						{#if liveElapsed}
							<span
								class="inline-flex items-center gap-1 tabular-nums"
								title={migration.completedAt
									? `Started ${formatDateTime(migration.startedAt)}\nFinished ${formatDateTime(migration.completedAt)}`
									: `Started ${formatDateTime(migration.startedAt)}`}
							>
								<Octicon name="stopwatch" size={12} />{formatElapsed(liveElapsed, "")}
							</span>
						{/if}
						<span
							class="inline-flex items-center gap-1.5"
							title="{platform.displayName} → {targetPlatform.displayName}"
						>
							<Octicon name={platform.icon} size={16} />{platform.label}
							<span class="text-gray-600">→</span>
							<Octicon name={targetPlatform.icon} size={16} />{targetPlatform.label}
						</span>
						{#if migration.sourceSizeKb != null}
							<span class="inline-flex items-center gap-1"
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
								class="relative z-10 inline-flex cursor-pointer items-center gap-1 border-none text-blue-400 hover:text-blue-300"
								><Octicon name="stack" size={12} />Batch</button
							>
						{/if}
						{#if migration.warningsCount > 0}
							<span class="inline-flex items-center gap-1 text-yellow-400"
								><Octicon name="alert" size={12} />{migration.warningsCount} warnings</span
							>
						{/if}
					</div>
				</div>

				<div class="flex max-w-full shrink-0 flex-col items-end gap-1.5 text-right text-xs sm:max-w-96">
					<span class="inline-flex items-center gap-1.5 font-medium text-gray-300">
						<Octicon
							name={STATE_ICONS[migration.state]}
							size={12}
							class="{stateIconStyle[migration.state]} {migration.state === 'running' ||
							migration.state === 'cancelling'
								? 'animate-spin'
								: ''}"
						/>{STATE_LABELS[migration.state]}
					</span>
					{#if migration.failureReason}
						<div class="flex max-w-full min-w-0 items-center justify-end gap-1.5">
							<p class="min-w-0 truncate text-red-400" title={migration.failureReason}>
								{migration.failureReason}
							</p>
							<button
								type="button"
								onclick={copyErrorDetails}
								aria-label={copiedError ? "Error details copied" : "Copy error details"}
								title={copiedError ? "Copied" : "Copy error details"}
								class="relative z-10 inline-flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded text-gray-500 transition-colors hover:bg-gray-800 hover:text-gray-200 focus-visible:outline-2 focus-visible:outline-blue-500"
							>
								<Octicon name={copiedError ? "check" : "copy"} size={12} />
							</button>
						</div>
					{/if}
				</div>
			</div>

			{#if isActive && live}
				{@const snapshot = live.snapshot}
				{@const meta = phaseMeta[snapshot.phase] ?? phaseMeta.UNKNOWN}
				<div class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500">
					<span
						class="inline-flex items-center gap-1 text-green-400"
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
		</div>
	</div>
</div>