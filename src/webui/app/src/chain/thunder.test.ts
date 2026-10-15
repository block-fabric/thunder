// The pages of Thunder: what th/model.ts works out (the recipients of a paste or a CSV file, checked,
// merged, totalled and cut into transactions; the history as payments, a batch as one; the throughput
// from the statistics of the blocks), and the pages driven against a pretend node: Batch pay from a paste
// and from a file, paid in one transaction and in several; Payments with a batch opened and paid again;
// Throughput and its mempool; the cards of the home; where the pages are in the menus; and the RPC
// methods the pages call, against the policy the host ships.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CHAIN } from './config';
import { LOCAL_COMMANDS, LOCAL_PAGES, type LocalPage } from './local';
import LocalCards from './LocalCards.svelte';
import BatchPay from './pages/BatchPay.svelte';
import Payments from './pages/Payments.svelte';
import Throughput from './pages/Throughput.svelte';
import {
  blockStatOf,
  blocksToClear,
  capacityOf,
  checkRecipients,
  dailyTotals,
  dayOf,
  detectSeparator,
  dustThreshold,
  formatShare,
  MAX_BLOCK_WEIGHT,
  mergeDuplicates,
  newRecipient,
  PART_SIZE,
  parseRecipients,
  partFees,
  feeOverEstimate,
  amountColumnRem,
  textOfFile,
  partsOf,
  paymentsCsv,
  paymentsOf,
  recipientsCsv,
  splitCsvLine,
  throughputOf,
  totalsOf,
} from './th/model';
import { draft, resetDraft, resetThroughput, th } from './th/store.svelte';
import DialogHost from '../components/DialogHost.svelte';
import { setTransport, type BridgeRequest } from '../lib/bridge';
import { buildCommands, menuSections } from '../lib/commands.svelte';
import { dialogs } from '../lib/dialogs.svelte';
import { BLOCK_WEIGHT } from '../lib/blocks';
import { bytesToBase64 } from '../lib/files';
import { AREAS, chainBeforeTools, HOME_QUICK_ACTIONS, NAV_SECTIONS } from '../lib/layout';
import { go, nav } from '../lib/nav.svelte';
import { app, node, prefs, wallets } from '../lib/state.svelte';
import { parseRecords } from '../lib/wallet';
import { resetWalletData } from '../lib/walletdata.svelte';
import { encode, program } from '../test/bech32';

const HRP = CHAIN.networks.regtest.hrp;
/** P2WPKH addresses of regtest, told apart by their program. */
const addr = (n: number) => encode(HRP, [0, ...Array.from({ length: 32 }, (_, i) => (i < 4 ? (n >> (5 * i)) & 31 : (i * 7 + 1) % 32))], false);
const A = addr(1);
const B = addr(2);
const C = addr(3);
const MAIN = encode(CHAIN.networks.main.hrp, [0, ...program(20)], false);
const id = (c: string) => c.repeat(64);
const SAT = 100_000_000n;

const INFO = {
  name: 'w',
  encrypted: false,
  locked: false,
  privateKeysDisabled: false,
  externalSigner: false,
  hd: true,
  canGetAddresses: true,
  taproot: true,
  defaultAddressType: 'bech32',
  confirmTarget: 6,
  requiredFeePerK: 1000,
  maxTxFee: 10_000_000,
  multiwallet: false,
  balance: 500_000_000_000,
  unconfirmed: 0,
  immature: 0,
};

/** A record as the host sends it (walletapi.cpp RecordJson). */
function rec(txid: string, idx: number, type: string, address: string, label: string, time: number, credit: number, debit: number, status = 'confirmed', depth = 3): unknown[] {
  return [txid, idx, type, address, label, time, credit, debit, status, depth, 0, true, `${time}-${idx}`, 10, 'c', type === 'mined', false, true];
}

const NOW = Math.floor(Date.now() / 1000);
/** A batch of three (the fee of 500 sat in the first record), a payment received, a single send. */
const RECORDS = [
  rec(id('a'), 0, 'send', A, 'Alice', NOW - 60, 0, -100_000_500),
  rec(id('a'), 1, 'send', B, 'Bob', NOW - 60, 0, -200_000_000),
  rec(id('a'), 2, 'send', C, '', NOW - 60, 0, -300_000_000),
  rec(id('b'), 0, 'recv', A, 'Salary', NOW - 3600, 900_000_000, 0),
  rec(id('c'), 1, 'send', B, 'Bob', NOW - 86400 * 3, 0, -50_000_300),
];

