<script lang="ts">
	import { siBitbucket, siGitlab } from "simple-icons";
	import { ICONS, type UsedIconName } from "$lib/icons.generated";

	type BrandIconName = "gitlab-logo" | "bitbucket-logo";

	let {
		name,
		size = 16,
		class: className = "",
	}: {
		name: UsedIconName | BrandIconName;
		size?: 12 | 16 | 24;
		class?: string;
	} = $props();

	const brandIcon = $derived(
		name === "gitlab-logo" ? siGitlab : name === "bitbucket-logo" ? siBitbucket : null,
	);
	const icon = $derived(brandIcon ? null : ICONS[name as UsedIconName]);
	const height = $derived(icon ? (size === 24 ? icon[24] : icon[16]) : null);
</script>

{#if brandIcon}
	<svg
		class="inline-block align-text-bottom {className}"
		viewBox="0 0 24 24"
		width={size}
		height={size}
		aria-hidden="true"
	>
		<path d={brandIcon.path} fill="#{brandIcon.hex}"></path>
	</svg>
{:else if height}
	<svg
		class="inline-block fill-current align-text-bottom {className}"
		viewBox="0 0 {height.width} {height.height}"
		width={size}
		height={size}
		aria-hidden="true"
	>
		{#each height.paths as path (path.d)}
			<path
				d={path.d}
				fill={path.fill}
				fill-rule={path.fillRule}
				clip-rule={path.clipRule}
			></path>
		{/each}
	</svg>
{/if}