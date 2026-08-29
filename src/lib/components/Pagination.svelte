<script lang="ts">
	import Octicon from "$lib/components/Octicon.svelte";

	let {
		page,
		totalPages,
		total,
		limit,
		onPageChange,
	}: {
		page: number;
		totalPages: number;
		total: number;
		limit: number;
		onPageChange: (page: number) => void;
	} = $props();

	const rangeStart = $derived((page - 1) * limit + 1);
	const rangeEnd = $derived(Math.min(page * limit, total));
	const visiblePages = $derived.by(() => {
		const pages: Array<number | "..."> = [];
		if (totalPages <= 7) {
			for (let current = 1; current <= totalPages; current += 1) pages.push(current);
		} else {
			pages.push(1);
			if (page > 3) pages.push("...");
			const start = Math.max(2, page - 1);
			const end = Math.min(totalPages - 1, page + 1);
			for (let current = start; current <= end; current += 1) pages.push(current);
			if (page < totalPages - 2) pages.push("...");
			pages.push(totalPages);
		}
		return pages;
	});
</script>

{#if totalPages > 1}
	<nav aria-label="Pagination" class="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-gray-700 px-1 pt-4">
		<span class="text-xs text-gray-500">{rangeStart}-{rangeEnd} of {total.toLocaleString()}</span>
		<div class="flex flex-wrap items-center gap-1">
			<button type="button" disabled={page <= 1} onclick={() => onPageChange(page - 1)} class="inline-flex items-center rounded px-2 py-1 text-xs text-gray-400 transition-colors hover:bg-gray-800 hover:text-gray-50 disabled:pointer-events-none disabled:opacity-30">
				<Octicon name="chevron-left" size={16} />Previous
			</button>
			{#each visiblePages as visiblePage}
				{#if visiblePage === "..."}
					<span class="px-1.5 py-1 text-xs text-gray-600">...</span>
				{:else}
					<button type="button" onclick={() => onPageChange(visiblePage)} aria-current={visiblePage === page ? "page" : undefined} class="rounded px-2.5 py-1 text-xs font-medium transition-colors {visiblePage === page ? 'bg-blue-600 text-white' : 'text-gray-400 hover:bg-gray-800 hover:text-gray-50'}">{visiblePage}</button>
				{/if}
			{/each}
			<button type="button" disabled={page >= totalPages} onclick={() => onPageChange(page + 1)} class="inline-flex items-center rounded px-2 py-1 text-xs text-gray-400 transition-colors hover:bg-gray-800 hover:text-gray-50 disabled:pointer-events-none disabled:opacity-30">
				Next<Octicon name="chevron-right" size={16} />
			</button>
		</div>
	</nav>
{/if}