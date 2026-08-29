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

	const pillClass = $derived.by(() => {
		if (migrating) {
			switch (tier) {
				case "green":
					return "bg-green-600/15 text-green-400 ring-1 ring-green-500/30";
				case "yellow":
					return "bg-yellow-500/15 text-yellow-400 ring-1 ring-yellow-500/30";
				case "orange":
					return "bg-orange-500/15 text-orange-400 ring-1 ring-orange-500/30";
				case "red":
					return "bg-red-500/15 text-red-400 ring-1 ring-red-500/30";
				default:
					return "bg-yellow-500/15 text-yellow-400 ring-1 ring-yellow-500/30";
			}
		}
		switch (tier) {
			case "green":
				return isApp ? "bg-green-600/15 text-green-400" : "bg-gray-800 text-gray-400";
			case "yellow":
				return "bg-yellow-500/10 text-yellow-400";
			case "orange":
				return "bg-orange-500/10 text-orange-400";
			case "red":
				return "bg-red-500/10 text-red-400";
			default:
				return isApp ? "bg-green-600/15 text-green-400" : "bg-gray-800 text-gray-400";
		}
	});

	const rateClass = $derived(
		tier === "green"
			? migrating
				? "text-green-500"
				: "text-gray-500"
			: tier === "yellow"
				? "text-yellow-400"
				: tier === "orange"
					? "text-orange-500"
					: tier === "red"
						? "text-red-500"
						: migrating
							? "text-yellow-400"
							: "text-gray-500",
	);
</script>

<span class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium leading-4 transition-colors {pillClass}">
	<Octicon name={isApp ? "shield-lock" : "key"} size={12} class={migrating ? "animate-pulse" : ""} />
	<span>{label} <span class="opacity-70">·</span> {isApp ? "App" : "PAT"}</span>
	<span class="border-l border-current/20 pl-1.5 tabular-nums {rateClass}">{rateText}</span>
</span>