<!-- Root layout -->
<script lang="ts">
	import '../app.css';
	import { onMount, onDestroy } from 'svelte';
	import { untrack } from 'svelte';
	import Octicon from '$lib/components/Octicon.svelte';

	let { data, children } = $props();
	const sourceApp = $derived(data.sourceAuth.mode === 'github-app');
	const targetApp = $derived(data.targetAuth.mode === 'github-app');

	// Live rate limit state — seeded from server, updated by polling.
	let liveSource = $state(untrack(() => data.sourceAuth.rateLimitLive ?? null));
	let liveTarget = $state(untrack(() => data.targetAuth.rateLimitLive ?? null));
	let activeMigrations = $state(untrack(() => data.activeMigrations));
	const migrating = $derived(activeMigrations > 0);

	// Re-seed when navigating between pages (layout data re-runs).
	$effect(() => {
		liveSource = data.sourceAuth.rateLimitLive ?? liveSource;
		liveTarget = data.targetAuth.rateLimitLive ?? liveTarget;
		activeMigrations = data.activeMigrations;
	});

	// Poll /api/rate-limits every 30s to keep the navbar current.
	let pollInterval: ReturnType<typeof setInterval> | null = null;

	async function pollRateLimits() {
		try {
			const res = await fetch('/api/rate-limits');
			if (res.ok) {
				const body = await res.json();
				if (body.source) liveSource = body.source;
				if (body.target) liveTarget = body.target;
				activeMigrations = body.activeMigrations ?? activeMigrations;
			}
		} catch {
			// Non-fatal
		}
	}

	onMount(() => {
		pollInterval = setInterval(pollRateLimits, 30_000);
		return () => { if (pollInterval) clearInterval(pollInterval); };
	});

	onDestroy(() => {
		if (pollInterval) clearInterval(pollInterval);
	});

	function formatRate(remaining: number, limit: number): string {
		const fmt = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K` : String(n);
		return `${fmt(remaining)}/${fmt(limit)}`;
	}

	const sourceRateText = $derived(
		liveSource
			? formatRate(liveSource.remaining, liveSource.limit)
			: `${(data.sourceAuth.rateLimit / 1000).toFixed(0)}K`
	);
	const targetRateText = $derived(
		liveTarget
			? formatRate(liveTarget.remaining, liveTarget.limit)
			: `${(data.targetAuth.rateLimit / 1000).toFixed(0)}K`
	);
</script>

<div class="min-h-screen bg-gray-950 text-gray-200">
	<nav class="border-b border-gray-700 bg-gray-900">
		<div class="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
			<a href="/" class="flex items-center gap-2 text-base font-semibold text-gray-50 hover:text-gray-200 transition-colors">
				<img src="/imgs/GitHub_Invertocat_White_Clearspace.png" alt="GitHub" class="h-9 w-9" />
				GitHub Migrate
			</a>
			<div class="flex items-center gap-4">
				<div class="flex items-center gap-2">
					<span class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors
						{migrating ? 'bg-yellow-500/15 text-yellow-400 ring-1 ring-yellow-500/30' : sourceApp ? 'bg-green-600/15 text-green-400' : 'bg-gray-800 text-gray-400'}">
					<Octicon name={sourceApp ? 'shield-lock' : 'key'} size={12} />
						Source: {sourceApp ? 'App' : 'PAT'}
						<span class="{migrating ? 'text-yellow-500' : 'text-gray-500'}">{sourceRateText}</span>
					</span>
					<span class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors
						{migrating ? 'bg-yellow-500/15 text-yellow-400 ring-1 ring-yellow-500/30' : targetApp ? 'bg-green-600/15 text-green-400' : 'bg-gray-800 text-gray-400'}">
					<Octicon name={targetApp ? 'shield-lock' : 'key'} size={12} />
						Target: {targetApp ? 'App' : 'PAT'}
						<span class="{migrating ? 'text-yellow-500' : 'text-gray-500'}">{targetRateText}</span>
					</span>
				</div>
				<a href="/new"
					class="flex items-center gap-1.5 rounded-md bg-green-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-green-500 transition-colors">
					<Octicon name="plus" size={16} />
					New Migration
				</a>
			</div>
		</div>
	</nav>

	<main class="mx-auto max-w-6xl px-6 py-8">
		{@render children()}
	</main>
</div>
