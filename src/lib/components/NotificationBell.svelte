<script lang="ts">
	import { onMount, untrack } from "svelte";
	import Octicon from "$lib/components/Octicon.svelte";
	import { timeAgo } from "$lib/format";
	import type { UsedIconName as IconName } from "$lib/icons.generated";
	import type { ActivityItem, ActivityKind } from "$lib/migrate/types";

	let { initial }: { initial: ActivityItem[] } = $props();
	const STORAGE_KEY = "gh_migrate_last_seen_activity";
	const POLL_MS = 20_000;
	let items = $state<ActivityItem[]>(untrack(() => initial));
	let open = $state(false);
	let lastSeenId = $state(0);
	const unreadCount = $derived(items.filter((item) => item.id > lastSeenId).length);
	const maxId = (list: ActivityItem[]) =>
		list.reduce((maximum, item) => Math.max(maximum, item.id), 0);
	const kindMeta: Record<ActivityKind, { icon: IconName; color: string; label: string }> = {
		succeeded: { icon: "check-circle-fill", color: "text-green-400", label: "Succeeded" },
		failed: { icon: "x-circle-fill", color: "text-red-400", label: "Failed" },
		restarted: { icon: "sync", color: "text-blue-400", label: "Restarted" },
		notice: { icon: "alert", color: "text-yellow-400", label: "Notice" },
	};

	async function refresh() {
		try {
			const response = await fetch("/api/migrate/activity");
			if (response.ok) {
				const body = await response.json();
				if (Array.isArray(body.items)) items = body.items;
			}
		} catch {}
	}

	function markRead() {
		lastSeenId = maxId(items);
		try {
			localStorage.setItem(STORAGE_KEY, String(lastSeenId));
		} catch {}
	}

	async function toggle() {
		open = !open;
		if (open) {
			await refresh();
			markRead();
		}
	}

	function closeOutside(event: MouseEvent): void {
		if (open && !(event.target as Element).closest("[data-notification-root]")) open = false;
	}

	function closeOnEscape(event: KeyboardEvent): void {
		if (open && event.key === "Escape") open = false;
	}

	onMount(() => {
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
</script>

<svelte:window onclick={closeOutside} onkeydown={closeOnEscape} />

<div class="relative" data-notification-root>
	<button
		type="button"
		onclick={toggle}
		aria-label="Notifications{unreadCount > 0 ? ` (${unreadCount} unread)` : ''}"
		aria-haspopup="true"
		aria-expanded={open}
		class="relative flex h-9 w-9 items-center justify-center rounded-md border border-gray-700 bg-gray-900 text-gray-300 outline-none transition-colors hover:border-gray-600 hover:bg-gray-800 hover:text-gray-50 focus-visible:ring-2 focus-visible:ring-blue-400 {open
			? 'bg-gray-800 text-gray-50'
			: ''}"
	>
		<Octicon name={unreadCount > 0 ? "bell-fill" : "bell"} size={16} />
		{#if unreadCount > 0}
			<span
				class="absolute -right-2 -top-2 flex h-5 min-w-5 items-center justify-center rounded-full bg-red-500 px-1 text-xs font-bold leading-none text-white"
			>
				{unreadCount > 9 ? "9+" : unreadCount}
			</span>
		{/if}
	</button>

	{#if open}
		<div
			class="fixed left-2 right-2 top-16 z-50 w-auto overflow-hidden rounded-lg border border-gray-700 bg-gray-900 shadow-xl sm:absolute sm:left-auto sm:right-0 sm:top-auto sm:mt-2 sm:w-80 sm:max-w-[calc(100vw-1rem)]"
		>
			<div class="flex items-center justify-between border-b border-gray-700 px-4 py-2.5">
				<span class="text-sm font-semibold text-gray-200">Recent activity</span>
				<span class="text-xs text-gray-500"
					>{items.length} event{items.length === 1 ? "" : "s"}</span
				>
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
							<a
								href="/migrate/{item.migrationId}"
								onclick={() => (open = false)}
								class="flex items-start gap-2.5 px-4 py-2.5 transition-colors hover:bg-gray-800"
							>
								<span class="mt-0.5 shrink-0 {meta.color}"
									><Octicon name={meta.icon} size={16} /></span
								>
								<span class="min-w-0 flex-1">
									<span class="flex items-center justify-between gap-2">
										<span class="truncate text-sm font-medium text-gray-100">{item.repo}</span>
										<span class="shrink-0 text-xs text-gray-500"
											>{timeAgo(item.createdAt)}</span
										>
									</span>
									<span class="mt-0.5 flex items-center gap-1.5">
										<span class="text-xs {meta.color}">{meta.label}</span>
										{#if item.summary}
											<span class="truncate text-xs text-gray-500"> · {item.summary}</span>
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