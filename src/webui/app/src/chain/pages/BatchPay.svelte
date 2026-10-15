<script lang="ts">
  // Batch pay: many recipients paid at once, the way a chain of large blocks is meant to be used. The list
  // is typed a row at a time, pasted (one recipient a line: address, amount, label, separated by commas,
  // semicolons, tabs or spaces) or read from a CSV file chosen in the file chooser of the desktop; every
  // row is checked (an address of this chain and network, an amount above dust, each address once), the
  // list totalled, its size and fee estimated, and the transactions previewed and confirmed before they
  // are sent. Up to PART_SIZE recipients go in one transaction; a longer list is paid in several, one
  // after the other, each made, signed and sent by the wallet of the host (wallet.send.*). The list stays
  // while the user goes to other pages (store.svelte.ts: draft).
  import { untrack } from 'svelte';
  import Amount from '../../components/Amount.svelte';
  import AmountInput from '../../components/AmountInput.svelte';
  import CoinPanel from '../../components/CoinPanel.svelte';
  import DataTable from '../../components/DataTable.svelte';
  import Dialog from '../../components/Dialog.svelte';
  import Icon from '../../components/Icon.svelte';
  import Meter from '../../components/Meter.svelte';
  import SafeText from '../../components/SafeText.svelte';
  import { CHAIN } from '../config';
  import { checkAddress, networkParams } from '../../lib/address';
  import { ask, errorText, inform, withUnlock, type Choice } from '../../lib/dialogs.svelte';
  import { base64ToBytes, chooseFile, FILTERS, readFile, saveBase64As, saveTextAs, safeFileName } from '../../lib/files';
  import { formatCount, niceTimeOffset } from '../../lib/format';
  import { t, tn } from '../../lib/i18n.svelte';
  import { go, nav } from '../../lib/nav.svelte';
  import { host } from '../../lib/rpc';
  import { app, node, prefs, savePrefs, toast, wallets } from '../../lib/state.svelte';
  import type { Column } from '../../lib/table';
  import { formatAmount, unitInfo, UNITS, type Unit } from '../../lib/units';
  import { CONF_TARGETS, nearestConfTarget, psbtFileName, walletApi, type Outpoint, type Prepared } from '../../lib/wallet';
  import { current, refreshInfo } from '../../lib/walletdata.svelte';
  import '../th/th.css';
  import { checkRecipients, MAX_BLOCK_WEIGHT, MAX_CSV_BYTES, MAX_RECIPIENTS, mergeDuplicates, newRecipient, PART_SIZE, parseRecipients, partsOf, recipientsCsv, totalsOf, formatShare, type Recipient } from '../th/model';
  import { draft } from '../th/store.svelte';

  /** Seconds before the send button of the confirmation can be pressed (SEND_CONFIRM_DELAY). */
  const SEND_CONFIRM_DELAY = 3;
  /** The recipients the confirmation lists by name; the rest are counted. */
  const LISTED = 300;

  const wallet = $derived(wallets.current);
  const api = $derived(wallet === null ? null : walletApi(wallet));
  const info = $derived(current.info);
  const network = $derived(app.info?.network ?? 'main');
  const hrp = $derived(networkParams(network).hrp);
  const unit = $derived<Unit>(draft.unit || prefs.unit);
  const balance = $derived(wallet !== null ? wallets.balances[wallet]?.trusted : undefined);
  const totals = $derived(totalsOf(draft.list, network));
  const duplicates = $derived(draft.list.some((r) => r.problem === 'This address is in the list more than once'));
  const ready = $derived(draft.list.filter((r) => !r.problem && r.amount !== null));
  const spacing = $derived(app.info?.blockSpacing ?? 600);
  const confTarget = $derived(nearestConfTarget(prefs.confTarget || info?.confirmTarget || 6));

  let show = $state<'all' | 'problems'>('all');
  let search = $state('');
  let selected: string | null = $state(null);
  let checking = $state(false);
  let busy = $state(false);
  let progress = $state<{ part: number; parts: number; paid: number } | null>(null);
  let done = $state<{ txids: string[]; count: number; amount: bigint; psbt: boolean } | null>(null);
  let smart = $state<{ feePerK: number; fallback: boolean; target?: number; requiredFeePerK: number } | null>(null);
  let customFee: bigint | null = $state(BigInt(prefs.customFee || 0));
  let selectedCoins: Outpoint[] = $state([]);

  // Typing a recipient.
  let addAddress = $state('');
  let addAmount: bigint | null = $state(null);
  let addUnit = $state<Unit>(prefs.unit);
  let addLabel = $state('');
  let addError = $state('');

  // Pasting a list.
  let pasteOpen = $state(false);
  let pasteText = $state('');
  let pasteMode = $state<'replace' | 'append'>('append');

  // Editing the selected row.
  const chosen = $derived(selected === null ? null : (draft.list.find((r) => String(r.id) === selected) ?? null));
  let editAddress = $state('');
  let editAmount: bigint | null = $state(null);
  let editUnit = $state<Unit>(prefs.unit);
  let editLabel = $state('');
  $effect(() => {
    const r = chosen;
    untrack(() => {
      editAddress = r?.address ?? '';
      editAmount = r?.amount ?? null;
      editLabel = r?.label ?? '';
      editUnit = unit;
    });
  });

  const feeChoice = $derived(prefs.feeMode === 'custom' && customFee !== null ? { confTarget, feeRate: Number(customFee) } : { confTarget });
  const feeRate = $derived(prefs.feeMode === 'custom' && customFee !== null ? Number(customFee) : (smart?.feePerK ?? 0));
  /** About the fee of the whole list, at the rate chosen, before the wallet chooses the coins. */
  const feeEstimate = $derived(BigInt(Math.ceil((totals.vsize * feeRate) / 1000)));
  const afterBalance = $derived(balance === undefined ? undefined : balance - totals.amount - (draft.subtractFee ? 0n : feeEstimate));
  const canSign = $derived(!!info && (!info.privateKeysDisabled || info.externalSigner));
  const coinChoice = $derived(prefs.coinControl && totals.parts <= 1);

  $effect(() => {
    if (wallet !== null) refreshInfo();
  });
  // The smart fee of the target, again after each block.
  $effect(() => {
    const target = confTarget;
    void node.tip?.height;
    if (!api) return;
    api
      .smartFee(target)
      .then((s) => (smart = s))
      .catch(() => (smart = null));
  });
  $effect(() => {
    if (customFee === null && prefs.customFee === 0 && smart) customFee = BigInt(smart.requiredFeePerK);
  });
  $effect(() => {
    if (customFee !== null && Number(customFee) !== prefs.customFee) savePrefs({ customFee: Number(customFee) });
  });

  // From the menus and the palette: Import… and Paste….
  $effect(() => {
    const tab = nav.tab;
    if (nav.page !== 'batchpay' || !tab) return;
    nav.tab = '';
    untrack(() => {
      if (tab === 'import') void importFile();
      else if (tab === 'paste') openPaste();
    });
  });

  let checkSeq = 0;
  let checkRun: Promise<void> = Promise.resolve();
  /** Put a list in place, then check it (the check of a long list takes a moment: the newest list wins). */
  function setList(list: Recipient[]): Promise<void> {
    draft.list = list;
    const mine = ++checkSeq;
    checking = true;
    checkRun = (async () => {
      try {
        const checked = await checkRecipients(list, network);
        if (mine === checkSeq) draft.list = checked;
      } finally {
        if (mine === checkSeq) checking = false;
      }
    })();
    return checkRun;
  }

  // A list kept from before (another page, another network) is checked again when the page opens.
  $effect(() => {
    void network;
    untrack(() => {
      if (draft.list.length) void setList(draft.list);
    });
  });

  async function addOne(e: Event) {
    e.preventDefault();
    addError = '';
    const c = await checkAddress(addAddress, network);
    if (!c.valid) {
      addError = t(c.error);
      document.getElementById('bp-add-address')?.focus();
      return;
    }
    if (addAmount === null || addAmount <= 0n) {
      addError = t('The amount to pay must be larger than 0.');
      document.getElementById('bp-add-amount')?.focus();
      return;
    }
    if (draft.list.length >= MAX_RECIPIENTS) {
      addError = t('A list takes at most %1 recipients.', MAX_RECIPIENTS);
      return;
    }
    await setList([...draft.list, newRecipient({ address: addAddress.trim(), amount: addAmount, amountText: formatAmount(addAmount, addUnit, { separators: false }), label: addLabel.trim().slice(0, 256) })]);
    if (!draft.source) draft.source = 'Typed';
    addAddress = '';
    addAmount = null;
    addLabel = '';
    document.getElementById('bp-add-address')?.focus();
  }

  function openPaste() {
    pasteText = '';
    pasteMode = draft.list.length ? 'append' : 'replace';
    pasteOpen = true;
  }

  const pastePreview = $derived(pasteText.trim() ? parseRecipients(pasteText, unit, unitInfo(unit).short) : null);

  async function readPaste(e: Event) {
    e.preventDefault();
    const parsed = parseRecipients(pasteText, unit, unitInfo(unit).short);
    pasteOpen = false;
    await takeParsed(parsed, pasteMode === 'replace', 'Pasted', '');
  }

  async function takeParsed(parsed: ReturnType<typeof parseRecipients>, replace: boolean, source: string, file: string) {
    const list = replace ? parsed.recipients : [...draft.list, ...parsed.recipients].slice(0, MAX_RECIPIENTS);
    draft.skipped = parsed.skipped;
    draft.source = source;
    draft.sourceFile = file;
    selected = null;
    await setList(list);
    const problems = draft.list.filter((r) => r.problem).length;
    toast(
      problems ? 'warning' : 'success',
      t('Recipients read'),
      [tn('%n recipient(s) read', parsed.recipients.length), parsed.skipped.length ? tn('%n line(s) left out', parsed.skipped.length) : '', problems ? tn('%n to look at', problems) : '', parsed.truncated ? t('The list was cut at %1 recipients.', MAX_RECIPIENTS) : '']
        .filter(Boolean)
        .join(' · '),
    );
    if (problems) show = 'problems';
  }

  async function importFile() {
    // The file chooser of the desktop: the page reads only the file the user chose there.
    const path = await chooseFile({ title: t('Import payments'), filters: [FILTERS.csv, { name: 'Text', patterns: ['*.txt', '*.tsv'] }, FILTERS.all] }).catch((e) => {
      toast('error', t('Import payments'), errorText(e));
      return null;
    });
    if (!path) return;
    let text: string;
    try {
      const file = await readFile(path);
      if (file.size > MAX_CSV_BYTES) {
        await inform(t('Import payments'), t('The file is too large: at most %1 MB.', MAX_CSV_BYTES / 1_000_000), 'error');
        return;
      }
      text = new TextDecoder('utf-8').decode(base64ToBytes(file.base64));
    } catch (e) {
      await inform(t('Import payments'), errorText(e), 'error');
      return;
    }
    let replace = true;
    if (draft.list.length) {
      const r = await ask({
        title: t('Import payments'),
        message: t('The list has %1 recipients. Add those of the file to them, or replace them?', draft.list.length),
        level: 'question',
        choices: [
          { id: 'cancel', label: 'Cancel' },
          { id: 'append', label: 'Add to the list' },
          { id: 'replace', label: 'Replace the list', kind: 'primary' },
        ],
      });
      if (r.choice !== 'append' && r.choice !== 'replace') return;
      replace = r.choice === 'replace';
    }
    const name = path.split(/[\\/]/).pop() ?? path;
    await takeParsed(parseRecipients(text, unit, unitInfo(unit).short), replace, 'From a file', name);
  }

  async function exportList() {
    const path = await saveTextAs({ title: t('Export the list'), name: 'thunder-batch.csv', filters: [FILTERS.csv] }, recipientsCsv(draft.list, unit)).catch((e) => {
      toast('error', t('Export the list'), errorText(e));
      return null;
    });
    if (path) toast('success', t('List saved'), tn('%n recipient(s) saved', draft.list.length));
  }

  async function clearList() {
    if (draft.list.length > 5) {
      const r = await ask({ title: t('Clear the list'), message: t('Remove the %1 recipients of the list?', draft.list.length), level: 'warning', choices: [{ id: 'no', label: 'Cancel' }, { id: 'yes', label: 'Clear', kind: 'danger' }] });
      if (r.choice !== 'yes') return;
    }
    checkSeq++;
    checking = false;
    draft.list = [];
    draft.skipped = [];
    draft.source = '';
    draft.sourceFile = '';
    selected = null;
    done = null;
  }

  async function mergeAll() {
    const { list, merged } = mergeDuplicates(draft.list);
    await setList(list);
    toast('success', t('Duplicates merged'), tn('%n row(s) merged into others', merged));
  }

  async function dropProblems() {
    const n = draft.list.filter((r) => r.problem).length;
    await setList(draft.list.filter((r) => !r.problem));
    show = 'all';
    toast('info', t('Rows removed'), tn('%n row(s) with a problem removed', n));
  }

  async function saveEdit() {
    if (!chosen) return;
    const id = chosen.id;
    await setList(draft.list.map((r) => (r.id === id ? { ...r, address: editAddress.trim(), amount: editAmount, amountText: editAmount === null ? '' : formatAmount(editAmount, editUnit, { separators: false }), label: editLabel.trim().slice(0, 256) } : r)));
  }

  async function removeChosen() {
    if (!chosen) return;
    const id = chosen.id;
    const index = draft.list.findIndex((r) => r.id === id);
    const next = draft.list[index + 1] ?? draft.list[index - 1];
    await setList(draft.list.filter((r) => r.id !== id));
    selected = next ? String(next.id) : null;
  }

  // --- Paying ---

  function recipientsOf(part: readonly Recipient[]) {
    return part.map((r) => ({ address: r.address, label: r.label, amount: r.amount!, subtractFee: draft.subtractFee }));
  }

  async function presentPsbt(psbt: string, recipients: { address: string; label?: string; amount: bigint }[]) {
    await host.copy(psbt).catch(() => undefined);
    const r = await ask({
      title: t('Unsigned Transaction'),
      message: t('The PSBT has been copied to the clipboard. You can also save it.'),
      code: psbt,
      level: 'info',
      choices: [
        { id: 'discard', label: 'Discard' },
        { id: 'save', label: 'Save…', kind: 'primary' },
      ],
    });
    if (r.choice !== 'save') return;
    const path = await saveBase64As({ title: 'Save Transaction Data', name: safeFileName(psbtFileName(recipients, prefs.unit)), filters: [FILTERS.psbt] }, psbt);
    if (path) toast('success', t('PSBT saved'), t('PSBT saved to disk'));
  }

  async function pay() {
    if (!api || wallet === null || busy) return;
    // A list being checked is paid once checked.
    while (checking) await checkRun;
    const list = ready;
    if (list.length === 0) {
      toast('warning', t('Batch pay'), t('No recipient is ready to be paid.'));
      return;
    }
    if (prefs.feeMode === 'custom' && customFee === null) {
      toast('warning', t('Batch pay'), t('Enter a custom fee, or choose the recommended fee.'));
      return;
    }
    const parts = partsOf(list);
    const watchOnly = !!info?.privateKeysDisabled && !info?.externalSigner;
    if (watchOnly && parts.length > 1) {
      await inform(t('Batch pay'), t('This wallet cannot sign: it makes one unsigned transaction at a time, of at most %1 recipients. Shorten the list.', PART_SIZE), 'warning');
      return;
    }
    if (totals.problems) {
      const r = await ask({
        title: t('Batch pay'),
        message: tn('%n recipient(s) of the list have a problem and are left out.', totals.problems),
        informative: t('Only the %1 recipients that are ready are paid.', list.length),
        level: 'warning',
        choices: [
          { id: 'look', label: 'Look at them' },
          { id: 'go', label: 'Continue', kind: 'primary' },
        ],
      });
      if (r.choice !== 'go') {
        if (r.choice === 'look') show = 'problems';
        return;
      }
    }
    const cc = coinChoice ? { selected: selectedCoins } : {};
    busy = true;
    done = null;
    // The passphrase of a locked wallet, kept only while the parts are made (each is signed as it is made), then dropped.
    let passphrase: string | undefined;
    let prepared: Prepared | null = null;
    try {
      prepared = await withUnlock(wallet, (p) => {
        passphrase = p;
        return api.prepare(recipientsOf(parts[0]), cc, feeChoice, p);
      });
    } catch (e) {
      busy = false;
      passphrase = undefined;
      await inform(t('Batch pay'), errorText(e), 'warning');
      return;
    }
    if (!prepared) {
      busy = false;
      return;
    }
    const amount = list.reduce((n, r) => n + r.amount!, 0n);
    const lines = list.slice(0, LISTED).map((r) => (r.label ? `${t("%1 to '%2'", formatAmount(r.amount!, prefs.unit, { withUnit: true }), r.label)} (${r.address})` : t('%1 to %2', formatAmount(r.amount!, prefs.unit, { withUnit: true }), r.address)));
    if (list.length > LISTED) lines.push(t('…and %1 more', list.length - LISTED));
    const kvb = (prepared.vsize / 1000).toPrecision(3);
    const informative = [
      parts.length > 1 ? t('%1 transactions of at most %2 recipients, sent one after the other.', parts.length, PART_SIZE) : t('One transaction of %1 vbytes, %2 of a block.', prepared.vsize, formatShare((prepared.vsize * 4) / MAX_BLOCK_WEIGHT)),
      t('Transaction fee (%1 kvB): %2', kvb, formatAmount(prepared.fee, prefs.unit, { withUnit: true })),
      parts.length > 1 ? t('The fee of the others is worked out as each is made, at the same rate.') : '',
      draft.subtractFee ? t('The fee is taken from the amounts, shared equally.') : '',
      t('Total Amount: %1', formatAmount(draft.subtractFee ? amount : amount + prepared.fee, prefs.unit, { withUnit: true })),
    ]
      .filter(Boolean)
      .join('\n');
    const choices: Choice[] = [{ id: 'cancel', label: 'Cancel' }];
    if ((prefs.psbtControls || watchOnly) && parts.length === 1) choices.push({ id: 'psbt', label: 'Create Unsigned', delay: SEND_CONFIRM_DELAY });
    if (!watchOnly) choices.push({ id: 'send', label: info?.externalSigner ? 'Sign on device' : 'Send', kind: 'primary', delay: SEND_CONFIRM_DELAY });
    const answer = await ask({
      title: t('Confirm batch payment'),
      message: tn('Pay %n recipient(s)?', list.length),
      informative,
      details: lines,
      level: 'question',
      choices,
    });
    if (answer.choice !== 'send' && answer.choice !== 'psbt') {
      api.discard(prepared.token).catch(() => undefined);
      busy = false;
      passphrase = undefined;
      return;
    }
    const txids: string[] = [];
    let paid = 0;
    let paidAmount = 0n;
    const paidIds = new Set<number>();
    try {
      if (answer.choice === 'psbt') {
        const { psbt } = await api.createPsbt(prepared.token);
        busy = false;
        await presentPsbt(psbt, prepared.recipients);
        done = { txids: [], count: parts[0].length, amount, psbt: true };
        return;
      }
      progress = { part: 1, parts: parts.length, paid: 0 };
      for (let k = 0; k < parts.length; k++) {
        progress = { part: k + 1, parts: parts.length, paid };
        if (k > 0) prepared = await api.prepare(recipientsOf(parts[k]), {}, feeChoice, passphrase);
        const result = await api.commit(prepared!.token);
        if (!result.complete && result.psbt) {
          // A hardware wallet signed only part of it (a multisig wallet): the rest goes to the user.
          await presentPsbt(result.psbt, prepared!.recipients);
          break;
        }
        if (result.txid) txids.push(result.txid);
        for (const r of parts[k]) {
          paidIds.add(r.id);
          paidAmount += r.amount!;
        }
        paid += parts[k].length;
      }
    } catch (e) {
      await inform(t('Batch pay'), paid ? t('%1 recipients were paid, in %2 transactions; the others were not: %3', paid, txids.length, errorText(e)) : errorText(e), 'error');
    } finally {
      passphrase = undefined;
      progress = null;
      busy = false;
    }
    if (paid) {
      // What was paid leaves the list; what was not stays, to send again.
      await setList(draft.list.filter((r) => !paidIds.has(r.id)));
      selected = null;
      if (!draft.list.length) {
        draft.source = '';
        draft.sourceFile = '';
        draft.skipped = [];
      }
      done = { txids, count: paid, amount: paidAmount, psbt: false };
      toast('success', t('Batch sent'), tn('%n recipient(s) paid', paid));
      nav.highlightTx = txids[txids.length - 1] ?? null;
    }
  }

  // --- The table ---

  type Row = Recipient & { n: number };
  const rows = $derived<Row[]>(draft.list.map((r, i) => ({ ...r, n: i + 1 })).filter((r) => show === 'all' || r.problem));
  const columns: Column<Row>[] = [
    { key: 'n', label: '#', value: (r) => r.n, width: '3.4rem', align: 'end', noFilter: true },
    { key: 'address', label: 'Address', value: (r) => r.address, width: 'minmax(8rem, 2.4fr)', mono: true },
    { key: 'label', label: 'Label', value: (r) => r.label, width: 'minmax(4rem, 1fr)' },
    { key: 'amount', label: 'Amount', value: (r) => r.amount ?? -1n, width: 'minmax(7.5rem, 1fr)', align: 'end', noFilter: true },
    { key: 'check', label: 'Check', value: (r) => (r.problem ? t(r.problem) : r.note ? t(r.note) : t('Ready')), width: 'minmax(5.5rem, 1.1fr)', words: true },
  ];
  let sortKey: string | null = $state('n');
  let sortDir: 'asc' | 'desc' = $state('asc');
