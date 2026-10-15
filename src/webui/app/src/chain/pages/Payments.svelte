<script lang="ts">
  // Payments: the history of the wallet made for many of them. A transaction is one row, whatever it
  // paid: a batch of a thousand recipients is a row "Batch · 1 000", opened to see its recipients (and
  // paid again from Batch pay). Totals of what the filters show, what came in and went out each day, the
  // days as a table, and the export to CSV (a line a payment, or a line a recipient). The rows are drawn
  // as they come into view (DataTable): a history of a hundred thousand transactions scrolls as one of ten.
  import Amount from '../../components/Amount.svelte';
  import DataTable from '../../components/DataTable.svelte';
  import Icon from '../../components/Icon.svelte';
  import NoWallet from '../../components/NoWallet.svelte';
  import SafeText from '../../components/SafeText.svelte';
  import TabRow from '../../components/TabRow.svelte';
  import TxDetailsDialog from '../../components/TxDetailsDialog.svelte';
  import { errorText } from '../../lib/dialogs.svelte';
  import { FILTERS, saveTextAs } from '../../lib/files';
  import { formatTime } from '../../lib/format';
  import { t, tn } from '../../lib/i18n.svelte';
  import { go, nav, PAGES } from '../../lib/nav.svelte';
  import { node, prefs, toast, wallets, walletsEnabled } from '../../lib/state.svelte';
  import type { Column } from '../../lib/table';
  import { formatAmount } from '../../lib/units';
  import { statusText, walletApi, type TxRecord } from '../../lib/wallet';
  import { current, refreshRecords } from '../../lib/walletdata.svelte';
  import '../th/th.css';
  import Bars from '../th/Bars.svelte';
  import { dailyTotals, dayOf, newRecipient, paymentsCsv, paymentsOf, type Payment } from '../th/model';
  import { draft } from '../th/store.svelte';

  type Tab = 'all' | 'batches' | 'days';
  type Period = '7' | '30' | '90' | 'all';
  type Way = 'all' | 'in' | 'out';

  const wallet = $derived(wallets.current);
  const noWallet = $derived(!walletsEnabled() || wallet === null);

  let tab = $state<Tab>('all');
  let period = $state<Period>('30');
  let way = $state<Way>('all');
  let search = $state('');
  let selected: string | null = $state(null);
  let recipientSel: string | null = $state(null);
  let details: Pick<TxRecord, 'txid' | 'idx' | 'address'> | null = $state(null);
  let sortKey: string | null = $state('time');
  let sortDir: 'asc' | 'desc' = $state('desc');
  let perRecipient = $state(false);

  $effect(() => {
    const asked = nav.tab;
    if (nav.page !== 'payments' || !asked) return;
    if (asked === 'batches' || asked === 'days' || asked === 'all') tab = asked;
    nav.tab = '';
  });

  // The history, loaded once and kept up to date in parts (lib/walletdata.svelte.ts).
  $effect(() => {
    void wallets.txVersion;
    void node.tip?.hash;
    if (wallet !== null) void refreshRecords();
  });

  const payments = $derived(paymentsOf(current.records));
  // Now, again with each block (the days of the chart move on).
  const now = $derived.by(() => {
    void node.tip?.height;
    return Math.floor(Date.now() / 1000);
  });
  const since = $derived(period === 'all' ? 0 : dayOf(now) - (Number(period) - 1) * 86400);
  const inPeriod = $derived(payments.filter((p) => p.time >= since || p.status === 'unconfirmed'));
  const shown = $derived(
    inPeriod.filter((p) => {
      if (tab === 'batches' && p.kind !== 'batch') return false;
      if (way === 'in' && p.amount < 0n) return false;
      if (way === 'out' && p.amount >= 0n) return false;
      return true;
    }),
  );
  const totals = $derived.by(() => {
    let received = 0n;
    let sent = 0n;
    let countIn = 0;
    let countOut = 0;
    let batches = 0;
    let recipients = 0;
    for (const p of shown) {
      if (p.amount >= 0n) {
        received += p.amount;
        countIn++;
      } else {
        sent += p.amount;
        countOut++;
      }
      if (p.kind === 'batch') {
        batches++;
        recipients += p.count;
      }
    }
    return { received, sent, countIn, countOut, batches, recipients };
  });
  const days = $derived(dailyTotals(inPeriod, period === 'all' ? 90 : Number(period), now));
  const chosen = $derived(selected === null ? null : (shown.find((p) => p.key === selected) ?? null));
  const recipients = $derived(chosen && chosen.kind === 'batch' ? chosen.records.filter((r) => r.type === 'send' || r.type === 'sendOther') : []);

  // After a batch was sent: its row chosen.
  $effect(() => {
    const txid = nav.highlightTx;
    if (!txid || !current.recordsLoaded) return;
    if (payments.some((p) => p.txid === txid)) {
      selected = txid;
      nav.highlightTx = null;
    }
  });

  const KIND_WORDS = { in: 'Received', out: 'Sent', batch: 'Batch', mined: 'Mined', other: 'Other' } as const;
  const columns: Column<Payment>[] = [
    { key: 'time', label: 'Date', value: (p) => p.time, width: '8.8rem', noFilter: true },
    { key: 'kind', label: 'Kind', value: (p) => t(KIND_WORDS[p.kind]), width: '7rem', words: true },
    { key: 'who', label: 'To or from', value: (p) => `${p.label} ${p.address}`, width: 'minmax(6rem, 2fr)' },
    { key: 'count', label: 'Recipients', value: (p) => p.count, width: '5.8rem', align: 'end', noFilter: true },
    { key: 'amount', label: 'Amount', value: (p) => p.amount, width: 'minmax(8rem, 1fr)', align: 'end', noFilter: true },
    { key: 'status', label: 'Status', value: (p) => statusText(p), width: 'minmax(6rem, 1fr)', words: true, noFilter: true },
  ];
  // The id is searched too, without a column of its own.
  const searchable = $derived(search.trim() ? shown.filter((p) => p.txid.startsWith(search.trim().toLowerCase())) : []);
  const rows = $derived(searchable.length ? searchable : shown);
  const filter = $derived(searchable.length ? '' : search);

  const recipientColumns: Column<TxRecord>[] = [
    { key: 'idx', label: 'Output', value: (r) => r.idx, width: '4.5rem', align: 'end', noFilter: true },
    { key: 'address', label: 'Address', value: (r) => r.address, width: 'minmax(8rem, 2fr)', mono: true },
    { key: 'label', label: 'Label', value: (r) => r.label, width: 'minmax(4rem, 1fr)' },
    { key: 'amount', label: 'Amount', value: (r) => r.amount, width: 'minmax(8rem, 1fr)', align: 'end', noFilter: true },
  ];

  const dayColumns: Column<(typeof days)[number]>[] = [
    { key: 'day', label: 'Day', value: (d) => d.day, width: '9rem', noFilter: true },
    { key: 'countIn', label: 'Received', value: (d) => d.countIn, width: '6.5rem', align: 'end' },
    { key: 'in', label: 'In', value: (d) => d.in, width: 'minmax(9rem, 1fr)', align: 'end' },
    { key: 'countOut', label: 'Paid', value: (d) => d.countOut, width: '6.5rem', align: 'end' },
    { key: 'out', label: 'Out', value: (d) => d.out, width: 'minmax(9rem, 1fr)', align: 'end' },
    { key: 'net', label: 'Net', value: (d) => d.in - d.out, width: 'minmax(9rem, 1fr)', align: 'end' },
  ];
  let daySort: string | null = $state('day');
  let dayDir: 'asc' | 'desc' = $state('desc');

  function dayLabel(secs: number): string {
    const d = new Date(secs * 1000);
    return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  /** The recipients of a payment made before, into Batch pay: each paid what its output paid. */
  async function payAgain(p: Payment) {
    if (wallet === null) return;
    const outputs = p.records.filter((r) => r.type === 'send' || r.type === 'sendOther');
    // The wallet counts the fee in the first output it paid (TransactionRecord): the details give the fee.
    let fee = 0n;
    try {
      const d = await walletApi(wallet).transaction(p.txid, outputs[0].idx, outputs[0].address);
      const row = d.rows.find((x) => x.k === 'Transaction fee');
      if (row?.sats) fee = BigInt(-row.sats);
    } catch {
      // Without the details, the first amount keeps the fee in it; the user checks the list.
    }
    draft.list = outputs.map((r, i) => newRecipient({ address: r.address, amount: -r.amount - (i === 0 ? fee : 0n), label: r.label }));
    draft.skipped = [];
    draft.source = 'A payment made before';
    draft.sourceFile = '';
    go('batchpay');
    toast('info', t('Batch pay'), tn('%n recipient(s) copied: check them, then pay.', draft.list.length));
  }

  async function exportCsv() {
    const text = paymentsCsv(rows, prefs.unit, perRecipient);
    const path = await saveTextAs({ title: t('Export the payments'), name: 'thunder-payments.csv', filters: [FILTERS.csv] }, text).catch((e) => {
      toast('error', t('Export the payments'), errorText(e));
      return null;
    });
    if (path) toast('success', t('Exporting Successful'), t('The transaction history was successfully saved to %1.', path));
  }
</script>

{#if noWallet}
  <NoWallet page={PAGES.payments} />
{:else}
  <div class="page th-page payments">
    <header class="th-head">
      <div>
        <h1>Payments</h1>
        <p class="th-sub">Every transaction once: a batch is one row, whatever it paid.</p>
      </div>
      <div class="th-tools">
        <label class="check small" title="In the file, a line for each recipient of a batch">
          <input type="checkbox" bind:checked={perRecipient} />
          <span>A line per recipient</span>
        </label>
        <button type="button" class="btn small" disabled={!rows.length} onclick={exportCsv}><Icon name="download" size={15} /> Export CSV…</button>
        <button type="button" class="btn primary small" onclick={() => go('batchpay')}><Icon name="batch" size={15} /> Batch pay</button>
      </div>
    </header>

    <TabRow
      label="Payments"
      tabs={[
        { id: 'all', label: 'All payments' },
        { id: 'batches', label: 'Batches' },
        { id: 'days', label: 'By day' },
      ]}
      current={tab}
      select={(id) => {
        tab = id as Tab;
        selected = null;
      }}
    />

    <section class="th-tiles" aria-label="Totals of the payments shown">
      <div class="panel th-tile"><span class="th-k">Received</span><span class="th-v th-up"><Amount sats={totals.received} /></span><span class="th-n">{tn('%n payment(s)', totals.countIn)}</span></div>
      <div class="panel th-tile"><span class="th-k">Sent</span><span class="th-v th-down"><Amount sats={-totals.sent} /></span><span class="th-n">{tn('%n payment(s)', totals.countOut)}</span></div>
      <div class="panel th-tile"><span class="th-k">Net</span><span class="th-v"><Amount sats={totals.received + totals.sent} plus /></span><span class="th-n">{period === 'all' ? t('since the wallet began') : tn('the last %n day(s)', Number(period))}</span></div>
      <div class="panel th-tile"><span class="th-k">Batches</span><span class="th-v num">{totals.batches}</span><span class="th-n">{tn('%n recipient(s) paid in them', totals.recipients)}</span></div>
    </section>

    <section class="panel activity" aria-labelledby="pm-activity">
      <div class="panel-head">
        <h2 id="pm-activity">Each day</h2>
        <div class="th-legend"><span>In</span><span class="out">Out</span></div>
        <span class="grow"></span>
        <div class="th-chips" role="group" aria-label="Period">
          <button type="button" aria-pressed={period === '7'} onclick={() => (period = '7')}>7 days</button>
          <button type="button" aria-pressed={period === '30'} onclick={() => (period = '30')}>30 days</button>
          <button type="button" aria-pressed={period === '90'} onclick={() => (period = '90')}>90 days</button>
          <button type="button" aria-pressed={period === 'all'} onclick={() => (period = 'all')}>All</button>
        </div>
      </div>
      <div class="panel-body">
        <Bars
          series={[
            { values: days.map((d) => Number(d.in)), cls: 'bar' },
            { values: days.map((d) => Number(d.out)), cls: 'bar out' },
          ]}
          labels={days.map((d) => dayLabel(d.day))}
          titles={days.map((d) => `${dayLabel(d.day)}: +${formatAmount(d.in, prefs.unit, { withUnit: true })} (${d.countIn}) / -${formatAmount(d.out, prefs.unit, { withUnit: true })} (${d.countOut})`)}
          label="What came in and went out each day"
          height={120}
        />
      </div>
    </section>

    {#if tab === 'days'}
      <section class="panel">
        <div class="th-table short pad">
          <DataTable rows={days.filter((d) => d.countIn || d.countOut)} columns={dayColumns} key={(d) => String(d.day)} bind:sortKey={daySort} bind:sortDir={dayDir} label="Payments by day" empty="No payment in this period" fit>
            {#snippet cell(d, c)}
              {#if c.key === 'day'}<span class="num">{formatTime(d.day).slice(0, 10)}</span>
              {:else if c.key === 'in'}<Amount sats={d.in} />
              {:else if c.key === 'out'}<Amount sats={-d.out} />
              {:else if c.key === 'net'}<Amount sats={d.in - d.out} plus colored />
              {:else if c.key === 'countIn'}<span class="num">{d.countIn}</span>
              {:else}<span class="num">{d.countOut}</span>{/if}
            {/snippet}
          </DataTable>
        </div>
      </section>
    {:else}
      <section class="panel list" aria-labelledby="pm-list">
        <div class="panel-head list-head">
          <h2 id="pm-list">{tab === 'batches' ? 'Batches' : 'Payments'}</h2>
          <span class="faint small">{tn('%n shown', rows.length)}</span>
          <span class="grow"></span>
          <div class="th-chips" role="group" aria-label="Direction">
            <button type="button" aria-pressed={way === 'all'} onclick={() => (way = 'all')}>All</button>
            <button type="button" aria-pressed={way === 'in'} onclick={() => (way = 'in')}>In</button>
            <button type="button" aria-pressed={way === 'out'} onclick={() => (way = 'out')}>Out</button>
          </div>
          <input type="search" class="search" aria-label="Search the payments" placeholder="Label, address or ID" bind:value={search} />
        </div>
        {#if !current.recordsLoaded}
          <p class="th-empty">{current.recordsError ? '' : 'Loading the history…'}{#if current.recordsError}<SafeText text={current.recordsError} />{/if}</p>
        {:else}
          <div class="th-table pad">
            <DataTable {rows} {columns} key={(p) => p.key} {filter} bind:selected bind:sortKey bind:sortDir label="Payments of the wallet" fit empty={tab === 'batches' ? 'No batch payment yet' : 'No payment in this period'} onactivate={(p) => (p.kind === 'batch' ? (selected = p.key) : (details = p.records[0]))}>
              {#snippet cell(p, c)}
                {#if c.key === 'time'}<span class="num">{formatTime(p.time)}</span>
                {:else if c.key === 'kind'}<span class="th-tag {p.kind}">{t(KIND_WORDS[p.kind])}{#if p.kind === 'batch'}&nbsp;×{p.count}{/if}</span>
                {:else if c.key === 'who'}{#if p.kind === 'batch'}<span class="muted">{tn('%n recipient(s)', p.count)}</span>{:else if p.label}<SafeText text={p.label} />{:else}<SafeText class="mono" text={p.address} />{/if}
                {:else if c.key === 'count'}<span class="num">{p.count}</span>
                {:else if c.key === 'amount'}<Amount sats={p.amount} plus colored />
                {:else}<span class="status" class:ok={p.status === 'confirmed'} class:wait={p.status === 'unconfirmed' || p.status === 'confirming'}>{statusText(p)}</span>{/if}
              {/snippet}
            </DataTable>
          </div>
        {/if}
      </section>

      {#if chosen}
        <section class="panel chosen" aria-labelledby="pm-chosen">
          <div class="panel-head list-head">
            <h2 id="pm-chosen">{chosen.kind === 'batch' ? tn('Batch of %n recipient(s)', chosen.count) : t(KIND_WORDS[chosen.kind])}</h2>
            <span class="mono faint small break" translate="no">{chosen.txid}</span>
            <span class="grow"></span>
            {#if chosen.kind === 'batch' || chosen.kind === 'out'}<button type="button" class="btn small" onclick={() => void payAgain(chosen!)}><Icon name="batch" size={15} /> Pay again…</button>{/if}
            <button type="button" class="btn ghost small" onclick={() => (details = chosen!.records[0])}>Details…</button>
            <button type="button" class="btn ghost small" onclick={() => go('explorer', `search:${chosen!.txid}`)}>Show in block explorer</button>
          </div>
          {#if chosen.kind === 'batch'}
            <div class="th-table short pad">
              <DataTable rows={recipients} columns={recipientColumns} key={(r) => r.key} bind:selected={recipientSel} label="Recipients of the batch" fit onactivate={(r) => (details = r)}>
                {#snippet cell(r, c)}
                  {#if c.key === 'idx'}<span class="num faint">{r.idx}</span>
                  {:else if c.key === 'address'}<SafeText text={r.address} />
                  {:else if c.key === 'label'}<SafeText text={r.label} />
                  {:else}<Amount sats={r.amount} colored />{/if}
                {/snippet}
              </DataTable>
            </div>
            <p class="th-note pad-note">The first recipient's amount includes the fee of the transaction, as the wallet records it.</p>
          {/if}
        </section>
      {/if}
    {/if}
  </div>
  {#if wallet !== null}<TxDetailsDialog {wallet} bind:record={details} />{/if}
{/if}

<style>
  .list-head {
    flex-wrap: wrap;
    gap: 0.5rem 0.8rem;
  }
  .search {
    width: min(15rem, 100%);
  }
  .pad {
    padding: 0 1rem 1rem;
  }
  .pad-note {
    padding: 0 1rem 1rem;
  }
  .small {
    font-size: 0.84rem;
  }
</style>
