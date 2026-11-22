<script lang="ts">
	import Octicon from "$lib/components/Octicon.svelte";
	import type { NewMigrationController } from "./workflow.svelte";

	let { controller, compact = false }: { controller: NewMigrationController; compact?: boolean } = $props();
	const choices = [
		{ value: "dry-run", label: "Keep source unlocked", detail: "Do not lock or archive the source." },
		{ value: "production", label: "Lock and archive source", detail: "Lock during migration. Archive after success." },
	] as const;
</script>

<fieldset>
	<legend class="text-sm font-medium text-gray-300">Source repository handling</legend>
	<p class="mt-1 text-sm text-gray-400">Both choices write repository data to the destination.</p>
	<div class={["mt-3 grid gap-2", !compact && "sm:grid-cols-2"]}>
		{#each choices as choice (choice.value)}
			<button
				type="button"
				aria-pressed={controller.form.state.migrationMode === choice.value}
				onclick={() => {
					controller.form.state.migrationMode = choice.value;
					controller.error = "";
				}}
				class="flex items-start gap-2 rounded-md border border-gray-700 p-3 text-left hover:bg-gray-800 aria-pressed:border-blue-500/50 aria-pressed:bg-blue-500/10"
			>
				<Octicon name={choice.value === "production" ? "shield-lock" : "repo"} size={16} class="mt-0.5 shrink-0 text-gray-400" />
				<span>
					<span class="block text-sm font-medium text-gray-100">{choice.label}</span>
					<span class="block text-xs text-gray-400">{choice.detail}</span>
				</span>
			</button>
		{/each}
	</div>
</fieldset>