</script>

<div class="page th-page batch">
  <header class="th-head">
    <div>
      <h1>Batch pay</h1>
      <p class="th-sub">{t('Pay many recipients at once. Up to %1 go in one transaction; a longer list is paid in several, one after the other.', formatCount(PART_SIZE))}</p>
    </div>
    <div class="th-tools">
      <label class="unit-pick" title="The unit the amounts of a paste or a file are read in">
        <span class="muted">Amounts in</span>
        <select aria-label="Amounts in" value={unit} onchange={(e) => (draft.unit = (e.currentTarget as HTMLSelectElement).value as Unit)}>
          {#each UNITS as u (u.id)}<option value={u.id}>{u.short}</option>{/each}
        </select>
      </label>
      <button type="button" class="btn small" onclick={openPaste}><Icon name="paste" size={15} /> Paste…</button>
      <button type="button" class="btn small" onclick={importFile}><Icon name="upload" size={15} /> Import CSV…</button>
      <button type="button" class="btn ghost small" disabled={!draft.list.length} onclick={exportList}><Icon name="download" size={15} /> Export…</button>
      <button type="button" class="btn ghost small" disabled={!draft.list.length || busy} onclick={clearList}><Icon name="trash" size={15} /> Clear</button>
    </div>
  </header>

  {#if node.tip?.ibd}
    <p class="th-note th-warn" role="status"><Icon name="alert" size={15} /> The displayed information may be out of date. Your wallet automatically synchronizes with the network after a connection is established, but this process has not completed yet.</p>
  {/if}

  <div class="th-split">
    <div class="main">
      <form class="panel add" aria-label="Add a recipient" onsubmit={addOne}>
        <div class="field address">
          <label for="bp-add-address">Pay to</label>
          <input id="bp-add-address" type="text" class="mono" bind:value={addAddress} placeholder={t('Enter a %1 address', CHAIN.name)} autocomplete="off" spellcheck="false" />
        </div>
        <div class="amount"><AmountInput id="bp-add-amount" label="Amount" bind:value={addAmount} bind:unit={addUnit} /></div>
        <div class="field label">
          <label for="bp-add-label">Label</label>
          <input id="bp-add-label" type="text" bind:value={addLabel} placeholder="Optional" autocomplete="off" />
        </div>
        <button type="submit" class="btn primary add-btn" disabled={busy}><Icon name="plus" size={16} /> Add</button>
        {#if addError}<p class="error add-error" role="alert"><SafeText text={addError} /></p>{/if}
      </form>

      <section class="panel list" aria-labelledby="bp-list-title">
        <div class="panel-head list-head">
          <h2 id="bp-list-title">Recipients</h2>
          {#if draft.source}
            <span class="faint small">{t(draft.source)}{#if draft.sourceFile}: <SafeText text={draft.sourceFile} />{/if}</span>
          {/if}
          <span class="grow"></span>
          <div class="th-chips" role="group" aria-label="Show">
            <button type="button" aria-pressed={show === 'all'} onclick={() => (show = 'all')}>All<span class="th-count">{totals.count}</span></button>
            <button type="button" aria-pressed={show === 'problems'} onclick={() => (show = 'problems')}>To look at<span class="th-count">{totals.problems}</span></button>
          </div>
          <input type="search" class="search" aria-label="Search the recipients" placeholder="Search" bind:value={search} />
        </div>
        {#if draft.list.length === 0}
          <div class="th-empty empty">
            <Icon name="batch" size={34} />
            <p>No recipient yet. Add them one by one above, paste a list, or import a CSV file of lines like these:</p>
            <pre class="example" translate="no">address,amount,label
{hrp}1q…,0.25,Alice
{hrp}1q…,1.5,Bob</pre>
            <p class="faint small">The first line may name the columns (address, amount, label, in any order). Amounts are read in the unit chosen above.</p>
          </div>
        {:else}
          <div class="th-table">
            <DataTable {rows} {columns} key={(r) => String(r.id)} filter={search} bind:selected bind:sortKey bind:sortDir label="Recipients of the batch" empty="No recipient" fit>
              {#snippet cell(r, c)}
                {#if c.key === 'n'}<span class="faint num">{r.n}</span>
                {:else if c.key === 'address'}<SafeText text={r.address || '–'} />
                {:else if c.key === 'label'}<SafeText text={r.label} />
                {:else if c.key === 'amount'}{#if r.amount === null}<SafeText class="th-down" text={r.amountText || '–'} />{:else}<Amount sats={r.amount} />{/if}
                {:else if r.problem}<span class="th-tag bad" title={t(r.problem)}>{t(r.problem)}</span>
                {:else if r.note}<span class="th-tag" title={t(r.note)}>{t(r.note)}</span>
                {:else}<span class="th-tag ok">Ready</span>{/if}
              {/snippet}
            </DataTable>
          </div>
          {#if chosen}
            <form class="edit" aria-label="Edit the recipient" onsubmit={(e) => { e.preventDefault(); void saveEdit(); }}>
              <span class="faint small">#{draft.list.indexOf(chosen) + 1}{#if chosen.line} · {t('line %1', chosen.line)}{/if}</span>
              <input type="text" class="mono grow" aria-label="Address" bind:value={editAddress} spellcheck="false" autocomplete="off" />
              <div class="edit-amount"><AmountInput id="bp-edit-amount" label="Amount" bind:value={editAmount} bind:unit={editUnit} /></div>
              <input type="text" aria-label="Label" placeholder="Label" bind:value={editLabel} autocomplete="off" />
              <button type="submit" class="btn small" disabled={busy}>Save</button>
              <button type="button" class="btn ghost small" disabled={busy} onclick={removeChosen}><Icon name="trash" size={15} /> Remove</button>
            </form>
          {/if}
          <div class="list-foot">
            {#if checking}<span class="muted small" role="status">Checking the list…</span>{/if}
            {#if duplicates}<button type="button" class="btn small" onclick={mergeAll} title="Pay each address once, the sum of its amounts">Merge duplicates</button>{/if}
            {#if totals.problems}<button type="button" class="btn ghost small" onclick={dropProblems}>Remove the rows to look at</button>{/if}
            {#if draft.skipped.length}
              <details class="skipped">
                <summary>{tn('%n line(s) left out', draft.skipped.length)}</summary>
                <ul>
                  {#each draft.skipped.slice(0, 50) as s (s.line)}<li><span class="faint">{t('line %1', s.line)}</span> {t(s.why)}: <SafeText class="mono" text={s.text} /></li>{/each}
                </ul>
              </details>
            {/if}
          </div>
        {/if}
      </section>

      {#if totals.ready > 0 && wallet !== null}
        <section class="panel coins" aria-labelledby="bp-coins-title">
          <div class="panel-head">
            <h2 id="bp-coins-title">Coins to spend</h2>
            <label class="switch" title="See the coins of the wallet and choose the ones this transaction spends">
              <input type="checkbox" role="switch" checked={prefs.coinControl} onchange={(ev) => savePrefs({ coinControl: (ev.currentTarget as HTMLInputElement).checked })} />
              <span class="track" aria-hidden="true"></span>
              <span>Choose coins</span>
            </label>
          </div>
          <div class="panel-body">
            {#if !prefs.coinControl}
              <p class="muted flat">Coins are chosen automatically. Turn on "Choose coins" to pick the ones to spend.</p>
            {:else if totals.parts > 1}
              <p class="muted flat">The list takes {totals.parts} transactions: the wallet chooses their coins.</p>
            {:else}
              <CoinPanel {wallet} bind:selected={selectedCoins} amounts={ready.map((r) => r.amount ?? 0n)} subtractFee={draft.subtractFee} fee={feeChoice} />
            {/if}
          </div>
        </section>
      {/if}
    </div>

    <aside class="panel th-aside" aria-label="Summary of the batch">
      <h2>Summary</h2>
      <div>
        <span class="muted small">To pay</span>
        <div class="th-big"><Amount sats={totals.amount} /></div>
        <span class="faint small">{tn('%n recipient(s) ready', totals.ready)}{#if totals.problems} · <span class="th-warn">{tn('%n to look at', totals.problems)}</span>{/if}</span>
      </div>
      <dl class="th-pairs">
        <dt>Transactions</dt><dd>{totals.parts}</dd>
        <dt>Size, about</dt><dd>{totals.vsize ? `${(totals.vsize / 1000).toFixed(1)} kvB` : '–'}</dd>
        <dt>Of a block</dt><dd>{formatShare(totals.blockShare)}</dd>
        <dt>Fee, about</dt><dd>{#if feeRate}<Amount sats={feeEstimate} />{:else}–{/if}</dd>
        <dt>Balance</dt><dd><Amount sats={balance} /></dd>
        <dt>After</dt><dd class:th-down={afterBalance !== undefined && afterBalance < 0n}><Amount sats={afterBalance} /></dd>
      </dl>
      <Meter value={Math.min(totals.blockShare, 1)} max={1} label="Share of a block the batch takes" text={formatShare(totals.blockShare)} tone={totals.blockShare > 0.5 ? 'warning' : 'accent'} />

      <div class="fee">
        <label class="choice">
          <input type="radio" name="bp-fee" checked={prefs.feeMode !== 'custom'} onchange={() => savePrefs({ feeMode: 'smart' })} />
          <span>Recommended {#if smart}<span class="num">{formatAmount(BigInt(smart.feePerK), prefs.unit, { withUnit: true })}/kvB</span>{/if}</span>
        </label>
        <select aria-label="Confirmation time target" disabled={prefs.feeMode === 'custom'} value={confTarget} onchange={(ev) => savePrefs({ confTarget: Number((ev.currentTarget as HTMLSelectElement).value) })}>
          {#each CONF_TARGETS as target (target)}<option value={target}>{niceTimeOffset(target * spacing)} ({target} blocks)</option>{/each}
        </select>
        {#if smart?.fallback && prefs.feeMode !== 'custom'}<p class="th-note th-warn">Smart fee not initialized yet. This usually takes a few blocks…</p>{/if}
        <label class="choice">
          <input type="radio" name="bp-fee" checked={prefs.feeMode === 'custom'} onchange={() => savePrefs({ feeMode: 'custom' })} />
          <span>Custom, per kilobyte</span>
        </label>
        {#if prefs.feeMode === 'custom'}
          <AmountInput id="bp-custom-fee" label="Fee per 1000 virtual bytes" bind:value={customFee} min={BigInt(smart?.requiredFeePerK ?? info?.requiredFeePerK ?? 1000)} />
        {/if}
        <label class="check" title="The fee will be deducted from the amounts being sent, shared equally among the recipients.">
          <input type="checkbox" bind:checked={draft.subtractFee} />
          <span>Subtract fee from amounts</span>
        </label>
      </div>

      {#if progress}
        <div class="th-progress" role="status" aria-live="polite">
          <strong>{t('Sending transaction %1 of %2…', progress.part, progress.parts)}</strong>
          <Meter value={progress.part - 1} max={progress.parts} label="Transactions sent" text={`${progress.part - 1} / ${progress.parts}`} />
        </div>
      {/if}

      <button type="button" id="bp-pay" class="btn primary pay" disabled={busy || !totals.ready || !info || (!canSign && !info.privateKeysDisabled)} onclick={pay}>
        <Icon name="batch" size={17} /> {busy ? 'Working…' : info?.privateKeysDisabled && !info.externalSigner ? 'Create Unsigned…' : 'Review and pay…'}
      </button>

      {#if done}
        <div class="done" role="status">
          <strong>{done.psbt ? t('Unsigned transaction made for %1 recipients', done.count) : tn('%n recipient(s) paid', done.count)}</strong>
          <span><Amount sats={done.amount} /></span>
          {#each done.txids as txid (txid)}<span class="mono small break" translate="no">{txid}</span>{/each}
          {#if done.txids.length}<button type="button" class="btn small" onclick={() => go('payments', 'batches')}><Icon name="ledger" size={15} /> Show in Payments</button>{/if}
        </div>
      {/if}
    </aside>
  </div>
</div>

<Dialog bind:open={pasteOpen} title="Paste a list of payments" wide>
  <form id="bp-paste-form" class="paste" onsubmit={readPaste}>
    <p class="muted flat">One recipient a line: the address, the amount and a label if you like, separated by commas, semicolons, tabs or spaces. Amounts in {unitInfo(unit).short}.</p>
    <textarea id="bp-paste" rows="10" class="mono" bind:value={pasteText} spellcheck="false" aria-label="The list"></textarea>
    {#if pastePreview}
      <p class="small" role="status">{tn('%n recipient(s) read', pastePreview.recipients.length)}{#if pastePreview.skipped.length} · {tn('%n line(s) left out', pastePreview.skipped.length)}{/if}{#if pastePreview.header} · {t('the first line names the columns')}{/if}</p>
    {/if}
    {#if draft.list.length}
      <div class="row">
        <label class="check"><input type="radio" name="bp-paste-mode" value="append" bind:group={pasteMode} /> <span>Add to the list</span></label>
        <label class="check"><input type="radio" name="bp-paste-mode" value="replace" bind:group={pasteMode} /> <span>Replace the list</span></label>
      </div>
    {/if}
  </form>
  {#snippet actions()}
    <button type="button" class="btn" onclick={() => (pasteOpen = false)}>Cancel</button>
    <button type="submit" form="bp-paste-form" class="btn primary" disabled={!pastePreview?.recipients.length}>Read the list</button>
  {/snippet}
</Dialog>

<style>
  .main {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    min-width: 0;
  }
  .add {
    display: grid;
    grid-template-columns: minmax(14rem, 2.2fr) minmax(11rem, 1.2fr) minmax(8rem, 1fr) auto;
    align-items: end;
    gap: 0.7rem;
    padding: 0.9rem 1rem;
  }
  @container (max-width: 760px) {
    .add {
      grid-template-columns: minmax(0, 1fr);
    }
  }
  .add-btn {
    margin-bottom: 0.05rem;
  }
  .add-error {
    grid-column: 1 / -1;
    margin: 0;
  }
  .list {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .list-head {
    flex-wrap: wrap;
    gap: 0.5rem 0.8rem;
  }
  .search {
    width: min(14rem, 100%);
  }
  .list .th-table {
    padding: 0 1rem;
  }
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.6rem;
  }
  .empty p {
    margin: 0;
    max-width: 38rem;
  }
  .example {
    margin: 0;
    padding: 0.6rem 0.9rem;
    border: 1px dashed var(--line-strong);
    border-radius: var(--radius-s);
    background: var(--surface-2);
    color: var(--text);
    text-align: left;
    font-size: 0.86rem;
  }
  .edit {
    display: flex;
    flex-wrap: wrap;
    align-items: end;
    gap: 0.5rem;
    margin: 0.7rem 1rem 0;
    padding: 0.6rem 0.8rem;
    border: 1px solid var(--accent-soft);
    border-radius: var(--radius-m);
    background: var(--surface-2);
  }
  .edit .grow {
    min-width: 14rem;
  }
  .edit-amount {
    min-width: 11rem;
  }
  .list-foot {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem 0.8rem;
    padding: 0.7rem 1rem 1rem;
  }
  .skipped {
    width: 100%;
    font-size: 0.88rem;
  }
  .skipped ul {
    margin: 0.4rem 0 0;
    padding-left: 1.1rem;
    max-height: 10rem;
    overflow: auto;
  }
  .unit-pick {
    white-space: nowrap;
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.88rem;
  }
  .fee {
    display: flex;
    flex-direction: column;
    gap: 0.45rem;
    padding-top: 0.6rem;
    border-top: 1px solid var(--line);
  }
  .choice {
    display: flex;
    gap: 0.5rem;
    align-items: baseline;
    cursor: pointer;
    font-size: 0.92rem;
  }
  .pay {
    justify-content: center;
    padding: 0.7rem 1rem;
  }
  .done {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    padding: 0.8rem;
    border-radius: var(--radius-m);
    background: var(--accent-soft);
  }
  .paste {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }
  .paste textarea {
    width: 100%;
    min-height: 12rem;
    resize: vertical;
  }
  .flat {
    margin: 0;
  }
  .small {
    font-size: 0.84rem;
  }
</style>
