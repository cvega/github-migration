<!-- Progress bar with label, current/total, optional rate -->
<script lang="ts">
  let {
    label,
    current,
    total,
    rate = 0,
    rateLabel = "",
  }: {
    label: string;
    current: number;
    total: number;
    rate?: number;
    rateLabel?: string;
  } = $props();

  const pct = $derived(
    total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0,
  );
</script>

<div class="rounded-md border border-gray-700 bg-gray-900 p-3">
  <div class="flex items-center justify-between text-sm">
    <span class="font-medium text-gray-300">{label}</span>
    <span class="text-gray-400">
      {current.toLocaleString()} / {total.toLocaleString()}
      <span class="text-gray-600">({pct}%)</span>
    </span>
  </div>
  <div class="mt-2 h-2 overflow-hidden rounded-full bg-gray-800">
    <div
      class="h-full rounded-full bg-green-500 transition-all duration-500"
      style="width: {pct}%"
    ></div>
  </div>
  {#if rate > 0 && rateLabel}
    <div class="mt-1 text-right text-xs text-gray-500">
      {Math.round(rate)}{rateLabel}
    </div>
  {/if}
</div>
