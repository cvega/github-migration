<script lang="ts">
	import "../app.css";
	import { onDestroy, onMount, setContext } from "svelte";
	import { page } from "$app/state";
	import AppHeader from "$lib/components/AppHeader.svelte";
	import {
		AUTH_PILL_KEY,
		type AuthPillContext,
		GH_STATUS_KEY,
		type GhStatusContext,
	} from "$lib/context-keys";
	import type { GitHubStatus } from "$lib/status";

	let { data, children } = $props();
	const isLoginPage = $derived(page.url.pathname === "/login");
	const sourceApp = $derived(data.sourceAuth?.mode === "github-app");
	const targetApp = $derived(data.targetAuth?.mode === "github-app");
	let liveSource = $derived(data.sourceAuth?.rateLimitLive ?? null);
	let liveTarget = $derived(data.targetAuth?.rateLimitLive ?? null);
	let activeMigrations = $derived(data.activeMigrations ?? 0);
	let polledProfileCount = $state<number | null>(null);
	let polledMigrationCount = $state<number | null>(null);
	const profileCount = $derived(polledProfileCount ?? data.profileCount ?? 0);
	const migrationCount = $derived(polledMigrationCount ?? data.migrationCount ?? 0);
	let ghStatus: GitHubStatus = $derived(
		data.ghStatus ?? { ok: true, incidentCount: 0, incidents: [] },
	);
	const migrating = $derived(activeMigrations > 0);

	setContext<GhStatusContext>(GH_STATUS_KEY, {
		get value() {
			return ghStatus;
		},
	});
	setContext<AuthPillContext>(AUTH_PILL_KEY, {
		get sourceApp() {
			return sourceApp;
		},
		get targetApp() {
			return targetApp;
		},
		get sourceRateText() {
			return sourceRateText;
		},
		get targetRateText() {
			return targetRateText;
		},
		get sourceRatePct() {
			return sourceRatePct;
		},
		get targetRatePct() {
			return targetRatePct;
		},
		get migrating() {
			return migrating;
		},
	});

	let pollInterval: ReturnType<typeof setInterval> | null = null;
	async function pollRateLimits() {
		try {
			const response = await fetch("/api/rate-limits");
			if (response.ok) {
				const body = await response.json();
				if (body.source) liveSource = body.source;
				if (body.target) liveTarget = body.target;
				activeMigrations = body.activeMigrations ?? activeMigrations;
				polledProfileCount = body.profileCount ?? polledProfileCount;
				polledMigrationCount = body.migrationCount ?? polledMigrationCount;
				if (body.ghStatus) ghStatus = body.ghStatus;
			}
		} catch {}
	}

	onMount(() => {
		if (isLoginPage || data.currentUser?.role === "operator") return;
		void pollRateLimits();
		pollInterval = setInterval(pollRateLimits, 30_000);
		return () => {
			if (pollInterval) clearInterval(pollInterval);
		};
	});

	onDestroy(() => {
		if (pollInterval) clearInterval(pollInterval);
	});

	function formatRate(remaining: number): string {
		return remaining.toLocaleString();
	}

	const sourceRateText = $derived(
		liveSource
			? formatRate(liveSource.remaining)
			: formatRate(data.sourceAuth?.rateLimit ?? 0),
	);
	const targetRateText = $derived(
		liveTarget
			? formatRate(liveTarget.remaining)
			: formatRate(data.targetAuth?.rateLimit ?? 0),
	);
	const sourceRatePct = $derived(
		liveSource ? Math.round((liveSource.remaining / liveSource.limit) * 100) : -1,
	);
	const targetRatePct = $derived(
		liveTarget ? Math.round((liveTarget.remaining / liveTarget.limit) * 100) : -1,
	);
</script>

{#if isLoginPage}
	{@render children()}
{:else}
	<div class="min-h-screen bg-gray-950 text-gray-200">
		<AppHeader
			pathname={page.url.pathname}
			setupComplete={data.setupComplete ?? false}
			{profileCount}
			{migrationCount}
			recentActivity={data.recentActivity ?? []}
			authEnabled={data.authEnabled ?? false}
			currentUser={data.currentUser ?? null}
		/>
		<main class="mx-auto max-w-6xl px-4 py-8 sm:px-6">{@render children()}</main>
	</div>
{/if}