const calls: BridgeRequest[] = [];
let prepared = 0;
let fileText = '';
let commitFails = false;

function stats(height: number) {
  return {
    height,
    blockhash: (height % 16).toString(16).repeat(64),
    time: 1_700_000_000 + height * 60,
    txs: height === 20 ? 4001 : 11,
    total_weight: height === 20 ? 20_000_000 : 40_000,
    total_size: 10_000,
    totalfee: 5000,
    feerate_percentiles: [1, 1, 2, 3, 4],
    ins: 10,
    outs: 20,
  };
}

async function fakeNode(r: BridgeRequest): Promise<unknown> {
  calls.push(r);
  const p = (r.params ?? {}) as Record<string, unknown>;
  const a = (r.params ?? []) as unknown[];
  switch (r.method) {
    case 'wallet.info':
      return INFO;
    case 'wallet.fee':
      return { feePerK: 2000, fallback: false, target: 6, requiredFeePerK: 1000, reason: 'Fee Rate Estimator' };
    case 'wallet.send.prepare': {
      prepared++;
      const recipients = p.recipients as { address: string; label: string; amount: number }[];
      return { token: `t${prepared}`, fee: 1000 * prepared, vsize: 31 * recipients.length + 110, total: recipients.reduce((n, x) => n + x.amount, 0) + 1000, recipients, privateKeysDisabled: false, externalSigner: false, txid: id(String(prepared)) };
    }
    case 'wallet.send.commit':
      if (commitFails && String(p.token) === 't2') throw Object.assign(new Error('Insufficient funds'), { code: -6 });
      return { complete: true, txid: id(String(p.token).slice(1)) };
    case 'wallet.send.discard':
      return true;
    case 'wallet.coins':
      return [{ address: A, label: '', coins: [{ txid: 'cc'.repeat(32), vout: 0, address: A, label: '', sats: 1_000 * 100_000_000, time: 1_700_000_000, depth: 10, locked: false }] }];
    case 'wallet.coinControl.summary':
      return { quantity: 1, amount: 1e11, fee: 300, afterFee: 1e11 - 300, bytes: 150, change: 0, changeEnabled: true, insufficient: false, feeVary: 1, spent: [] };
    case 'wallet.transactions':
      return { height: 12, hash: 'h', maturity: 100, records: RECORDS };
    case 'wallet.transaction':
      return { txid: p.txid, coinbase: false, rows: [{ k: 'Transaction fee', sats: -500 }], notes: [], ids: [], messages: [] };
    case 'file.choose':
      return '/home/u/payroll.csv';
    case 'file.read':
      return { path: p.path, size: fileText.length, base64: bytesToBase64(new TextEncoder().encode(fileText)) };
    case 'file.write':
      return p.path;
    case 'getblockstats':
      return stats(a[0] as number);
    case 'getmempoolinfo':
      return { size: 120, bytes: 16_000_000, usage: 40_000_000, total_fee: 0.012, mempoolminfee: 0.00001 };
    case 'estimatesmartfee':
      return a[0] === 1 ? { feerate: 0.00002 } : { errors: ['Insufficient data or no feerate found'] };
    case 'getchaintxstats':
      return { txcount: 123_456, window_block_count: a[0], window_tx_count: 200, window_interval: 1200, txrate: 0.1667 };
    case 'prefs.set':
      return {};
    default:
      return null;
  }
}

