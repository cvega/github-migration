<!-- Root layout -->
<script lang="ts">
	import '../app.css';
	import { onDestroy, onMount, setContext, untrack } from 'svelte';
	import { page } from '$app/state';
	import NotificationBell from '$lib/components/NotificationBell.svelte';
	import Octicon from '$lib/components/Octicon.svelte';
	import { AUTH_PILL_KEY, type AuthPillContext, GH_STATUS_KEY, type GhStatusContext } from '$lib/context-keys';
	import type { GitHubStatus } from '$lib/types';

	let { data, children } = $props();

	const isLoginPage = $derived(page.url.pathname === '/login');
	// Migration-specific nav chrome (activity bell, Stats, New Migration) belongs
	// to the Migrate workspace only — keep it off the landing page and any other
	// workspace.
	const inMigrate = $derived(page.url.pathname.startsWith('/migrate'));
	const sourceApp = $derived(data.sourceAuth.mode === 'github-app');
	const targetApp = $derived(data.targetAuth.mode === 'github-app');

	// Live rate limit state — seeded from server, updated by polling.
	let liveSource = $state(untrack(() => data.sourceAuth.rateLimitLive ?? null));
	let liveTarget = $state(untrack(() => data.targetAuth.rateLimitLive ?? null));
	let activeMigrations = $state(untrack(() => data.activeMigrations));
	let ghStatus: GitHubStatus = $state(untrack(() => data.ghStatus));
	const migrating = $derived(activeMigrations > 0);

	// Expose live ghStatus to child pages via context.
	setContext<GhStatusContext>(GH_STATUS_KEY, { get value() { return ghStatus; } });

	// Expose live auth pill data to child pages via context.
	setContext<AuthPillContext>(AUTH_PILL_KEY, {
		get sourceApp() { return sourceApp; },
		get targetApp() { return targetApp; },
		get sourceRateText() { return sourceRateText; },
		get targetRateText() { return targetRateText; },
		get sourceRatePct() { return sourceRatePct; },
		get targetRatePct() { return targetRatePct; },
		get migrating() { return migrating; },
	});

	// Re-seed when navigating between pages (layout data re-runs).
	$effect(() => {
		liveSource = data.sourceAuth.rateLimitLive ?? untrack(() => liveSource);
		liveTarget = data.targetAuth.rateLimitLive ?? untrack(() => liveTarget);
		activeMigrations = data.activeMigrations;
		ghStatus = data.ghStatus;
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
				if (body.ghStatus) ghStatus = body.ghStatus;
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
	// Percentage remaining (0–100), or -1 if no live data.
	const sourceRatePct = $derived(liveSource ? Math.round((liveSource.remaining / liveSource.limit) * 100) : -1);
	const targetRatePct = $derived(liveTarget ? Math.round((liveTarget.remaining / liveTarget.limit) * 100) : -1);
</script>

{#if isLoginPage}
	{@render children()}
{:else}
<div class="min-h-screen bg-gray-950 text-gray-200">
	<nav class="border-b border-gray-700 bg-gray-900">
		<div class="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
			<a href="/" class="flex items-center gap-2 text-base font-semibold text-gray-50 hover:text-gray-200 transition-colors">
				<img src="/imgs/github-logo.png" alt="GitHub" class="h-9 w-9" />
				GitHub Migration Dashboard
			</a>
			<div class="flex items-center gap-4">
				{#if inMigrate}
					<NotificationBell initial={data.recentActivity} />
					<a href="/migrate/stats"
						class="flex items-center gap-1.5 rounded-md border border-gray-700 bg-gray-800 px-3 py-1.5 text-sm text-gray-300 hover:text-gray-50 hover:bg-gray-700 transition-colors">
						<Octicon name="graph" size={16} />
						Stats
					</a>
					<a href="/migrate/new"
						class="flex items-center gap-1.5 rounded-md bg-green-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-green-500 transition-colors">
						<Octicon name="paper-airplane" size={16} />
						New Migration
					</a>
				{/if}
				{#if data.authEnabled}
					<form method="POST" action="/logout" class="m-0 flex self-stretch">
						<button type="submit"
							class="flex items-center gap-1.5 rounded-md border border-gray-700 bg-gray-800 px-3 text-sm text-gray-400 hover:text-gray-50 hover:bg-gray-700 transition-colors"
							title="Sign out">
							<Octicon name="sign-out" size={16} />
						</button>
					</form>
				{/if}
			</div>
		</div>
	</nav>

	<main class="mx-auto max-w-6xl px-6 py-8">
		{@render children()}
	</main>
</div>
{/if}
