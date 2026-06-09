<!-- Seam-free segmented bar rendered as a single gradient (no sub-pixel gaps). -->
<script lang="ts">
	let {
		segments,
		class: cls = 'h-4'
	}: {
		segments: { value: number; color: string }[];
		class?: string;
	} = $props();

	const gradient = $derived.by(() => {
		const total = segments.reduce((sum, s) => sum + s.value, 0);
		if (total <= 0) return '';
		let acc = 0;
		const stops: string[] = [];
		for (const seg of segments) {
			if (seg.value <= 0) continue;
			const start = (acc / total) * 100;
			acc += seg.value;
			const end = (acc / total) * 100;
			stops.push(`${seg.color} ${start}% ${end}%`);
		}
		return `linear-gradient(to right, ${stops.join(', ')})`;
	});
</script>

<div
	class="overflow-hidden rounded-full bg-gray-800 {cls}"
	style={gradient ? `background: ${gradient};` : ''}
></div>
