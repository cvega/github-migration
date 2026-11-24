<script lang="ts">
	import Octicon from "$lib/components/Octicon.svelte";
	import { timeAgo } from "$lib/format";
	import type { ProfileRun } from "$lib/profile/types";
	import { getSourceProviderAdapter } from "$lib/source-provider";
	import type { PageData } from "./$types";

	type Provider = ReturnType<typeof getSourceProviderAdapter>;

	let { run, provider, sources }: { run: ProfileRun; provider: Provider; sources: PageData["sourceChoices"] } = $props();

	const stateBadge = {
		running: { label: "Running", className: "border-blue-500/40 text-blue-300", icon: "sync" },
		completed: {
			label: "Completed",
			className: "border-green-500/40 text-green-300",
			icon: "check-circle-fill",
		},
		failed: { label: "Failed", className: "border-red-500/40 text-red-300", icon: "x-circle-fill" },
	} as const;
	const badge = $derived(stateBadge[run.state]);
</script>

<header class="border-b border-gray-700 pb-4">
	<div class="mb-3 flex items-center justify-between gap-4">
		<a href="/profile" class="inline-flex items-center gap-1 text-sm font-medium text-gray-400 transition-colors hover:text-blue-400">
			<Octicon name="chevron-left" size={16} />Profiles
		</a>
		<span class="text-xs text-gray-500">Source profile</span>
	</div>
	<div class="flex flex-wrap items-start justify-between gap-3">
		<div class="min-w-0">
			<h1 class="flex min-w-0 flex-wrap items-center gap-2 text-2xl font-semibold text-gray-50">
				<Octicon name="organization" size={24} class="text-gray-500" />
				<span class="break-all">{run.org}</span>
				<span class="inline-flex items-center gap-1 rounded-full border bg-transparent px-2 py-0.5 text-xs font-medium {badge.className}">
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
		{#if sources.length > 1}
			<details class="w-full text-sm sm:w-auto sm:max-w-sm">
				<summary class="cursor-pointer rounded-md border border-gray-600 px-3 py-2 text-gray-200 hover:bg-gray-800">Switch source</summary>
				<nav aria-label="Assigned sources" class="mt-1 max-h-60 overflow-y-auto">
					{#each sources as source (source.id)}
						{@const current = source.namespace === run.org && source.sourceProvider === run.sourceProvider && source.sourceApiUrl === run.sourceApiUrl}
						<a href={`/profile/${encodeURIComponent(current ? run.id : source.id)}`} aria-current={current ? "page" : undefined}
							class="block rounded-md px-3 py-2 break-words text-gray-300 hover:bg-gray-800 aria-current:text-blue-300">
							{source.namespace} · {getSourceProviderAdapter(source.sourceProvider).displayName}
						</a>
					{/each}
				</nav>
			</details>
		{/if}
	</div>
</header>

{#if run.failureReason}
	<div class="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300" role="alert">
		<Octicon name="x-circle-fill" size={16} class="mt-0.5 shrink-0" />
		<span>{run.failureReason}</span>
	</div>
{/if}