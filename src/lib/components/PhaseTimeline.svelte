<!-- Phase timeline visualization -->
<script lang="ts">
  import type { IconName } from "@primer/octicons";
  import Octicon from "$lib/components/Octicon.svelte";
  import type { Phase } from "$lib/types";

  let {
    currentPhase,
    failed = false,
  }: { currentPhase: Phase; failed?: boolean } = $props();

  const steps: { phase: Phase; label: string; icon: IconName }[] = [
    { phase: "PENDING_VALIDATION", label: "Validating", icon: "shield-check" },
    { phase: "QUEUED", label: "Queued", icon: "clock" },
    { phase: "EXPORTING", label: "Exporting", icon: "download" },
    { phase: "IMPORTING_GIT", label: "Git Import", icon: "repo-push" },
    { phase: "IMPORTING_METADATA", label: "Metadata", icon: "note" },
    { phase: "SUCCEEDED", label: "Done", icon: "check-circle" },
  ];

  const phaseOrder = steps.map((s) => s.phase);

  function getStatus(
    phase: Phase,
  ): "completed" | "active" | "upcoming" | "failed" {
    if (failed && phase === currentPhase) return "failed";
    const currentIdx = phaseOrder.indexOf(currentPhase);
    const stepIdx = phaseOrder.indexOf(phase);
    if (stepIdx < currentIdx) return "completed";
    if (stepIdx === currentIdx) return "active";
    return "upcoming";
  }
</script>

<div
  class="flex items-center gap-1 overflow-x-auto rounded-md border border-gray-700 bg-gray-900 px-4 py-3"
>
  {#each steps as step, i}
    {@const status = getStatus(step.phase)}
    <!-- Connector line -->
    {#if i > 0}
      <div
        class="h-0.5 w-8 shrink-0
				{status === 'upcoming' ? 'bg-gray-700' : 'bg-green-500/50'}"
      ></div>
    {/if}

    <!-- Step dot + label -->
    <div class="flex shrink-0 flex-col items-center gap-1">
      <div
        class="flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold
				{status === 'completed'
          ? 'bg-green-500/20 text-green-400 ring-1 ring-green-500/30'
          : status === 'active'
            ? 'bg-green-500/20 text-green-400 ring-2 ring-green-500 animate-pulse'
            : status === 'failed'
              ? 'bg-red-500/20 text-red-400 ring-2 ring-red-500'
              : 'bg-gray-800 text-gray-600 ring-1 ring-gray-700'}"
      >
        {#if status === "completed"}
          <Octicon name="check" size={12} />
        {:else if status === "failed"}
          <Octicon name="x" size={12} />
        {:else if status === "active"}
          <Octicon name={step.icon} size={12} />
        {:else}
          <Octicon name={step.icon} size={12} />
        {/if}
      </div>
      <span
        class="text-xs
				{status === 'completed'
          ? 'text-green-400'
          : status === 'active'
            ? 'text-green-400 font-medium'
            : status === 'failed'
              ? 'text-red-400 font-medium'
              : 'text-gray-600'}"
      >
        {step.label}
      </span>
    </div>
  {/each}
</div>
