<script lang="ts">
  // Throughput: what the chain carries. Over a window of the latest blocks (getblockstats of each, kept
  // and asked again only for new ones): transactions a second and per block, how full the blocks are
  // against the 32 million weight units of a block of Thunder, the fees and their rates, the time between
  // blocks; a chart of each block and the blocks as a table (a click opens one in the explorer). The
  // Mempool tab: what waits for a block, how many blocks it would take, the fee estimates of the node, and
  // the counts of the whole chain (getchaintxstats). The capacity of the chain against what it uses.
  import DataTable from '../../components/DataTable.svelte';
  import Icon from '../../components/Icon.svelte';
  import Meter from '../../components/Meter.svelte';
  import SafeText from '../../components/SafeText.svelte';
  import TabRow from '../../components/TabRow.svelte';
  import { formatBytes, formatCount, formatTime, niceTimeOffset, shortDuration, shortHash } from '../../lib/format';
  import { t, tn } from '../../lib/i18n.svelte';
  import { go, nav } from '../../lib/nav.svelte';
  import { app, node, prefs } from '../../lib/state.svelte';
  import type { Column } from '../../lib/table';
  import { formatAmount } from '../../lib/units';
  import '../th/th.css';
  import Term from '../../components/Term.svelte';
  import { simpleMode } from '../../lib/uimode.svelte';
  import Bars from '../th/Bars.svelte';
  import { blocksToClear, capacityOf, formatRate, formatShare, MAX_BLOCK_WEIGHT, throughputOf, type BlockStat } from '../th/model';
  import { ESTIMATE_TARGETS, refreshBlocks, refreshChain, th, watchMempool } from '../th/store.svelte';

  type Tab = 'blocks' | 'mempool';
  const WINDOWS = [30, 100, 300] as const;

  let tab = $state<Tab>('blocks');
  let windowSize = $state<number>(100);
  let selected: string | null = $state(null);
  let sortKey: string | null = $state('height');
  let sortDir: 'asc' | 'desc' = $state('desc');

  $effect(() => {
    const asked = nav.tab;
    if (nav.page !== 'throughput' || !asked) return;
    if (asked === 'blocks' || asked === 'mempool') tab = asked;
    nav.tab = '';
  });

  // The blocks of the window, again with each new block; the counts of the chain too.
  $effect(() => {
    void node.tip?.hash;
    const n = windowSize;
    void refreshBlocks(n);
    void refreshChain(Math.max(n, 2016));
  });
  // The mempool while the page shows (its timer rests while the window is hidden).
  $effect(() => watchMempool(10));

  const spacing = $derived(app.info?.blockSpacing ?? 600);
  const blocks = $derived(th.blocks.slice(-windowSize));
  const tp = $derived(throughputOf(blocks));
  const capacity = $derived(capacityOf(spacing));
  const used = $derived(tp.tps !== null && capacity.perSecond > 0 ? tp.tps / capacity.perSecond : 0);
  const last = $derived(blocks.length ? blocks[blocks.length - 1] : null);
  const mempool = $derived(th.mempool);

  // Simple mode (lib/uimode.svelte.ts): how busy the chain is, without outputs, fee rates, hashes or memory.
  const simple = $derived(simpleMode());
  const allColumns: Column<BlockStat>[] = [
    { key: 'height', label: 'Height', value: (b) => b.height, width: '5.2rem', align: 'end' },
    { key: 'time', label: 'Time', value: (b) => b.time, width: '8.8rem', noFilter: true },
    { key: 'txs', label: 'Transactions', value: (b) => b.txs, width: '6.8rem', align: 'end', noFilter: true },
    { key: 'outs', label: 'Outputs', value: (b) => b.outs, width: '5.5rem', align: 'end', noFilter: true },
    { key: 'fill', label: 'Fill', value: (b) => b.weight, width: 'minmax(7rem, 1.2fr)', noFilter: true },
    { key: 'fees', label: 'Fees', value: (b) => b.fees, width: 'minmax(7rem, 1fr)', align: 'end', noFilter: true },
    { key: 'rate', label: 'Fee rate', value: (b) => b.feeRate, width: '6.5rem', align: 'end', noFilter: true },
    { key: 'hash', label: 'Hash', value: (b) => b.hash, width: 'minmax(6rem, 1fr)', mono: true },
  ];
  const columns = $derived(simple ? allColumns.filter((c) => !['outs', 'rate', 'hash'].includes(c.key)) : allColumns);

  function rateText(satPerVb: number | null | undefined): string {
    if (satPerVb === null || satPerVb === undefined || !Number.isFinite(satPerVb)) return '–';
    return `${satPerVb < 10 ? satPerVb.toFixed(2) : Math.round(satPerVb)} sat/vB`;
  }
  const fees = (sats: number) => formatAmount(BigInt(Math.round(sats)), prefs.unit, { withUnit: true, trim: true, minDecimals: 2 });
</script>

