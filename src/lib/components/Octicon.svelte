<!-- Render a Primer Octicon as inline SVG -->
<script lang="ts">
	import octicons, { type IconName } from '@primer/octicons';

	let {
		name,
		size = 16,
		class: className = ''
	}: {
		name: IconName;
		size?: 12 | 16 | 24;
		class?: string;
	} = $props();

	const icon = $derived(octicons[name]);
	const height = $derived(icon?.heights[size] ?? icon?.heights[16]);
</script>

{#if height}
	<svg
		class="octicon inline-block align-text-bottom fill-current {className}"
		viewBox="0 0 {height.options.width} {height.options.height}"
		width={size}
		height={size}
		aria-hidden="true"
	>
		{@html height.path}
	</svg>
{/if}
