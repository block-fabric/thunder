<script lang="ts">
  // The cards of Thunder on the home of the dashboard: the throughput of the chain (transactions a second
  // over the last blocks, the last block and how full it is, what waits in the mempool, the transactions of
  // each block as a line), and the payments of the wallet today (in, out, the last batch). Each opens its page.
  import Amount from '../components/Amount.svelte';
  import Icon from '../components/Icon.svelte';
  import Meter from '../components/Meter.svelte';
  import Sparkline from '../components/Sparkline.svelte';
  import Card from '../views/home/Card.svelte';
  import { formatCount, niceTimeOffset } from '../lib/format';
  import { t, tn } from '../lib/i18n.svelte';
  import { go } from '../lib/nav.svelte';
  import { node, wallets, walletsEnabled } from '../lib/state.svelte';
  import { current, refreshRecords } from '../lib/walletdata.svelte';
  import './th/th.css';
  import { dayOf, formatRate, formatShare, MAX_BLOCK_WEIGHT, paymentsOf, throughputOf } from './th/model';
  import { refreshBlocks, th, watchMempool } from './th/store.svelte';

  /** The blocks the card counts. */
  const WINDOW = 30;

  $effect(() => {
    void node.tip?.hash;
    void refreshBlocks(WINDOW);
  });
  $effect(() => watchMempool(15));
  $effect(() => {
    void wallets.txVersion;
    void node.tip?.hash;
    if (wallets.current !== null) void refreshRecords();
  });

  const blocks = $derived(th.blocks.slice(-WINDOW));
  const tp = $derived(throughputOf(blocks));
  const last = $derived(blocks.length ? blocks[blocks.length - 1] : null);
  const hasWallet = $derived(walletsEnabled() && wallets.current !== null);
  const payments = $derived(hasWallet ? paymentsOf(current.records) : []);
  const today = $derived.by(() => {
    void node.tip?.height;
    const start = dayOf(Math.floor(Date.now() / 1000));
    let received = 0n;
    let sent = 0n;
    let count = 0;
    for (const p of payments) {
      if (p.time < start && p.status !== 'unconfirmed') break;
      count++;
      if (p.amount >= 0n) received += p.amount;
      else sent += p.amount;
    }
    return { received, sent, count };
  });
  const lastBatch = $derived(payments.find((p) => p.kind === 'batch') ?? null);
</script>

<div class="th-cards">
  <Card title="Throughput" icon="gauge" open={() => go('throughput')} openLabel="Open the throughput" stat>
    <span class="value num">{formatRate(tp.tps)} <small>tx/s</small></span>
    <dl class="pairs">
      <dt>Last block</dt><dd class="num">{last ? tn('%n tx', last.txs) : '–'}</dd>
      <dt>Its fill</dt><dd>{#if last}<Meter value={last.weight} max={MAX_BLOCK_WEIGHT} label="Fill of the last block" text={formatShare(last.weight / MAX_BLOCK_WEIGHT)} />{:else}–{/if}</dd>
      <dt>Waiting</dt><dd class="num">{th.mempool ? tn('%n tx', th.mempool.size) : '–'}</dd>
    </dl>
    {#if blocks.length > 1}<div class="spark"><Sparkline values={blocks.map((b) => b.txs)} width={220} height={30} /></div>{/if}
    {#snippet actions()}
      <button type="button" class="btn grow" onclick={() => go('throughput')}><Icon name="gauge" size={15} /> Blocks</button>
      <button type="button" class="btn ghost" onclick={() => go('throughput', 'mempool')}>Mempool</button>
    {/snippet}
  </Card>

  <Card title="Payments today" icon="ledger" open={() => go('payments')} openLabel="Open the payments" stat>
    {#if hasWallet}
      <span class="value num">{today.count}</span>
      <dl class="pairs">
        <dt>Received</dt><dd><Amount sats={today.received} /></dd>
        <dt>Sent</dt><dd><Amount sats={-today.sent} /></dd>
        <dt>Last batch</dt><dd>{#if lastBatch}{tn('%n recipient(s)', lastBatch.count)}, {t('%1 ago', niceTimeOffset(Date.now() / 1000 - lastBatch.time))}{:else}–{/if}</dd>
      </dl>
    {:else}
      <p class="muted">Open a wallet to see its payments.</p>
    {/if}
    {#snippet actions()}
      <button type="button" class="btn grow primary" onclick={() => go('batchpay')}><Icon name="batch" size={15} /> Batch pay</button>
      <button type="button" class="btn ghost" onclick={() => go('payments')}>History</button>
    {/snippet}
  </Card>
</div>

<style>
  .th-cards {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
    gap: 1rem;
  }
  .value {
    display: block;
    margin: 0.1rem 0 0.55rem;
    font-size: 1.6rem;
    font-weight: 650;
  }
  .value small {
    font-size: 0.85rem;
    font-weight: 500;
    color: var(--text-muted);
  }
  .pairs {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0.3rem 0.8rem;
    margin: 0;
    font-size: 0.9rem;
  }
  .pairs dt {
    color: var(--text-muted);
  }
  .pairs dd {
    margin: 0;
    display: flex;
    justify-content: flex-end;
    text-align: end;
  }
  .spark {
    margin-top: 0.5rem;
    opacity: 0.9;
  }
</style>
