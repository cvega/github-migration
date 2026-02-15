<!-- Reusable pagination controls -->
<script lang="ts">
	import Octicon from '$lib/components/Octicon.svelte';

	interface Props {
		page: number;
		totalPages: number;
		total: number;
		limit: number;
		onPageChange: (page: number) => void;
	}

	let { page, totalPages, total, limit, onPageChange }: Props = $props();

	const rangeStart = $derived((page - 1) * limit + 1);
	const rangeEnd = $derived(Math.min(page * limit, total));

	// Build visible page numbers: show max 7, collapsing edges with ellipsis.
	const visiblePages = $derived.by(() => {
		const pages: (number | '...')[] = [];
		if (totalPages <= 7) {
			for (let i = 1; i <= totalPages; i++) pages.push(i);
		} else {
			pages.push(1);
			if (page > 3) pages.push('...');
			const start = Math.max(2, page - 1);
			const end = Math.min(totalPages - 1, page + 1);
			for (let i = start; i <= end; i++) pages.push(i);
			if (page < totalPages - 2) pages.push('...');
			pages.push(totalPages);
		}
		return pages;
	});
</script>

{#if totalPages > 1}
	<div class="flex items-center justify-between border-t border-gray-700 px-1 pt-4">
		<span class="text-xs text-gray-500">
			{rangeStart}–{rangeEnd} of {total.toLocaleString()}
		</span>

		<div class="flex items-center gap-1">
			<!-- Prev -->
			<button
				type="button"
				disabled={page <= 1}
				onclick={() => onPageChange(page - 1)}
				class="rounded px-2 py-1 text-xs text-gray-400 hover:bg-gray-800 hover:text-gray-50 disabled:opacity-30 disabled:pointer-events-none transition-colors"
			>
				<Octicon name="chevron-left" size={16} />
				Prev
			</button>

			<!-- Page numbers -->
			{#each visiblePages as p}
				{#if p === '...'}
					<span class="px-1.5 py-1 text-xs text-gray-600">…</span>
				{:else}
					<button
						type="button"
						onclick={() => onPageChange(p)}
						class="rounded px-2.5 py-1 text-xs font-medium transition-colors
							{p === page ? 'bg-blue-600 text-white' : 'text-gray-400 hover:bg-gray-800 hover:text-gray-50'}"
					>
						{p}
					</button>
				{/if}
			{/each}

			<!-- Next -->
			<button
				type="button"
				disabled={page >= totalPages}
				onclick={() => onPageChange(page + 1)}
				class="rounded px-2 py-1 text-xs text-gray-400 hover:bg-gray-800 hover:text-gray-50 disabled:opacity-30 disabled:pointer-events-none transition-colors"
			>
				Next
				<Octicon name="chevron-right" size={16} />
			</button>
		</div>
	</div>
{/if}
