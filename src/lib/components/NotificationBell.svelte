<!-- Navbar notification bell — recent migration activity feed -->
<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import Octicon from '$lib/components/Octicon.svelte';
	import { timeAgo } from '$lib/format';
	import type { IconName } from '@primer/octicons';
	import type { ActivityItem, ActivityKind } from '$lib/types';

	let { initial }: { initial: ActivityItem[] } = $props();

	const STORAGE_KEY = 'gh_migrate_last_seen_activity';
	const POLL_MS = 20_000;

	// Seed from the SSR-provided list once; polling/refresh takes over after mount.
	let items = $state<ActivityItem[]>(untrack(() => initial));
	let open = $state(false);
	let lastSeenId = $state(0);
	let root = $state<HTMLDivElement>();

	const unreadCount = $derived(items.filter((i) => i.id > lastSeenId).length);

	const maxId = (list: ActivityItem[]) => list.reduce((m, i) => Math.max(m, i.id), 0);

	const kindMeta: Record<ActivityKind, { icon: IconName; color: string; label: string }> = {
		succeeded: { icon: 'check-circle-fill', color: 'text-green-400', label: 'Succeeded' },
		failed: { icon: 'x-circle-fill', color: 'text-red-400', label: 'Failed' },
		restarted: { icon: 'sync', color: 'text-blue-400', label: 'Restarted' },
		notice: { icon: 'alert', color: 'text-yellow-400', label: 'Notice' }
	};

	async function refresh() {
		try {
			const res = await fetch('/api/activity');
			if (res.ok) {
				const body = await res.json();
				if (Array.isArray(body.items)) items = body.items;
			}
		} catch {
			// Non-fatal — keep the last good list.
		}
	}

	function markRead() {
		lastSeenId = maxId(items);
		try {
			localStorage.setItem(STORAGE_KEY, String(lastSeenId));
		} catch {
			// Storage unavailable (e.g. private mode) — unread state is best-effort.
		}
	}

	async function toggle() {
		open = !open;
		if (open) {
			await refresh();
			markRead();
		}
	}

	onMount(() => {
		// Seed unread baseline: stored last-seen id, or (first visit) the newest
		// existing item so the badge starts clean and only future events count.
		let stored: number | null = null;
		try {
			const raw = localStorage.getItem(STORAGE_KEY);
			stored = raw ? Number.parseInt(raw, 10) : null;
		} catch {
			stored = null;
		}
		lastSeenId = stored != null && Number.isFinite(stored) ? stored : maxId(items);

		const interval = setInterval(refresh, POLL_MS);
		return () => clearInterval(interval);
	});

	// Close the panel on outside click / Escape while it's open.
	$effect(() => {
		if (!open) return;
		function onClick(e: MouseEvent) {
			if (root && !root.contains(e.target as Node)) open = false;
		}
		function onKey(e: KeyboardEvent) {
			if (e.key === 'Escape') open = false;
		}
		// Defer the click listener so the opening click doesn't immediately close it.
		const t = setTimeout(() => document.addEventListener('click', onClick), 0);
		document.addEventListener('keydown', onKey);
		return () => {
			clearTimeout(t);
			document.removeEventListener('click', onClick);
			document.removeEventListener('keydown', onKey);
		};
	});
</script>

<div class="relative" bind:this={root}>
	<button
		type="button"
		onclick={toggle}
		aria-label="Notifications{unreadCount > 0 ? ` (${unreadCount} unread)` : ''}"
		aria-haspopup="true"
		aria-expanded={open}
		class="relative flex items-center rounded-md border border-gray-700 bg-gray-800 px-3 py-1.5 text-gray-300 hover:bg-gray-700 hover:text-gray-50 transition-colors {open ? 'bg-gray-700 text-gray-50' : ''}">
		<Octicon name={unreadCount > 0 ? 'bell-fill' : 'bell'} size={16} />
		{#if unreadCount > 0}
			<span class="absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold leading-none text-white">
				{unreadCount > 9 ? '9+' : unreadCount}
			</span>
		{/if}
	</button>

	{#if open}
		<div class="absolute right-0 z-50 mt-2 w-80 overflow-hidden rounded-lg border border-gray-700 bg-gray-900 shadow-xl">
			<div class="flex items-center justify-between border-b border-gray-700 px-4 py-2.5">
				<span class="text-sm font-semibold text-gray-200">Recent activity</span>
				<span class="text-xs text-gray-500">{items.length} event{items.length === 1 ? '' : 's'}</span>
			</div>

			{#if items.length === 0}
				<div class="flex flex-col items-center gap-2 px-4 py-10 text-center">
					<Octicon name="inbox" size={24} class="text-gray-600" />
					<p class="text-sm text-gray-500">No recent activity</p>
				</div>
			{:else}
				<ul class="max-h-96 divide-y divide-gray-800/70 overflow-y-auto">
					{#each items as item (item.id)}
						{@const meta = kindMeta[item.kind]}
						<li>
							<a href="/{item.migrationId}"
								onclick={() => (open = false)}
								class="flex items-start gap-2.5 px-4 py-2.5 transition-colors hover:bg-gray-800">
								<span class="mt-0.5 shrink-0 {meta.color}"><Octicon name={meta.icon} size={16} /></span>
								<span class="min-w-0 flex-1">
									<span class="flex items-center justify-between gap-2">
										<span class="truncate text-sm font-medium text-gray-100">{item.repo}</span>
										<span class="shrink-0 text-[11px] text-gray-500">{timeAgo(item.createdAt)}</span>
									</span>
									<span class="mt-0.5 flex items-center gap-1.5">
										<span class="text-xs {meta.color}">{meta.label}</span>
										{#if item.summary}
											<span class="truncate text-xs text-gray-500">· {item.summary}</span>
										{/if}
									</span>
								</span>
							</a>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	{/if}
</div>
