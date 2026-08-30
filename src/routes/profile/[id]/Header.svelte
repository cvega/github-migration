<script lang="ts">
	import Octicon from "$lib/components/Octicon.svelte";
	import { timeAgo } from "$lib/format";
	import type { ProfileRun } from "$lib/profile/types";
	import type { getSourceProviderAdapter } from "$lib/source-provider";

	type Provider = ReturnType<typeof getSourceProviderAdapter>;

	let { run, provider }: { run: ProfileRun; provider: Provider } = $props();

	const stateBadge = {
		running: { label: "Running", className: "bg-blue-500/15 text-blue-300", icon: "sync" },
		completed: {
			label: "Completed",
			className: "bg-green-500/15 text-green-300",
			icon: "check-circle-fill",
		},
		failed: { label: "Failed", className: "bg-red-500/15 text-red-300", icon: "x-circle-fill" },
	} as const;
	const badge = $derived(stateBadge[run.state]);
</script>

<header class="flex flex-wrap items-start justify-between gap-4">
	<div class="min-w-0">
		<h1 class="flex min-w-0 flex-wrap items-center gap-2 text-xl font-semibold text-gray-50">
			<Octicon name="organization" size={24} class="text-gray-500" />
			<span class="break-all">{run.org}</span>
			<span class="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium {badge.className}">
				<Octicon name={badge.icon} size={12} class={run.state === "running" ? "animate-spin" : ""} />
				{badge.label}
			</span>
		</h1>
		<p class="text-machine mt-1 break-all text-gray-500">
			{provider.displayName} · {run.sourceApiUrl} · started {timeAgo(run.startedAt)}
			{#if run.apiCalls > 0}
				· {run.apiCalls.toLocaleString()} API calls
			{/if}
		</p>
	</div>
	<a href="/profile" class="shrink-0 text-sm text-gray-400 transition-colors hover:text-gray-50">All runs</a>
</header>

{#if run.failureReason}
	<div class="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300" role="alert">
		<Octicon name="x-circle-fill" size={16} class="mt-0.5 shrink-0" />
		<span>{run.failureReason}</span>
	</div>
{/if}