<script lang="ts">
	import Octicon from "$lib/components/Octicon.svelte";

	let {
		label,
		isApp = false,
		rateText,
		ratePct = -1,
		migrating = false,
	}: {
		label: string;
		isApp?: boolean;
		rateText: string;
		ratePct?: number;
		migrating?: boolean;
	} = $props();

	const tier = $derived.by(() => {
		if (ratePct < 0) return "neutral";
		if (ratePct > 50) return "green";
		if (ratePct > 25) return "yellow";
		if (ratePct > 10) return "orange";
		return "red";
	});

	const rateClass = $derived(
		tier === "green" || tier === "neutral"
			? "text-gray-300"
			: tier === "yellow"
				? "text-yellow-400"
				: tier === "orange"
					? "text-orange-500"
					: "text-red-500",
	);
</script>

<span
	class="inline-flex items-center gap-2 text-xs leading-4"
	title={`${label} ${isApp ? "GitHub App" : "personal access token"}: ${rateText} API requests remaining`}
>
	<Octicon name={isApp ? "shield-lock" : "key"} size={12} class={migrating ? "animate-pulse text-gray-400" : "text-gray-500"} />
	<span class="font-medium text-gray-400">{label} {isApp ? "GitHub App" : "API token"}</span>
	<strong class="font-semibold tabular-nums {rateClass}">{rateText}</strong>
</span>