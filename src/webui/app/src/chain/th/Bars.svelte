<script lang="ts">
  // A bar chart of a few hundred values at most (the blocks of a window, the days of a month): one or two
  // bars at each place, a line over them on a scale of its own, the first, middle and last labels under
  // them. Each place has its title (what a pointer over it shows). Drawn in SVG, coloured by classes.
  let {
    series,
    line = null,
    labels,
    titles,
    label,
    height = 150,
    hot = null,
  }: {
    /** One or two series of values (≥ 0), the same length; a class each ('bar', 'bar out'). */
    series: { values: number[]; cls: string }[];
    /** A line on its own scale (0..its max). */
    line?: number[] | null;
    labels: string[];
    titles: string[];
    label: string;
    height?: number;
    /** Places drawn in the warning colour (a block above a share of its weight). */
    hot?: boolean[] | null;
  } = $props();

  let width = $state(600);
  const PAD = { top: 8, bottom: 20, left: 4, right: 4 };
  const count = $derived(series[0]?.values.length ?? 0);
  const max = $derived(Math.max(1e-9, ...series.flatMap((s) => s.values)));
  const lineMax = $derived(line && line.length ? Math.max(1e-9, ...line) : 1);
  const plotW = $derived(Math.max(10, width - PAD.left - PAD.right));
  const plotH = $derived(height - PAD.top - PAD.bottom);
  const slot = $derived(count ? plotW / count : plotW);
  const barW = $derived(Math.max(1, (slot * 0.78) / Math.max(1, series.length)));
  const y = (v: number, m: number) => PAD.top + plotH - (v / m) * plotH;
  const linePath = $derived.by(() => {
    if (!line || line.length < 2) return '';
    return line.map((v, i) => `${i ? 'L' : 'M'}${(PAD.left + slot * (i + 0.5)).toFixed(1)} ${y(v, lineMax).toFixed(1)}`).join('');
  });
  const ticks = $derived(count ? [...new Set([0, Math.floor((count - 1) / 2), count - 1])] : []);
</script>

<div class="bars" bind:clientWidth={width}>
  <svg class="th-chart" role="img" aria-label={label} viewBox="0 0 {width} {height}" {width} {height}>
    <line class="grid" x1={PAD.left} x2={width - PAD.right} y1={PAD.top + plotH + 0.5} y2={PAD.top + plotH + 0.5} />
    <line class="grid" x1={PAD.left} x2={width - PAD.right} y1={PAD.top + plotH / 2} y2={PAD.top + plotH / 2} />
    {#each { length: count } as _, i (i)}
      <g>
        <title>{titles[i] ?? ''}</title>
        <rect class="hit" x={PAD.left + slot * i} y={PAD.top} width={slot} height={plotH} fill="transparent" />
        {#each series as s, k (k)}
          {@const v = s.values[i] ?? 0}
          {@const h = Math.max(v > 0 ? 1 : 0, (v / max) * plotH)}
          <rect class={s.cls} class:hot={hot?.[i] && k === 0} x={PAD.left + slot * i + (slot - barW * series.length) / 2 + barW * k} y={PAD.top + plotH - h} width={barW} height={h} rx={Math.min(2, barW / 3)} />
        {/each}
      </g>
    {/each}
    {#if linePath}<path class="line" d={linePath} />{/if}
    {#each ticks as i (i)}
      <text x={PAD.left + slot * (i + 0.5)} y={height - 5} text-anchor={i === 0 ? 'start' : i === count - 1 ? 'end' : 'middle'}>{labels[i] ?? ''}</text>
    {/each}
  </svg>
</div>

<style>
  .bars {
    width: 100%;
    min-width: 0;
  }
</style>
