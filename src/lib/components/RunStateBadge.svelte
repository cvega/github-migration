<!-- Run-state pill — the shared lifecycle badge for profile org/enterprise runs. -->
<script lang="ts">
	import Octicon from './Octicon.svelte';

	type RunState = 'running' | 'paused' | 'completed' | 'failed';

	let {
		state,
		compact = false,
	}: {
		/** Lifecycle state of the run. */
		state: RunState;
		/** Tighter padding for dense list/child rows; default is the header size. */
		compact?: boolean;
	} = $props();

	// Label, color, and icon per state. The running badge spins its sync icon.
	const BADGES: Record<
		RunState,
		{ label: string; cls: string; icon: 'sync' | 'pause' | 'check-circle-fill' | 'x-circle-fill' }
	> = {
		running: { label: 'Running', cls: 'bg-blue-500/15 text-blue-300', icon: 'sync' },
		paused: { label: 'Paused', cls: 'bg-amber-500/15 text-amber-300', icon: 'pause' },
		completed: { label: 'Completed', cls: 'bg-green-500/15 text-green-300', icon: 'check-circle-fill' },
		failed: { label: 'Failed', cls: 'bg-red-500/15 text-red-300', icon: 'x-circle-fill' }
	};

	const badge = $derived(BADGES[state]);
</script>

<span
	class="inline-flex items-center gap-1 rounded-full {compact ? 'px-2' : 'px-2.5'} py-0.5 text-xs font-medium {badge.cls}"
>
	<Octicon name={badge.icon} size={12} class={state === 'running' ? 'animate-spin' : ''} />
	{badge.label}
</span>
