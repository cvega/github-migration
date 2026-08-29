<script lang="ts">
	import Octicon from "$lib/components/Octicon.svelte";
	import { formatDateTime, formatElapsed } from "$lib/format";
	import { buildMigrationReportLines } from "$lib/migrate/report";
	import type {
		FailureDetail,
		Migration,
		MigrationEvent,
	} from "$lib/migrate/types";

	let {
		detail,
		migration,
		events = [],
	}: { detail: FailureDetail; migration: Migration; events?: MigrationEvent[] } = $props();

	const logEntries = $derived(detail.logEntries || []);
	const errors = $derived(logEntries.filter((entry) => entry.severity === "ERROR"));
	const warnings = $derived(logEntries.filter((entry) => entry.severity === "WARNING"));
	let copied = $state(false);

	function summarizeEvent(event: MigrationEvent): string {
		switch (event.eventType) {
			case "step":
				return event.payload.message || "";
			case "phase_change":
				return `${event.payload.from} -> ${event.payload.to}`;
			case "milestone":
				return event.payload.message || "";
			case "snapshot": {
				const snapshot = event.payload.progress?.current;
				if (!snapshot) return event.phase ?? "";
				return `${event.phase ?? ""} - ${snapshot.commits} commits, ${snapshot.issues} issues, ${snapshot.pullRequests} PRs`;
			}
			case "complete":
				return `Migration succeeded${event.payload.elapsed ? ` in ${formatElapsed(event.payload.elapsed)}` : ""}`;
			case "failure":
				return event.payload.error || event.payload.detail?.failureReason || "Migration failed";
			case "restart":
				return event.payload.message || "Migration restarted";
			default:
				return "";
		}
	}

	function buildReport(): string {
		const lines = buildMigrationReportLines(migration);
		if (errors.length > 0) {
			lines.push("", `Errors (${errors.length}):`);
			for (const entry of errors) lines.push(`  [${entry.modelName}] ${entry.message}`);
		}
		if (warnings.length > 0) {
			lines.push("", `Warnings (${warnings.length}):`);
			for (const entry of warnings) lines.push(`  [${entry.modelName}] ${entry.message}`);
		}
		if (events.length > 0) {
			lines.push("", `Event log (${events.length}):`);
			for (const event of events) {
				const timestamp = formatDateTime(event.createdAt);
				const message = summarizeEvent(event);
				lines.push(`  ${timestamp}  ${event.eventType}${message ? `: ${message}` : ""}`);
			}
		}
		return lines.join("\n");
	}

	async function copyReport() {
		try {
			await navigator.clipboard.writeText(buildReport());
			copied = true;
			setTimeout(() => (copied = false), 1500);
		} catch {
			// Clipboard access can be unavailable in insecure browser contexts.
		}
	}
</script>

<div class="rounded-md border border-red-500/30 bg-red-500/5 p-5">
	<div class="flex items-start justify-between gap-3">
		<h3 class="flex items-center gap-2 text-sm font-semibold text-red-400">
			<Octicon name="x-circle" size={16} />Migration Failed
		</h3>
		<button
			type="button"
			onclick={copyReport}
			title="Copy a full failure report to share with a services engineer"
			class="flex shrink-0 items-center gap-1.5 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-xs text-red-300 transition-colors hover:bg-red-500/20"
		>
			<Octicon name={copied ? "check" : "copy"} size={12} />
			{copied ? "Copied" : "Copy details"}
		</button>
	</div>

	{#if detail.failureReason}
		<p class="mt-2 text-sm text-red-300">{detail.failureReason}</p>
	{/if}

	<div class="mt-3 flex gap-4 text-xs text-gray-400">
		<span>Elapsed: {formatElapsed(detail.elapsed)}</span>
		{#if detail.logUrl}
			<a
				href={detail.logUrl}
				target="_blank"
				rel="noreferrer"
				class="inline-flex items-center gap-1 text-blue-400 hover:text-blue-300 hover:underline"
			>
				<Octicon name="link-external" size={12} />Migration Log
			</a>
		{/if}
	</div>

	{#if errors.length > 0}
		<div class="mt-4">
			<h4 class="flex items-center gap-1 text-xs font-medium text-red-400/80">
				<Octicon name="alert" size={12} />Errors ({errors.length})
			</h4>
			<div class="mt-1 max-h-48 overflow-y-auto rounded border border-red-500/20 bg-gray-900">
				{#each errors as entry (entry)}
					<div class="border-b border-red-500/10 px-3 py-1.5 text-xs text-red-300 last:border-0">
						<span class="text-gray-500">[{entry.modelName}]</span> {entry.message}
					</div>
				{/each}
			</div>
		</div>
	{/if}

	{#if warnings.length > 0}
		<div class="mt-3">
			<h4 class="flex items-center gap-1 text-xs font-medium text-yellow-400/80">
				<Octicon name="alert" size={12} />Warnings ({warnings.length})
			</h4>
			<div class="mt-1 max-h-36 overflow-y-auto rounded border border-yellow-500/20 bg-gray-900">
				{#each warnings as entry (entry)}
					<div
						class="border-b border-yellow-500/10 px-3 py-1.5 text-xs text-yellow-300 last:border-0"
					>
						<span class="text-gray-500">[{entry.modelName}]</span> {entry.message}
					</div>
				{/each}
			</div>
		</div>
	{/if}
</div>