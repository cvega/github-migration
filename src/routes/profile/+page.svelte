<!-- Profile workspace — start an organization or enterprise readiness crawl and view past runs. -->
<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import Octicon from '$lib/components/Octicon.svelte';
	import { timeAgo } from '$lib/format';

	let { data } = $props();

	type RunState = 'running' | 'completed' | 'failed';
	type Scope = 'org' | 'enterprise';

	let scope = $state<Scope>('org');
	let target = $state('');
	let submitting = $state(false);
	let error = $state('');

	const stateBadge: Record<RunState, { label: string; cls: string; icon: 'sync' | 'check-circle-fill' | 'x-circle-fill' }> = {
		running: { label: 'Running', cls: 'bg-blue-500/15 text-blue-300', icon: 'sync' },
		completed: { label: 'Completed', cls: 'bg-green-500/15 text-green-300', icon: 'check-circle-fill' },
		failed: { label: 'Failed', cls: 'bg-red-500/15 text-red-300', icon: 'x-circle-fill' }
	};

	// Unified, time-ordered feed of enterprise and org runs for the list below.
	const feed = $derived(
		[
			...data.enterpriseRuns.map((r) => ({
				kind: 'enterprise' as const,
				id: r.id,
				href: `/profile/enterprise/${r.id}`,
				name: r.enterpriseSlug,
				state: r.state as RunState,
				profiled: r.profiledOrgs,
				total: r.totalOrgs,
				unit: 'orgs',
				blockers: r.blockers,
				warnings: r.warnings,
				startedAt: r.startedAt
			})),
			...data.runs.map((r) => ({
				kind: 'org' as const,
				id: r.id,
				href: `/profile/${r.id}`,
				name: r.org,
				state: r.state as RunState,
				profiled: r.profiledRepos,
				total: r.totalRepos,
				unit: 'repos',
				blockers: r.blockers,
				warnings: r.warnings,
				startedAt: r.startedAt
			}))
		].sort((a, b) => b.startedAt.localeCompare(a.startedAt))
	);

	async function startProfile(e: Event) {
		e.preventDefault();
		const value = target.trim();
		if (!value) return;
		submitting = true;
		error = '';
		try {
			const body =
				scope === 'enterprise' ? { scope, enterprise: value } : { scope, org: value };
			const res = await fetch('/api/profile', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			});
			if (!res.ok) {
				const errBody = await res.json().catch(() => ({}));
				error = errBody.error || `HTTP ${res.status}`;
				return;
			}
			const run = (await res.json()) as { id: string };
			goto(scope === 'enterprise' ? `/profile/enterprise/${run.id}` : `/profile/${run.id}`);
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to start profile';
		} finally {
			submitting = false;
		}
	}
</script>

<svelte:head><title>Profile — GitHub Migration Toolkit</title></svelte:head>