beforeAll(() => {
  const proto = HTMLDialogElement.prototype as unknown as Record<string, unknown>;
  proto.showModal ??= function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  proto.close ??= function (this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
  (globalThis as Record<string, unknown>).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

beforeEach(() => {
  app.info = { name: CHAIN.name, version: 'test', bugreport: '', network: 'regtest', networkLabel: 'regtest', datadir: '/tmp', walletEnabled: true, devtools: false, test: true, platform: 'linux', blockSpacing: 60 };
  prefs.unit = 'CHN';
  prefs.mask = false;
  prefs.feeMode = 'smart';
  prefs.coinControl = false;
  prefs.psbtControls = false;
  node.tip = { height: 20, time: 1_700_001_200, hash: 'ab'.repeat(32), progress: 1, state: 'synced', ibd: false, loadingBlocks: false };
  wallets.list = [{ name: 'w', encrypted: false, locked: false, privateKeysDisabled: false, hd: true }];
  wallets.current = 'w';
  wallets.balances.w = { trusted: 5000n * SAT, untrustedPending: 0n, immature: 0n };
  calls.length = 0;
  prepared = 0;
  fileText = '';
  commitFails = false;
  resetDraft();
  resetThroughput();
  setTransport(fakeNode);
});

afterEach(() => {
  setTransport(null);
  dialogs.queue.splice(0);
  wallets.list = [];
  wallets.current = null;
  resetWalletData();
  resetDraft();
  resetThroughput();
  nav.tab = '';
});

const called = (method: string) => calls.filter((c) => c.method === method);
async function answer(choice: string, timeout = 1000) {
  await waitFor(() => expect(document.querySelector<HTMLButtonElement>(`button[data-choice="${choice}"]`)?.disabled).toBe(false), { timeout });
  await fireEvent.click(document.querySelector(`button[data-choice="${choice}"]`)!);
}

describe('the recipients of a batch, as the page reads them', () => {
  it('splits lines of CSV, quotes and all, and tells the separator', () => {
    expect(splitCsvLine('"a, b",2,"say ""hi"""', ',')).toEqual(['a, b', '2', 'say "hi"']);
    expect(splitCsvLine(' x ;1,5; y', ';')).toEqual(['x', '1,5', 'y']);
    expect(detectSeparator(['a\t1', 'b\t2'])).toBe('\t');
    expect(detectSeparator(['a;1,5', 'b;2'])).toBe(';');
    expect(detectSeparator(['a,1', 'b,2'])).toBe(',');
    expect(detectSeparator(['a 1', 'b 2'])).toBe(' ');
  });

  it('reads a header in any order, quotes, units after amounts, labels with spaces; leaves out what is not a recipient', () => {
    const csv = `﻿label,amount,address\n"Alice, Inc.",1.5 CHN,${A}\n# a comment\n\n,,\nBob,0.25,${B}\n`;
    const r = parseRecipients(csv, 'CHN', 'CHN');
    expect(r.header).toBe(true);
    expect(r.recipients.map((x) => [x.address, x.amount, x.label, x.line])).toEqual([
      [A, 150_000_000n, 'Alice, Inc.', 2],
      [B, 25_000_000n, 'Bob', 6],
    ]);
    expect(r.skipped).toEqual([{ line: 5, text: ',,', why: 'No address and no amount' }]);
    const spaced = parseRecipients(`${A} 1000 rent for may\n${B}   250`, 'sat', 'sat');
    expect(spaced.header).toBe(false);
    expect(spaced.recipients.map((x) => [x.amount, x.label])).toEqual([
      [1000n, 'rent for may'],
      [250n, ''],
    ]);
    // A semicolon list with comma decimals; an amount that is not one keeps its text.
    const semi = parseRecipients(`${A};1,5\n${B};lots`, 'CHN', 'CHN');
    expect(semi.recipients.map((x) => [x.amount, x.amountText])).toEqual([
      [150_000_000n, '1,5'],
      [null, 'lots'],
    ]);
  });

  it('checks each: an address of this chain and network, an amount above dust, each address once', async () => {
    const list = [
      newRecipient({ address: A, amount: SAT }),
      newRecipient({ address: MAIN, amount: SAT }),
      newRecipient({ address: 'nonsense', amount: SAT }),
      newRecipient({ address: B, amount: 200n }),
      newRecipient({ address: addr(9), amount: null, amountText: 'lots' }),
      newRecipient({ address: C, amount: SAT }),
      newRecipient({ address: A, amount: 2n * SAT }),
      // The same address as B, in capitals.
      newRecipient({ address: B.toUpperCase(), amount: SAT }),
      newRecipient({ address: addr(10).toUpperCase(), amount: 1000n * SAT }),
    ];
    const checked = await checkRecipients(list, 'regtest');
    expect(checked.map((r) => r.problem)).toEqual([
      'This address is in the list more than once',
      'This address is for another network',
      expect.stringMatching(/not an address/),
      'Too small to send: the output would be dust',
      'Not an amount',
      '',
      'This address is in the list more than once',
      'This address is in the list more than once',
      '',
    ]);
    expect(checked[8].note).toBe('A large amount');
    expect(dustThreshold(A, 'regtest')).toBe(294n);
    // Merged: one row an address, the sum of the amounts, the labels joined.
    const { list: merged, merged: n } = mergeDuplicates([newRecipient({ address: A, amount: SAT, label: 'x' }), newRecipient({ address: B, amount: SAT }), newRecipient({ address: A, amount: 2n * SAT, label: 'y' })]);
    expect(n).toBe(1);
    expect(merged.map((r) => [r.address, r.amount, r.label])).toEqual([
      [A, 3n * SAT, 'x + y'],
      [B, SAT, ''],
    ]);
  });

  it('totals the list, cuts it into transactions, and writes it back as CSV', async () => {
    const many = Array.from({ length: PART_SIZE + 1 }, (_, i) => newRecipient({ address: addr(i), amount: SAT }));
    const totals = totalsOf(many, 'regtest');
    expect(totals).toMatchObject({ count: PART_SIZE + 1, ready: PART_SIZE + 1, problems: 0, amount: BigInt(PART_SIZE + 1) * SAT, parts: 2 });
    expect(totals.vsize).toBeGreaterThan(31 * (PART_SIZE + 1));
    expect(totals.blockShare).toBeCloseTo((totals.vsize * 4) / MAX_BLOCK_WEIGHT, 9);
    expect(partsOf(many).map((p) => p.length)).toEqual([PART_SIZE, 1]);
    const list = [newRecipient({ address: A, amount: 150_000_000n, label: 'A "quoted", label' })];
    const back = parseRecipients(recipientsCsv(list, 'CHN'), 'CHN', 'CHN');
    expect(back.recipients.map((r) => [r.address, r.amount, r.label])).toEqual([[A, 150_000_000n, 'A "quoted", label']]);
  });
});

describe('the history as payments', () => {
  it('makes a transaction one payment: a batch of three, a payment received, a single send', () => {
    const payments = paymentsOf(parseRecords(RECORDS));
    expect(payments.map((p) => [p.txid, p.kind, p.count, p.amount])).toEqual([
      [id('a'), 'batch', 3, -600_000_500n],
      [id('b'), 'in', 1, 900_000_000n],
      [id('c'), 'out', 1, -50_000_300n],
    ]);
    const days = dailyTotals(payments, 7, NOW);
    expect(days.length).toBe(7);
    expect(days[6].day).toBe(dayOf(NOW));
    const total = days.reduce((n, d) => n + d.in - d.out, 0n);
    expect(total).toBe(900_000_000n - 600_000_500n - 50_000_300n);
    const csv = paymentsCsv(payments, 'CHN', true);
    // A line per recipient of the batch, then the others.
    expect(csv.trim().split('\n').length).toBe(1 + 3 + 2);
    expect(paymentsCsv(payments, 'CHN', false).trim().split('\n').length).toBe(1 + 3);
  });
});

describe('the throughput, from the statistics of the blocks', () => {
  it('counts transactions a second and per block, the fill of the blocks, the fees', () => {
    const blocks = [19, 20].map((h) => blockStatOf(stats(h)));
    expect(blocks[1]).toMatchObject({ height: 20, txs: 4000, weight: 20_000_000, fees: 5000, feeRate: 2 });
    const tp = throughputOf(blocks);
    expect(tp.tps).toBeCloseTo(4000 / 60, 6);
    expect(tp.avgTxs).toBe(2005);
    expect(tp.maxFill).toBeCloseTo(20 / 32, 9);
    expect(tp.interval).toBe(60);
    expect(throughputOf([]).tps).toBeNull();
    expect(capacityOf(60).perBlock).toBe(Math.floor(32_000_000 / 564));
    expect(blocksToClear(16_000_000)).toBe(2);
    expect([formatShare(0), formatShare(0.00001), formatShare(0.005), formatShare(0.05), formatShare(0.625)]).toEqual(['0%', '<0.01%', '0.50%', '5.0%', '63%']);
  });
});

describe.runIf(CHAIN.name === 'Thunder')('the pages of Thunder', () => {
  it('are in the Chain section and the menus, before the tools, with their quick action; thunder: links', () => {
    const own = (LOCAL_PAGES as readonly LocalPage[]).map((p) => p.id);
    expect(own).toEqual(['batchpay', 'payments', 'throughput']);
    // The Wallet section is the user's six (audit port-2 #9); Thunder's pages are under Chain.
    expect(NAV_SECTIONS.find((s) => s.title === 'Wallet')!.pages).toEqual(['overview', 'send', 'receive', 'transactions', 'wallets', 'advanced']);
    expect(NAV_SECTIONS.find((s) => s.title === 'Chain')!.pages).toEqual(['peg', 'batchpay', 'payments', 'throughput', 'explorer']);
    expect(AREAS.find((a) => a.id === 'wallet')!.tabs.map((t) => t.page)).not.toContain('batchpay');
    expect(AREAS.find((a) => a.id === 'chain')!.tabs.map((t) => t.page)).toContain('throughput');
    expect(chainBeforeTools(HOME_QUICK_ACTIONS.map((q) => q.page), (p) => p)).toBeNull();
    expect(HOME_QUICK_ACTIONS.map((q) => q.label)).toContain('Batch pay');
    const chain = menuSections(buildCommands()).find((s) => s.group === 'Chains')!;
    for (const c of LOCAL_COMMANDS) expect(chain.items.map((i) => i.label)).toContain(c.label);
    chain.items.find((c) => c.label === 'Mempool and fees')!.run();
    expect([nav.page, nav.tab]).toEqual(['throughput', 'mempool']);
    expect(CHAIN.uriScheme).toBe('thunder');
    expect([CHAIN.networks.main.hrp, CHAIN.networks.test.hrp, CHAIN.networks.regtest.hrp]).toEqual(['th', 'tth', 'rth']);
    expect(CHAIN.networks.main.p2p).toBe(9755);
    // The weight of a block, as the chain parameters set it on every network, and as the explorer draws it.
    expect(CHAIN.blockWeight).toBe(MAX_BLOCK_WEIGHT);
    expect(BLOCK_WEIGHT).toBe(32_000_000);
    const params = readFileSync(join(__dirname, '../../../../kernel/chainparams.cpp'), 'utf8');
    expect(params.match(/consensus\.max_block_weight = 32'000'000;/g)?.length).toBe(4);
  });

  it('Batch pay: a pasted list checked, its problems merged and removed, previewed, confirmed and paid in one transaction', async () => {
    render(BatchPay);
    render(DialogHost);
    await waitFor(() => expect(called('wallet.fee').length).toBeGreaterThan(0));
    await fireEvent.click(screen.getByRole('button', { name: /Paste/ }));
    await fireEvent.input(document.querySelector('#bp-paste')!, { target: { value: `address,amount,label\n${A},1,Alice\n${B},2,\u202eBob\n${A},0.5,Alice again\nbogus,1,x` } });
    await waitFor(() => expect(screen.getByText(/4 recipients read/)).toBeTruthy());
    await fireEvent.submit(document.querySelector('#bp-paste-form')!);
    await waitFor(() => expect(draft.list.length).toBe(4));
    await waitFor(() => expect(draft.list.filter((r) => r.problem).length).toBe(3));
    // A label from outside, shown as it is: never translated, isolated as to direction.
    // Rows with a problem are shown first; all of them a click away.
    expect(within(screen.getByRole('grid', { name: 'Recipients of the batch' })).getAllByRole('row').length).toBe(4);
    await fireEvent.click(screen.getByRole('button', { name: /^All/ }));
    const bob = await waitFor(() => [...document.querySelectorAll('span')].find((el) => el.textContent === '\u202eBob')!);
    expect(bob.getAttribute('translate')).toBe('no');
    expect(bob.getAttribute('dir')).toBe('auto');
    await fireEvent.click(screen.getByRole('button', { name: 'Merge duplicates' }));
    await waitFor(() => expect(draft.list.length).toBe(3));
    expect(draft.list[0]).toMatchObject({ address: A, amount: 150_000_000n, label: 'Alice + Alice again' });
    await fireEvent.click(screen.getByRole('button', { name: 'Remove the rows to look at' }));
    await waitFor(() => expect(draft.list.length).toBe(2));
    const summary = screen.getByRole('complementary', { name: 'Summary of the batch' });
    expect(within(summary).getByText(/2 recipients ready/)).toBeTruthy();
    await fireEvent.click(document.querySelector('#bp-pay')!);
    await waitFor(() => expect(screen.getByText('Pay 2 recipients?')).toBeTruthy());
    expect(called('wallet.send.prepare')[0].params).toMatchObject({ wallet: 'w', confTarget: 6, recipients: [{ address: A, amount: 150_000_000, label: 'Alice + Alice again', subtractFee: false }, { address: B, amount: 200_000_000 }] });
    expect(document.body.textContent).toContain('Total Amount: 3.50001000 CHN');
    await answer('send', 5000);
    await waitFor(() => expect(called('wallet.send.commit').length).toBe(1));
    await waitFor(() => expect(draft.list.length).toBe(0));
    expect(nav.highlightTx).toBe(id('1'));
    expect(screen.getByText(id('1'))).toBeTruthy();
  }, 15000);

  it('Batch pay: a CSV file chosen on the desktop, paid in two transactions; what was not paid stays', async () => {
    fileText = ['address;amount', ...Array.from({ length: PART_SIZE + 2 }, (_, i) => `${addr(i)};0,001`)].join('\n');
    commitFails = true;
    go('batchpay', 'import');
    render(BatchPay);
    render(DialogHost);
    await waitFor(() => expect(draft.list.length).toBe(PART_SIZE + 2));
    expect(called('file.choose').length).toBe(1);
    expect(draft.sourceFile).toBe('payroll.csv');
    await waitFor(() => expect(draft.list.every((r) => !r.problem)).toBe(true));
    expect(screen.getByText('payroll.csv').getAttribute('translate')).toBe('no');
    await fireEvent.click(document.querySelector('#bp-pay')!);
    await waitFor(() => expect(document.body.textContent).toContain('2 transactions of at most'));
    // The fees of both, not of the first only (audit port-2 #1): the first as made (1000 sat), the second at its rate.
    const second = BigInt(Math.ceil((totalsOf(draft.list.slice(PART_SIZE), 'regtest').vsize * Math.max(1000 * 1000 / (31 * PART_SIZE + 110), 2000)) / 1000));
    const fees = 1000n + second;
    const shown = (sats: bigint) => (Number(sats) / 1e8).toFixed(8);
    expect(document.body.textContent).toContain(`Transaction fees of the 2 transactions`);
    expect(document.body.textContent).toContain(`about ${shown(fees)} CHN`);
    expect(document.body.textContent).toContain(`Total Amount, about: ${shown(BigInt(PART_SIZE + 2) * 100_000n + fees)} CHN`);
    await answer('send', 5000);
    // The second costs more than shown (2000 sat): it asks before it is paid.
    await waitFor(() => expect(document.body.textContent).toContain('Transaction 2 of 2 costs more than shown: 0.00002000 CHN'));
    await answer('go', 5000);
    // The first is paid; the second fails: an error, and its recipients stay in the list.
    await waitFor(() => expect(screen.getByText(/were paid, in 1 transactions; the others were not: Insufficient funds/)).toBeTruthy());
    expect(called('wallet.send.prepare').map((c) => ((c.params as { recipients: unknown[] }).recipients).length)).toEqual([PART_SIZE, 2]);
    await answer('ok');
    await waitFor(() => expect(draft.list.length).toBe(2));
  }, 20000);

  it('Batch pay: a part that would cost more than shown is not paid when the user stops; coins chosen pay one transaction only', async () => {
    fileText = ['address;amount', ...Array.from({ length: PART_SIZE + 2 }, (_, i) => `${addr(i)};0,001`)].join('\n');
    go('batchpay', 'import');
    render(BatchPay);
    render(DialogHost);
    await waitFor(() => expect(draft.list.length).toBe(PART_SIZE + 2));
    await waitFor(() => expect(draft.list.every((r) => !r.problem)).toBe(true));
    await fireEvent.click(document.querySelector('#bp-pay')!);
    await answer('send', 5000);
    await waitFor(() => expect(document.body.textContent).toContain('Transaction 2 of 2 costs more than shown'));
    await answer('stop');
    await waitFor(() => expect(draft.list.length).toBe(2));
    expect(called('wallet.send.commit').map((c) => (c.params as { token: string }).token)).toEqual(['t1']);
    expect(called('wallet.send.discard').map((c) => (c.params as { token: string }).token)).toContain('t2');
  }, 30000);

  it('Batch pay: coins chosen for a list of one transaction are not taken for a list that grew to several (audit port-2 #1)', async () => {
    prefs.coinControl = true;
    render(BatchPay);
    render(DialogHost);
    await waitFor(() => expect(called('wallet.fee').length).toBeGreaterThan(0));
    await fireEvent.click(screen.getByRole('button', { name: /Paste/ }));
    await fireEvent.input(document.querySelector('#bp-paste')!, { target: { value: `${A},1\n${B},2` } });
    await fireEvent.submit(document.querySelector('#bp-paste-form')!);
    await waitFor(() => expect(draft.list.filter((r) => !r.problem).length).toBe(2));
    const coin = await screen.findByRole('checkbox', { name: 'Spend this coin' });
    await fireEvent.click(coin);
    await waitFor(() => expect(called('wallet.coinControl.summary').length).toBeGreaterThan(0));
    // The list grows past one transaction: the panel steps aside, and paying refuses the coins chosen.
    await fireEvent.click(screen.getByRole('button', { name: /Paste/ }));
    await fireEvent.input(document.querySelector('#bp-paste')!, { target: { value: Array.from({ length: PART_SIZE + 10 }, (_, i) => `${addr(i)},0.001`).join('\n') } });
    await fireEvent.submit(document.querySelector('#bp-paste-form')!);
    await waitFor(() => expect(draft.list.filter((r) => !r.problem).length).toBeGreaterThan(PART_SIZE));
    expect(screen.getByText(/The list takes 2 transactions: the wallet chooses their coins/)).toBeTruthy();
    calls.length = 0;
    await fireEvent.click(document.querySelector('#bp-pay')!);
    // (Some of the pretend addresses repeat A and B: the rows to look at are left out.)
    await answer('go');
    await waitFor(() => expect(document.body.textContent).toContain('The coins chosen in "Choose coins" pay one transaction'));
    expect(called('wallet.send.prepare').length).toBe(0);
    await answer('ok');
  }, 30000);

  it('the fees of the parts, the width of amounts, files that are not text, labels read back', () => {
    const part = (n: number) => Array.from({ length: n }, (_, i) => newRecipient({ address: addr(i), amount: 100_000n }));
    const parts = [part(1500), part(1500), part(10)];
    const est = partFees(parts, 'regtest', { fee: 46_612n, vsize: 46_612 }, 1000);
    // At the first's rate (1 sat/vB): each other from its size.
    expect(est.fees[0]).toBe(46_612n);
    expect(est.fees[1]).toBe(BigInt(totalsOf(parts[1], 'regtest').vsize));
    expect(est.total).toBe(est.fees.reduce((a, b) => a + b, 0n));
    // A higher rate chosen wins over the first's.
    expect(partFees(parts, 'regtest', { fee: 1000n, vsize: 1000 }, 5000).fees[2]).toBe(BigInt(Math.ceil(totalsOf(parts[2], 'regtest').vsize * 5)));
    expect([feeOverEstimate(1200n, 1000n), feeOverEstimate(2201n, 1000n), feeOverEstimate(100_000n, 80_000n)]).toEqual([false, true, true]);
    // The Amount column fits its longest amount and its unit: 0.00100000 CHN whole.
    expect(amountColumnRem([newRecipient({ amount: 100_000n })], 'CHN')).toBeGreaterThanOrEqual(('0.00100000 CHN'.length * 0.62) + 1.5);
    expect(amountColumnRem([newRecipient({ amount: 2_100_000_000_000_000n })], 'CHN')).toBeGreaterThan(14);
    expect(amountColumnRem([], 'sat')).toBe(7.5);
    // A binary file is not a list of payments; text in UTF-8 or Windows-1252 is.
    expect(textOfFile(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x14]))).toBeNull();
    expect(textOfFile(new Uint8Array(Array.from({ length: 400 }, (_, i) => (i * 37) % 32 === 0 ? 1 : 0x41 + (i % 26))))).toBeNull();
    expect(textOfFile(new TextEncoder().encode(`${A},1,Zoë\n`))).toBe(`${A},1,Zoë\n`);
    expect(textOfFile(new Uint8Array([0x61, 0x2c, 0x31, 0x2c, 0x5a, 0x6f, 0xeb]))).toBe('a,1,Zoë');
    // A label exported with a ' before a formula reads back as it was; the file never holds the formula bare.
    const list = [newRecipient({ address: A, amount: 100_000n, label: "=cmd|' /C calc'!A0" })];
    const csv = recipientsCsv(list, 'CHN');
    expect(csv).toContain(`"'=cmd|' /C calc'!A0"`);
    expect(parseRecipients(csv, 'CHN', 'CHN').recipients[0].label).toBe("=cmd|' /C calc'!A0");
    // No constant of the standard weight of a transaction the node does not have (audit port-2 #15).
    expect(readFileSync(join(__dirname, 'th/model.ts'), 'utf8')).not.toContain('392_000');
  });

  it('Payments: a batch is one row; opened, its recipients; paid again into Batch pay, the fee taken out', async () => {
    render(Payments);
    await waitFor(() => expect(screen.getByRole('grid', { name: 'Payments of the wallet' })).toBeTruthy());
    const grid = screen.getByRole('grid', { name: 'Payments of the wallet' });
    await waitFor(() => expect(within(grid).getAllByRole('row').length).toBe(4));
    expect(within(grid).getByText(/Batch/)).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Totals of the payments shown' }).textContent).toContain('9.00000000');
    await fireEvent.click(screen.getByRole('tab', { name: 'Batches' }));
    await waitFor(() => expect(within(grid).getAllByRole('row').length).toBe(2));
    await fireEvent.click(within(grid).getAllByRole('row')[1]);
    const recipients = await screen.findByRole('grid', { name: 'Recipients of the batch' });
    expect(within(recipients).getAllByRole('row').length).toBe(4);
    await fireEvent.click(screen.getByRole('button', { name: /Pay again/ }));
    await waitFor(() => expect(nav.page).toBe('batchpay'));
    expect(draft.list.map((r) => [r.address, r.amount])).toEqual([
      [A, 100_000_000n],
      [B, 200_000_000n],
      [C, 300_000_000n],
    ]);
  });

  it('Throughput: the blocks of the window, the capacity; the mempool and the fee estimates', async () => {
    render(Throughput);
    await waitFor(() => expect(th.blocks.length).toBe(20));
    expect(called('getblockstats').length).toBe(20);
    const tiles = screen.getByRole('region', { name: 'Throughput of the latest blocks' });
    expect(tiles.textContent).toContain('63%');
    expect(screen.getByRole('img', { name: 'Transactions and fill of each block' })).toBeTruthy();
    expect(within(screen.getByRole('grid', { name: 'The latest blocks' })).getAllByRole('row').length).toBeGreaterThan(5);
    // A new block: only it (and those near the tip) asked again.
    node.tip = { ...node.tip!, height: 21, hash: 'cd'.repeat(32) };
    await waitFor(() => expect(th.blocks.length).toBe(21));
    expect(called('getblockstats').length).toBeLessThanOrEqual(20 + 7);
    await fireEvent.click(screen.getByRole('tab', { name: 'Mempool' }));
    await waitFor(() => expect(screen.getByRole('region', { name: 'The mempool' }).textContent).toContain('120'));
    expect(screen.getByText('2.00 sat/vB')).toBeTruthy();
    expect(screen.getByText('123 456')).toBeTruthy();
    expect(called('getchaintxstats')[0].params).toEqual([19]);
  });

  it('the cards of the home: throughput, payments today', async () => {
    render(LocalCards);
    await waitFor(() => expect(th.blocks.length).toBe(20));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Payments today' })).toBeTruthy());
    expect(screen.getByRole('heading', { name: 'Throughput' })).toBeTruthy();
    await waitFor(() => expect(document.body.textContent).toContain('3 recipients'));
    await fireEvent.click(screen.getByRole('button', { name: /Batch pay/ }));
    expect(nav.page).toBe('batchpay');
  });
});

describe('the RPC methods of the pages of Thunder, against the policy the host ships', () => {
  const read = (p: string) => readFileSync(join(__dirname, p), 'utf8');
  it('are allowed: those of the kit, and the two of local.cpp, which only read', () => {
    const policy = read('../../../rpcpolicy.cpp');
    const local = read('../../../local.cpp');
    const allowed = new Set([...policy.matchAll(/\{"([a-z0-9_]+)", (?:WORKER|LONG)\}/g), ...local.matchAll(/\{"([a-z0-9_]+)", Bridge::Thread::(?:WORKER|LONG)\}/g)].map((m) => m[1]));
    const sources = ['th/store.svelte.ts', 'pages/BatchPay.svelte', 'pages/Payments.svelte', 'pages/Throughput.svelte', 'LocalCards.svelte'].map(read).join('\n');
    const used = [...sources.matchAll(/rpc\.raw[^(]*\(\s*'([a-z0-9_]+)'/g)].map((m) => m[1]);
    expect(new Set(used)).toEqual(new Set(['getblockstats', 'getmempoolinfo', 'estimatesmartfee', 'getchaintxstats']));
    for (const m of used) expect(allowed.has(m)).toBe(true);
    expect([...local.matchAll(/\{"([a-z0-9_]+)", Bridge::Thread::WORKER\}/g)].map((m) => m[1])).toEqual(['estimatesmartfee', 'getchaintxstats']);
    // Nothing that spends: the pages pay through the wallet functions of the kit, confirmed in the page.
    expect(local.slice(local.indexOf('KeyedRpcMethods()')).match(/return \{\};/)).not.toBeNull();
  });
});
