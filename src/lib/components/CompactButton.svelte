<script lang="ts">
	import type { Snippet } from "svelte";
	import type { HTMLButtonAttributes } from "svelte/elements";

	type Props = { children: Snippet } & (
		| { href: string }
		| ({ href?: undefined } & Omit<HTMLButtonAttributes, "children" | "class">)
	);

	let props: Props = $props();
</script>

{#if props.href !== undefined}
	<a href={props.href} class="compact-neutral-action">{@render props.children()}</a>
{:else}
	{@const { children, href, ...attributes } = props}
	<button type="button" {...attributes} class="compact-neutral-action">{@render children()}</button>
{/if}