<div class="page th-page throughput">
  <header class="th-head">
    <div>
      <h1>Throughput</h1>
      <p class="th-sub">{simple ? t('How busy Thunder is: the payments of each block, and how much room is left.') : t('Blocks of up to %1 million weight units: what the chain carries, and what it could.', MAX_BLOCK_WEIGHT / 1_000_000)}</p>
    </div>
    <div class="th-tools">
      <div class="th-chips" role="group" aria-label="Blocks counted">
        {#each WINDOWS as w (w)}
          <button type="button" aria-pressed={windowSize === w} onclick={() => (windowSize = w)}>{tn('%n block(s)', w)}</button>
        {/each}
      </div>
      {#if th.loading}<span class="faint small" role="status">Reading the blocks…</span>{/if}
    </div>
  </header>

  <TabRow
    label="Throughput"
    tabs={[
      { id: 'blocks', label: 'Blocks' },
      { id: 'mempool', label: simple ? 'Waiting to be mined' : 'Mempool' },
    ]}
    current={tab}
    select={(id) => (tab = id as Tab)}
  />

  {#if th.error}<p class="th-note th-warn" role="alert"><Icon name="alert" size={15} /> <SafeText text={th.error} /></p>{/if}

  {#if tab === 'blocks'}
    <section class="th-tiles" aria-label="Throughput of the latest blocks">
      <div class="panel th-tile">
        <span class="th-k">Per second</span>
        <span class="th-v">{formatRate(tp.tps)}<small>tx/s</small></span>
        <span class="th-n">{t('over %1', niceTimeOffset(tp.span))}</span>
      </div>
      <div class="panel th-tile">
        <span class="th-k">Per block</span>
        <span class="th-v">{tp.avgTxs < 10 ? tp.avgTxs.toFixed(1) : formatCount(Math.round(tp.avgTxs))}<small>tx</small></span>
        <span class="th-n">{t('at most %1', formatCount(tp.maxTxs))}</span>
      </div>
      <div class="panel th-tile">
        <span class="th-k">Block fill</span>
        <span class="th-v">{formatShare(tp.avgFill)}</span>
        <span class="th-n">{t('at most %1 of 32 M', formatShare(tp.maxFill))}</span>
      </div>
      {#if !simple}<div class="panel th-tile">
        <span class="th-k">Fees</span>
        <span class="th-v">{fees(tp.fees)}</span>
        <span class="th-n">{t('%1 a transaction, median %2', fees(tp.feePerTx), rateText(tp.feeRate))}</span>
      </div>{/if}
      <div class="panel th-tile">
        <span class="th-k">Between blocks</span>
        <span class="th-v">{tp.interval ? shortDuration(tp.interval) : '–'}</span>
        <span class="th-n">{t('target %1', shortDuration(spacing))}</span>
      </div>
    </section>

    <section class="panel" aria-labelledby="tp-chart">
      <div class="panel-head">
        <h2 id="tp-chart">Each block</h2>
        <div class="th-legend"><span>Transactions</span><span class="line">Fill</span><span class="hot">Over half full</span></div>
      </div>
      <div class="panel-body">
        {#if blocks.length}
          <Bars
            series={[{ values: blocks.map((b) => b.txs), cls: 'bar' }]}
            line={blocks.map((b) => b.weight)}
            hot={blocks.map((b) => b.weight > MAX_BLOCK_WEIGHT / 2)}
            labels={blocks.map((b) => String(b.height))}
            titles={blocks.map((b) => `${b.height}: ${formatCount(b.txs)} tx, ${formatShare(b.weight / MAX_BLOCK_WEIGHT)}, ${fees(b.fees)}`)}
            label="Transactions and fill of each block"
            height={170}
          />
        {:else}
          <p class="th-empty">{th.loading ? 'Reading the blocks…' : 'No block yet.'}</p>
        {/if}
      </div>
    </section>

    <section class="panel capacity" aria-labelledby="tp-capacity">
      <div class="panel-head"><h2 id="tp-capacity">Capacity</h2></div>
      <div class="panel-body cap-body">
        <p class="flat">{t('A block of Thunder holds about %1 typical payments (one input, two outputs: 141 vbytes): %2 a second at a block every %3.', formatCount(capacity.perBlock), formatRate(capacity.perSecond), shortDuration(spacing))}</p>
        <Meter value={Math.min(used, 1)} max={1} label="Share of the capacity used" text={t('%1 used', formatShare(used))} tone={used > 0.5 ? 'warning' : 'accent'} />
        {#if last}<p class="th-note">{t('The last block, %1, carries %2 transactions in %3 of its weight.', last.height, formatCount(last.txs), formatShare(last.weight / MAX_BLOCK_WEIGHT))}</p>{/if}
      </div>
    </section>

    <section class="panel" aria-labelledby="tp-blocks">
      <div class="panel-head"><h2 id="tp-blocks">Blocks</h2><span class="faint small">Double-click a block to open it in the block explorer</span></div>
      <div class="th-table pad">
        <DataTable rows={blocks} {columns} key={(b) => String(b.height)} bind:selected bind:sortKey bind:sortDir label="The latest blocks" empty="No block yet" fit onactivate={(b) => go('explorer', `search:${b.hash}`)}>
          {#snippet cell(b, c)}
            {#if c.key === 'height'}<span class="num">{b.height}</span>
            {:else if c.key === 'time'}<span class="num">{formatTime(b.time)}</span>
            {:else if c.key === 'txs'}<span class="num">{formatCount(b.txs)}</span>
            {:else if c.key === 'outs'}<span class="num">{formatCount(b.outs)}</span>
            {:else if c.key === 'fill'}<Meter value={b.weight} max={MAX_BLOCK_WEIGHT} label="Fill of block {b.height}" text={formatShare(b.weight / MAX_BLOCK_WEIGHT)} tone={b.weight > MAX_BLOCK_WEIGHT / 2 ? 'warning' : 'accent'} />
            {:else if c.key === 'fees'}<span class="num">{fees(b.fees)}</span>
            {:else if c.key === 'rate'}<span class="num">{b.txs ? rateText(b.feeRate) : '–'}</span>
            {:else}<span class="mono" translate="no">{shortHash(b.hash, 8)}</span>{/if}
          {/snippet}
        </DataTable>
      </div>
    </section>
  {:else}
    <section class="th-tiles" aria-label="The mempool">
      <div class="panel th-tile">
        <span class="th-k">Waiting</span>
        <span class="th-v">{mempool ? formatCount(mempool.size) : '–'}<small>tx</small></span>
        <span class="th-n">{mempool ? formatBytes(mempool.bytes) : ''}</span>
      </div>
      <div class="panel th-tile">
        <span class="th-k">Blocks to clear</span>
        <span class="th-v">{mempool ? (mempool.size ? blocksToClear(mempool.bytes) : 0) : '–'}</span>
        <span class="th-n">{mempool ? t('%1 of a block', formatShare((mempool.bytes * 4) / MAX_BLOCK_WEIGHT)) : ''}</span>
      </div>
      <div class="panel th-tile">
        <span class="th-k">Fees waiting</span>
        <span class="th-v">{mempool ? fees(mempool.total_fee * 1e8) : '–'}</span>
        <span class="th-n">{mempool && mempool.size ? t('%1 a transaction', fees((mempool.total_fee * 1e8) / mempool.size)) : ''}</span>
      </div>
      {#if !simple}<div class="panel th-tile">
        <span class="th-k">Memory</span>
        <span class="th-v">{mempool ? formatBytes(mempool.usage) : '–'}</span>
        <span class="th-n">{node.mempool.max ? t('of %1', formatBytes(node.mempool.max)) : ''}</span>
      </div>{/if}
    </section>

    <div class="cols">
      <section class="panel" aria-labelledby="tp-estimates">
        <div class="panel-head"><h2 id="tp-estimates">Fee estimates</h2></div>
        <div class="panel-body">
          <dl class="th-pairs">
            {#each ESTIMATE_TARGETS as target (target)}
              <dt>{tn('Within %n block(s)', target)} <span class="faint">({niceTimeOffset(target * spacing)})</span></dt>
              <dd>{rateText(th.estimates[target])}</dd>
            {/each}
            {#if !simple}<dt>Least relayed</dt><dd>{mempool?.mempoolminfee !== undefined ? rateText((mempool.mempoolminfee * 1e8) / 1000) : '–'}</dd>{/if}
          </dl>
          <p class="th-note">The node estimates from the blocks it saw; – until it has seen enough. With room in every block, the least <Term id="fee">fee</Term> is usually enough.</p>
        </div>
      </section>
      <section class="panel" aria-labelledby="tp-chain">
        <div class="panel-head"><h2 id="tp-chain">The whole chain</h2></div>
        <div class="panel-body">
          <dl class="th-pairs">
            <dt>Transactions</dt><dd>{th.chain ? formatCount(th.chain.txcount) : '–'}</dd>
            <dt>Blocks</dt><dd>{node.tip ? formatCount(node.tip.height) : '–'}</dd>
            <dt>{th.chain ? tn('Over the last %n block(s)', th.chain.window_block_count) : 'Over the last blocks'}</dt><dd>{th.chain?.window_tx_count !== undefined ? formatCount(th.chain.window_tx_count) : '–'}</dd>
            <dt>Rate over them</dt><dd>{th.chain?.txrate !== undefined ? `${formatRate(th.chain.txrate)} tx/s` : '–'}</dd>
          </dl>
        </div>
      </section>
    </div>
  {/if}
</div>

<style>
  .pad {
    padding: 0 1rem 1rem;
  }
  .cap-body {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }
  .flat {
    margin: 0;
  }
  .cols {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(22rem, 100%), 1fr));
    gap: 1rem;
    align-items: start;
  }
  .cols .th-note {
    margin-top: 0.7rem;
  }
  .small {
    font-size: 0.84rem;
  }
</style>