<div class="space-y-8">
	<header class="flex items-center justify-between">
		<div>
			<h1 class="flex items-center gap-2 text-xl font-semibold text-gray-50">
				<Octicon name="telescope" size={24} class="text-violet-400" />
				Profile
			</h1>
			<p class="mt-1 text-sm text-gray-400">
				Crawl a source organization or enterprise and surface what the GitHub export won't carry cleanly.
			</p>
		</div>
		<a href="/" class="text-sm text-gray-400 transition-colors hover:text-gray-50">← Workspaces</a>
	</header>

	<!-- Start a run -->
	<section class="rounded-lg border border-gray-700 bg-gray-900 p-5">
		{#if data.sourceAuthAvailable}
			<!-- Scope toggle: profile a whole enterprise or a single organization. -->
			<div class="mb-4 inline-flex rounded-md border border-gray-700 bg-gray-950 p-0.5 text-sm">
				<button
					type="button"
					onclick={() => (scope = 'org')}
					class="inline-flex items-center gap-1.5 rounded px-3 py-1.5 font-medium transition-colors {scope === 'org' ? 'bg-violet-600 text-white' : 'text-gray-400 hover:text-gray-200'}"
				>
					<Octicon name="organization" size={16} />
					Organization
				</button>
				<button
					type="button"
					onclick={() => (scope = 'enterprise')}
					class="inline-flex items-center gap-1.5 rounded px-3 py-1.5 font-medium transition-colors {scope === 'enterprise' ? 'bg-violet-600 text-white' : 'text-gray-400 hover:text-gray-200'}"
				>
					<Octicon name="stack" size={16} />
					Enterprise
				</button>
			</div>
			<form onsubmit={startProfile} class="flex flex-wrap items-end gap-3">
				<div class="flex-1">
					<label for="target" class="mb-1 block text-sm font-medium text-gray-300">
						{scope === 'enterprise' ? 'Source enterprise slug' : 'Source organization'}
					</label>
					<input
						id="target"
						list={scope === 'org' ? 'source-orgs' : undefined}
						bind:value={target}
						placeholder={scope === 'enterprise' ? 'octo-enterprise' : 'octo-org'}
						autocomplete="off"
						class="w-full rounded-md border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-gray-50 placeholder-gray-600 focus:border-violet-500 focus:outline-none"
					/>
					{#if scope === 'org' && data.sourceOrgs.length > 0}
						<datalist id="source-orgs">
							{#each data.sourceOrgs as o (o)}<option value={o}></option>{/each}
						</datalist>
					{/if}
				</div>
				<button
					type="submit"
					disabled={submitting || !target.trim()}
					class="inline-flex items-center gap-1.5 rounded-md bg-violet-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-50"
				>
					<Octicon name={submitting ? 'sync' : 'play'} size={16} class={submitting ? 'animate-spin' : ''} />
					{submitting ? 'Starting…' : scope === 'enterprise' ? 'Start enterprise profile' : 'Start profile'}
				</button>
			</form>
			{#if scope === 'enterprise'}
				<p class="mt-2 text-xs text-gray-500">
					The enterprise URL slug (github.com/enterprises/<span class="text-gray-400">slug</span>). Your token must be an enterprise member or owner.
				</p>
			{/if}
			{#if error}
				<p class="mt-3 flex items-center gap-1.5 text-sm text-red-400">
					<Octicon name="alert" size={16} />{error}
				</p>
			{/if}
		{:else}
			<p class="flex items-center gap-2 text-sm text-gray-400">
				<Octicon name="shield-lock" size={16} class="text-gray-500" />
				No source credentials are configured on the server — set <code class="rounded bg-gray-800 px-1.5 py-0.5 text-xs text-gray-300">GH_SOURCE_PAT</code> (or a source GitHub App) to enable profiling.
			</p>
		{/if}
	</section>

	<!-- Past runs -->
	<section>
		<div class="mb-3 flex items-center justify-between">
			<h2 class="flex items-center gap-2 text-lg font-semibold text-gray-300">
				<Octicon name="history" size={16} />
				Runs
			</h2>
			<button
				type="button"
				onclick={() => invalidateAll()}
				class="inline-flex items-center gap-1.5 rounded-md border border-gray-700 bg-gray-800 px-3 py-1.5 text-sm text-gray-300 transition-colors hover:bg-gray-700 hover:text-gray-50"
			>
				<Octicon name="sync" size={16} />
				Refresh
			</button>
		</div>

		{#if feed.length === 0}
			<div class="flex flex-col items-center justify-center rounded-md border border-dashed border-gray-600 py-16">
				<Octicon name="telescope" size={24} class="h-12 w-12 text-gray-500" />
				<p class="mt-4 text-gray-400">No profiling runs yet</p>
			</div>
		{:else}
			<div class="space-y-2">
				{#each feed as item (item.kind + item.id)}
					{@const badge = stateBadge[item.state]}
					<a
						href={item.href}
						class="flex items-center justify-between rounded-md border border-gray-700 bg-gray-900 p-4 transition-all hover:border-gray-600 hover:bg-gray-800"
					>
						<div class="flex min-w-0 items-center gap-3">
							<Octicon name={item.kind === 'enterprise' ? 'stack' : 'organization'} size={16} class="text-gray-500" />
							<span class="font-medium text-gray-50">{item.name}</span>
							{#if item.kind === 'enterprise'}
								<span class="rounded-full border border-violet-500/30 bg-violet-500/10 px-1.5 py-0.5 text-[11px] font-medium text-violet-300">Enterprise</span>
							{/if}
							<span class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium {badge.cls}">
								<Octicon name={badge.icon} size={12} class={item.state === 'running' ? 'animate-spin' : ''} />
								{badge.label}
							</span>
						</div>
						<div class="flex shrink-0 items-center gap-4 text-xs text-gray-400">
							<span>{item.profiled}/{item.total} {item.unit}</span>
							{#if item.blockers > 0}<span class="inline-flex items-center gap-1 text-red-400"><Octicon name="stop" size={12} />{item.blockers}</span>{/if}
							{#if item.warnings > 0}<span class="inline-flex items-center gap-1 text-yellow-400"><Octicon name="alert" size={12} />{item.warnings}</span>{/if}
							<span class="inline-flex items-center gap-1"><Octicon name="clock" size={12} />{timeAgo(item.startedAt)}</span>
						</div>
					</a>
				{/each}
			</div>
		{/if}
	</section>
</div>
