<script lang="ts">
	import { tick } from 'svelte';
	import Octicon from '$lib/components/Octicon.svelte';
	import type { UsedIconName as IconName } from '$lib/icons.generated';

	type FilterOption = {
		value: string;
		label: string;
		href: string;
	};

	let {
		id,
		name,
		label,
		icon,
		value,
		options,
		minWidth = '10rem',
	}: {
		id: string;
		name: string;
		label: string;
		icon: IconName;
		value: string;
		options: FilterOption[];
		minWidth?: string;
	} = $props();

	let open = $state(false);
	let query = $state('');
	let root = $state<HTMLDivElement>();
	let trigger = $state<HTMLButtonElement>();
	let filterInput = $state<HTMLInputElement>();
	let optionElements = $state<HTMLAnchorElement[]>([]);
	const selected = $derived(options.find((option) => option.value === value) ?? options[0]);
	const filteredOptions = $derived(
		options.filter((option) => option.label.toLowerCase().includes(query.trim().toLowerCase())),
	);

	async function showPanel() {
		open = true;
		query = '';
		await tick();
		filterInput?.focus();
	}

	function hidePanel(returnFocus = false) {
		open = false;
		query = '';
		if (returnFocus) trigger?.focus();
	}

	function togglePanel() {
		if (open) {
			hidePanel();
			return;
		}
		void showPanel();
	}

	function handleOutsidePointer(event: PointerEvent) {
		if (open && event.target instanceof Node && !root?.contains(event.target)) {
			hidePanel();
		}
	}

	function handleWindowKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape' && open) {
			event.preventDefault();
			hidePanel(true);
		}
	}

	function handleTriggerKeydown(event: KeyboardEvent) {
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			void showPanel();
		}
	}

	function handleOptionKeydown(event: KeyboardEvent, index: number) {
		let nextIndex: number | undefined;
		if (event.key === 'ArrowDown') nextIndex = (index + 1) % filteredOptions.length;
		if (event.key === 'ArrowUp') nextIndex = (index - 1 + filteredOptions.length) % filteredOptions.length;
		if (event.key === 'Home') nextIndex = 0;
		if (event.key === 'End') nextIndex = filteredOptions.length - 1;
		if (nextIndex === undefined) return;
		event.preventDefault();
		optionElements[nextIndex]?.focus();
	}
</script>

<svelte:window onpointerdown={handleOutsidePointer} onkeydown={handleWindowKeydown} />

<div bind:this={root} style:min-width={minWidth} class="relative grid flex-1 gap-1.5 text-xs font-medium text-gray-400 sm:flex-none">
	<span id={`${id}-label`} class="inline-flex items-center gap-1.5">
		<Octicon name={icon} size={12} />{label}
	</span>
	<input type="hidden" {name} {value} />
	<button
		bind:this={trigger}
		type="button"
		aria-expanded={open}
		aria-haspopup="dialog"
		aria-labelledby={`${id}-label ${id}-value`}
		onclick={togglePanel}
		onkeydown={handleTriggerKeydown}
		class="filter-trigger flex h-8 items-center gap-2 rounded-md px-3 text-xs font-medium normal-case outline-none"
	>
		<span id={`${id}-value`} class="min-w-0 flex-1 truncate text-left">{selected?.label ?? value}</span>
		<Octicon name="chevron-down" size={16} class="shrink-0 text-gray-400 transition-transform {open ? 'rotate-180' : ''}" />
	</button>

	{#if open}
		<div
			class="filter-panel absolute top-full left-0 z-30 mt-2 overflow-hidden rounded-md border border-gray-700 bg-gray-900 shadow-xl"
			role="dialog"
			aria-modal="false"
			aria-labelledby={`${id}-title`}
		>
			<div class="p-2 pb-0">
				<h3 id={`${id}-title`} class="px-1 pb-2 text-sm font-semibold normal-case text-gray-100">Select {label.toLowerCase()}</h3>
				<label class="relative block">
					<span class="pointer-events-none absolute top-1/2 left-2.5 flex -translate-y-1/2 text-gray-400">
						<Octicon name="search" size={16} />
					</span>
					<input
						bind:this={filterInput}
						bind:value={query}
						type="search"
						placeholder={`Filter ${label.toLowerCase()}s`}
						aria-label={`Filter ${label.toLowerCase()}s`}
						onkeydown={handleWindowKeydown}
						class="h-8 w-full rounded-md border border-gray-600 bg-gray-950 pr-3 pl-8 text-sm font-normal normal-case text-gray-200 outline-none placeholder:text-gray-500 focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
					/>
				</label>
			</div>

			<div class="mt-2 max-h-60 overflow-y-auto border-t border-gray-700 p-1">
				{#if filteredOptions.length > 0}
					<ul>
						{#each filteredOptions as option, index (option.value)}
							<li>
								<a
									bind:this={optionElements[index]}
									href={option.href}
									aria-current={option.value === value ? 'true' : undefined}
									onkeydown={(event) => handleOptionKeydown(event, index)}
									class="flex min-h-8 items-center gap-2 rounded-md px-2 py-1.5 text-sm font-normal normal-case text-gray-200 outline-none hover:bg-gray-800 focus-visible:bg-gray-800 focus-visible:ring-2 focus-visible:ring-blue-400 {option.value === value ? 'bg-gray-800' : ''}"
								>
									<span class="flex size-4 shrink-0 items-center justify-center rounded-sm border {option.value === value ? 'border-blue-500 bg-blue-600 text-white' : 'border-gray-500 bg-gray-950'}">
										{#if option.value === value}<Octicon name="check" size={16} />{/if}
									</span>
									<span class="whitespace-nowrap">{option.label}</span>
								</a>
							</li>
						{/each}
					</ul>
				{:else}
					<p class="px-3 py-5 text-center text-xs font-normal normal-case text-gray-500">No options found.</p>
				{/if}
			</div>
		</div>
	{/if}
</div>

<style>
	.filter-trigger {
		border: 1px solid var(--button-default-borderColor-rest);
		background: var(--button-default-bgColor-rest);
		box-shadow: var(--button-default-shadow-resting);
		color: var(--button-default-fgColor-rest);
	}

	.filter-trigger:hover,
	.filter-trigger[aria-expanded='true'] {
		background: var(--button-default-bgColor-hover);
	}

	.filter-trigger:active {
		background: var(--button-default-bgColor-active);
	}

	.filter-trigger:focus-visible {
		border-color: var(--fgColor-accent);
		outline: 2px solid var(--fgColor-accent);
		outline-offset: -1px;
	}

	.filter-panel {
		width: max-content;
		min-width: max(100%, 16rem);
		max-width: min(18rem, calc(100vw - 2rem));
	}
</style>