<script lang="ts">
	import { onDestroy } from "svelte";
	import { afterNavigate, goto } from "$app/navigation";
	import { page } from "$app/state";
	import Octicon from "$lib/components/Octicon.svelte";

	let searchInput = $state(page.url.searchParams.get("q") ?? "");
	let searchInputElement: HTMLInputElement | null = null;
	let searchDebounce: ReturnType<typeof setTimeout> | null = null;

	function captureSearchInput(node: HTMLInputElement) {
		searchInputElement = node;
		return () => {
			if (searchInputElement === node) searchInputElement = null;
		};
	}

	afterNavigate(() => {
		searchInput = page.url.searchParams.get("q") ?? "";
	});

	function navigateSearch(value: string) {
		const params = new URLSearchParams(page.url.searchParams.toString());
		const trimmed = value.trim();
		if (trimmed) params.set("q", trimmed);
		else params.delete("q");
		params.delete("page");
		params.delete("bp");
		const query = params.toString();
		goto(query ? `/migrate?${query}` : "/migrate", { reset: false });
	}

	function onSearchInput() {
		if (searchDebounce) clearTimeout(searchDebounce);
		searchDebounce = setTimeout(() => navigateSearch(searchInput), 250);
	}

	function submitSearch(event: SubmitEvent) {
		event.preventDefault();
		if (searchDebounce) clearTimeout(searchDebounce);
		navigateSearch(searchInput);
	}

	function clearSearch() {
		if (searchDebounce) clearTimeout(searchDebounce);
		searchInput = "";
		navigateSearch("");
		searchInputElement?.focus();
	}

	function focusSearchShortcut(event: KeyboardEvent) {
		if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
		const target = event.target;
		if (
			target instanceof HTMLInputElement ||
			target instanceof HTMLTextAreaElement ||
			target instanceof HTMLSelectElement ||
			(target instanceof HTMLElement && target.isContentEditable)
		) {
			return;
		}
		event.preventDefault();
		searchInputElement?.focus();
	}

	onDestroy(() => {
		if (searchDebounce) clearTimeout(searchDebounce);
	});
</script>

<svelte:window onkeydown={focusSearchShortcut} />

<search aria-label="Migration search" class="block w-full">
	<form
		onsubmit={submitSearch}
		class="group flex h-8 w-full overflow-hidden rounded-md border border-gray-700 bg-gray-950 transition-colors hover:border-gray-600 focus-within:border-blue-500 focus-within:ring-1 focus-within:ring-blue-500"
	>
		<div class="relative flex min-w-0 flex-1 items-center">
			<span class="pointer-events-none absolute left-2.5 flex items-center text-gray-500">
				<Octicon name="search" size={16} />
			</span>
			<input
				{@attach captureSearchInput}
				type="search"
				bind:value={searchInput}
				oninput={onSearchInput}
				aria-label="Search migrations"
				aria-keyshortcuts="/"
				autocomplete="off"
				spellcheck="false"
				class="h-full w-full appearance-none bg-transparent pr-8 pl-8 text-sm text-gray-100 focus:outline-none [&::-webkit-search-cancel-button]:appearance-none"
			/>
			{#if !searchInput}
				<span
					class="pointer-events-none absolute left-8 flex items-center gap-1.5 whitespace-nowrap text-sm text-gray-400"
				>
					Type
					<kbd
						class="inline-flex h-4 min-w-4 items-center justify-center rounded-sm border border-gray-500 px-0.5 font-sans text-xs leading-none text-gray-300"
						>/</kbd
					>
					to search
				</span>
			{:else}
			<button
				type="button"
				onclick={clearSearch}
				aria-label="Clear migration search"
				class="absolute inset-y-0 right-1 flex items-center rounded p-1 text-gray-500 transition-colors hover:text-gray-200 focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:outline-none"
			>
				<Octicon name="x-circle-fill" size={16} />
			</button>
			{/if}
		</div>
		<button
			type="submit"
			aria-label="Submit migration search"
			title="Search"
			class="flex w-8 shrink-0 items-center justify-center border-l border-gray-700 text-gray-400 transition-colors hover:bg-gray-800 hover:text-gray-200 focus-visible:bg-gray-800 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-400 focus-visible:outline-none"
		>
			<Octicon name="terminal" size={16} />
		</button>
	</form>
</search>