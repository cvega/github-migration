<!-- Failure detail panel -->
<script lang="ts">
	import Octicon from '$lib/components/Octicon.svelte';
	import { formatDateTime, formatElapsed } from '$lib/format';
	import { buildMigrationReportLines } from '$lib/report';
	import type { FailureDetail as FailureDetailType, Migration, MigrationEvent } from '$lib/types';

	let { detail, migration, events = [] }: { detail: FailureDetailType; migration: Migration; events?: MigrationEvent[] } = $props();

	const logEntries = $derived(detail.logEntries || []);
	const errors = $derived(logEntries.filter((e) => e.severity === 'ERROR'));
	const warnings = $derived(logEntries.filter((e) => e.severity === 'WARNING'));

	// ── Copy a support report for a services engineer ─────────────────────────
	let copied = $state(false);

	function summarizeEvent(e: MigrationEvent): string {
		switch (e.eventType) {
			case 'step':
				return e.payload.message || '';
			case 'phase_change':
				return `${e.payload.from} → ${e.payload.to}`;
			case 'milestone':
				return e.payload.message || '';
			case 'snapshot': {
				const s = e.payload.progress?.current;
				if (!s) return e.phase ?? '';
				return `${e.phase ?? ''} — ${s.commits} commits, ${s.issues} issues, ${s.pullRequests} PRs`;
			}
			case 'complete':
				return `Migration succeeded${e.payload.elapsed ? ` in ${formatElapsed(e.payload.elapsed)}` : ''}`;
			case 'failure':
				return e.payload.error || e.payload.detail?.failureReason || 'Migration failed';
			case 'restart':
				return e.payload.message || 'Migration restarted';
			default:
				return '';
		}
	}

	function buildReport(): string {
		const lines = buildMigrationReportLines(migration);

		if (errors.length > 0) {
			lines.push('', `Errors (${errors.length}):`);
			for (const e of errors) lines.push(`  [${e.modelName}] ${e.message}`);
		}
		if (warnings.length > 0) {
			lines.push('', `Warnings (${warnings.length}):`);
			for (const w of warnings) lines.push(`  [${w.modelName}] ${w.message}`);
		}

		if (events.length > 0) {
			lines.push('', `Event log (${events.length}):`);
			for (const e of events) {
				const ts = formatDateTime(e.createdAt);
				const msg = summarizeEvent(e);
				lines.push(`  ${ts}  ${e.eventType}${msg ? `: ${msg}` : ''}`);
			}
		}

		return lines.join('\n');
	}

	async function copyReport() {
		try {
			await navigator.clipboard.writeText(buildReport());
			copied = true;
			setTimeout(() => (copied = false), 1500);
		} catch {
			// Clipboard unavailable (e.g. insecure context); ignore.
		}
	}
</script>

<div class="rounded-md border border-red-500/30 bg-red-500/5 p-5">
	<div class="flex items-start justify-between gap-3">
		<h3 class="flex items-center gap-2 text-sm font-semibold text-red-400">
			<Octicon name="x-circle" size={16} />
			Migration Failed
		</h3>
		<button type="button" onclick={copyReport}
			title="Copy a full failure report (repo, IDs, timing, errors) to share with a services engineer"
			class="flex shrink-0 items-center gap-1.5 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-xs text-red-300 hover:bg-red-500/20 transition-colors">
			<Octicon name={copied ? 'check' : 'copy'} size={12} />
			{copied ? 'Copied' : 'Copy details'}
		</button>
	</div>

	{#if detail.failureReason}
		<p class="mt-2 text-sm text-red-300">{detail.failureReason}</p>
	{/if}

	<div class="mt-3 flex gap-4 text-xs text-gray-400">
		<span>Elapsed: {formatElapsed(detail.elapsed)}</span>
		{#if detail.logUrl}
		<a href={detail.logUrl} target="_blank" rel="noreferrer"
				class="inline-flex items-center gap-1 text-blue-400 hover:text-blue-300 hover:underline">
				<Octicon name="link-external" size={12} />
				Migration Log
			</a>
		{/if}
	</div>

	{#if errors.length > 0}
		<div class="mt-4">
			<h4 class="flex items-center gap-1 text-xs font-medium text-red-400/80"><Octicon name="alert" size={12} />Errors ({errors.length})</h4>
			<div class="mt-1 max-h-48 overflow-y-auto rounded border border-red-500/20 bg-gray-900">
				{#each errors as entry}
					<div class="border-b border-red-500/10 px-3 py-1.5 text-xs text-red-300 last:border-0">
						<span class="text-gray-500">[{entry.modelName}]</span> {entry.message}
					</div>
				{/each}
			</div>
		</div>
	{/if}

	{#if warnings.length > 0}
		<div class="mt-3">
			<h4 class="flex items-center gap-1 text-xs font-medium text-yellow-400/80"><Octicon name="alert" size={12} />Warnings ({warnings.length})</h4>
			<div class="mt-1 max-h-36 overflow-y-auto rounded border border-yellow-500/20 bg-gray-900">
				{#each warnings as entry}
					<div class="border-b border-yellow-500/10 px-3 py-1.5 text-xs text-yellow-300 last:border-0">
						<span class="text-gray-500">[{entry.modelName}]</span> {entry.message}
					</div>
				{/each}
			</div>
		</div>
	{/if}
</div>
