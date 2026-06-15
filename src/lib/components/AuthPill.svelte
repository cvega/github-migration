<!-- Auth rate-limit pill — colors based on remaining API quota -->
<script lang="ts">
	import Octicon from './Octicon.svelte';

	let {
		label,
		isApp = false,
		rateText,
		ratePct = -1,
		migrating = false,
	}: {
		/** "Source" or "Target" */
		label: string;
		/** Whether this side uses GitHub App auth */
		isApp?: boolean;
		/** Formatted rate text, e.g. "4.9K/5K" */
		rateText: string;
		/** Remaining rate as 0–100 percentage, or -1 if unknown */
		ratePct?: number;
		/** Whether migrations are actively running */
		migrating?: boolean;
	} = $props();

	// Color tiers based on remaining rate-limit percentage.
	//   > 50%  → green (healthy)
	//   25–50% → yellow (moderate)
	//   10–25% → orange (low)
	//   < 10%  → red (critical)
	const tier = $derived.by(() => {
		if (ratePct < 0) return 'neutral'; // no live data
		if (ratePct > 50) return 'green';
		if (ratePct > 25) return 'yellow';
		if (ratePct > 10) return 'orange';
		return 'red';
	});

	const pillClass = $derived.by(() => {
		if (migrating) {
			// When migrating, follow the rate-limit color tier.
			switch (tier) {
				case 'green': return 'bg-green-600/15 text-green-400 ring-1 ring-green-500/30';
				case 'yellow': return 'bg-yellow-500/15 text-yellow-400 ring-1 ring-yellow-500/30';
				case 'orange': return 'bg-orange-500/15 text-orange-400 ring-1 ring-orange-500/30';
				case 'red': return 'bg-red-500/15 text-red-400 ring-1 ring-red-500/30';
				default: return 'bg-yellow-500/15 text-yellow-400 ring-1 ring-yellow-500/30';
			}
		}
		// Idle: subtle color based on tier.
		switch (tier) {
			case 'green': return isApp ? 'bg-green-600/15 text-green-400' : 'bg-gray-800 text-gray-400';
			case 'yellow': return 'bg-yellow-500/10 text-yellow-400';
			case 'orange': return 'bg-orange-500/10 text-orange-400';
			case 'red': return 'bg-red-500/10 text-red-400';
			default: return isApp ? 'bg-green-600/15 text-green-400' : 'bg-gray-800 text-gray-400';
		}
	});

	const rateClass = $derived.by(() => {
		switch (tier) {
			case 'green': return migrating ? 'text-green-500' : 'text-gray-500';
			case 'yellow': return 'text-yellow-400';
			case 'orange': return 'text-orange-500';
			case 'red': return 'text-red-500';
			default: return migrating ? 'text-yellow-400' : 'text-gray-500';
		}
	});

	const shouldPulse = $derived(migrating);
</script>

<span class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium leading-4 transition-colors {pillClass}">
	<Octicon name={isApp ? 'shield-lock' : 'key'} size={12} class={shouldPulse ? 'animate-pulse' : ''} />
	<span>{label} <span class="opacity-70">·</span> {isApp ? 'App' : 'PAT'}</span>
	<span class="border-l border-current/20 pl-1.5 tabular-nums {rateClass}">{rateText}</span>
</span>
