<!-- Pause/Resume controls for a profile run — cooperative pause + resume over the run's API. -->
<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import Octicon from './Octicon.svelte';

	type RunState = 'running' | 'paused' | 'completed' | 'failed';

	let {
		runState,
		endpoint,
		onRefresh,
		onResumed,
	}: {
		/** Current run state — drives which button (if any) shows. */
		runState: RunState;
		/** API base for this run, e.g. `/api/profile/{id}` or `/api/profile/enterprise/{id}`. */
		endpoint: string;
		/** Refetch the run snapshot after a pause is requested. */
		onRefresh: () => Promise<void> | void;
		/** Clear any stale polled snapshot before the post-resume reload. */
		onResumed?: () => void;
	} = $props();

	// Pause is cooperative: the POST only flags the request; the crawl stops at its
	// next checkpoint and flips to `paused`, delivered over SSE. `pausing` shows
	// "Pausing…" — true once requested and while still running, so it clears itself
	// the moment the run leaves the running state (and a resume resets the flag).
	let pauseRequested = $state(false);
	let resuming = $state(false);
	const pausing = $derived(pauseRequested && runState === 'running');

	async function pauseRun() {
		if (pausing) return;
		pauseRequested = true;
		try {
			await fetch(`${endpoint}/pause`, { method: 'POST' });
			await onRefresh();
		} catch {
			// Non-fatal — the crawl keeps running; let the user retry.
			pauseRequested = false;
		}
	}

	async function resumeRun() {
		if (resuming) return;
		resuming = true;
		pauseRequested = false; // a fresh run cycle — drop any stale pause flag
		try {
			const res = await fetch(`${endpoint}/resume`, { method: 'POST' });
			if (res.ok) {
				// Re-open the live stream: clear the stale paused snapshot, then reload
				// the loader data so the SSE effect re-subscribes.
				onResumed?.();
				await invalidateAll();
			}
		} catch {
			// Non-fatal — the run stays paused/failed; the user can retry.
		} finally {
			resuming = false;
		}
	}
</script>

{#if runState === 'running'}
	<button
		type="button"
		onclick={pauseRun}
		disabled={pausing}
		class="inline-flex items-center gap-1.5 rounded-md border border-gray-700 bg-gray-800 px-3 py-1.5 text-sm font-medium text-gray-200 transition-colors hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-60"
	>
		<Octicon name="pause" size={16} />
		{pausing ? 'Pausing…' : 'Pause'}
	</button>
{:else if runState === 'paused' || runState === 'failed'}
	<button
		type="button"
		onclick={resumeRun}
		disabled={resuming}
		class="inline-flex items-center gap-1.5 rounded-md border border-blue-500/30 bg-blue-500/15 px-3 py-1.5 text-sm font-medium text-blue-200 transition-colors hover:bg-blue-500/25 disabled:cursor-not-allowed disabled:opacity-60"
	>
		<Octicon name="play" size={16} />
		{resuming ? 'Resuming…' : 'Resume'}
	</button>
{/if}
