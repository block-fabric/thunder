// What the pages of Thunder work out, apart from the components so that it can be tested on its own:
// the recipients of a batch payment read from a paste or a CSV file, checked, totalled and cut into
// transactions; the history of the wallet as payments (a batch as one); the throughput of the chain from
// the statistics of its blocks.
import { CHAIN } from '../config';
import { checkAddress, addressTypeOf, networkParams, bech32Decode, base58Decode, NETWORKS } from '../../lib/address';
import { formatAmount, parseAmount, unitInfo, UNITS, type Unit } from '../../lib/units';
import { compareRecords, csvCell, isoLocal, toCsv, type TxRecord } from '../../lib/wallet';

// --- The chain ---

/** The weight a block of Thunder may have (consensus.max_block_weight on every network, chain.json blockWeight): 32 million. */
export const MAX_BLOCK_WEIGHT = CHAIN.blockWeight ?? 32_000_000;
/** The recipients of one transaction of a batch: their outputs and the inputs that pay them stay well below a standard transaction. */
export const PART_SIZE = 1500;
/**
 * The transactions of a batch sent one after the other before the rest waits for a block (audit 7 E-TH3).
 * A wallet with few confirmed coins pays each with the change of the one before: the node takes a chain of
 * them up to its cluster limit (Thunder: 2,000 kvB, 24 transactions of 1,500 P2TR outputs at 64.6 kvB) and
 * the wallet builds one of at most 24 (-limitancestorcount); 20 stays under both.
 */
export const CHAINED_PARTS = 20;
/** The most recipients a list takes (the table draws only the rows in view; the transactions are sent one after the other). */
export const MAX_RECIPIENTS = 50_000;
/** The largest file of recipients read (about 50 000 lines). */
export const MAX_CSV_BYTES = 5_000_000;
/** The weight of a payment of one input and two outputs to keys of the witness (141 vbytes): what a block holds of them. */
export const TYPICAL_TX_WEIGHT = 564;

// --- Recipients ---

/** A recipient of a batch, as the list keeps it. */
export interface Recipient {
  id: number;
  address: string;
  /** Satoshis; null when what was given is not an amount (the text stays in amountText). */
  amount: bigint | null;
  amountText: string;
  label: string;
  /** The line of the paste or the file it came from (1 for the first), 0 when typed. */
  line: number;
  /** What keeps it from being paid ('' when nothing): the words of the app, translated where shown. */
  problem: string;
  /** What deserves a look but does not stop it (an address given twice is a problem; the same amount ten times is not). */
  note: string;
  /** In an unsigned transaction (PSBT) made before (audit 7 E-TH7): paying it again may pay it twice. */
  inPsbt?: boolean;
}

let nextRecipient = 1;
export function newRecipient(fields: Partial<Omit<Recipient, 'id'>> = {}): Recipient {
  return { id: nextRecipient++, address: '', amount: null, amountText: '', label: '', line: 0, problem: '', note: '', ...fields };
}

/** The fields of a line of CSV (RFC 4180: quotes around a field, "" for a quote in it), split at the separator. */
export function splitCsvLine(line: string, sep: string): string[] {
  const out: string[] = [];
  let field = '';
  let quoted = false;
  let wasQuoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field.trim() === '') {
      quoted = true;
      wasQuoted = true;
      field = '';
    } else if (c === sep) {
      out.push(wasQuoted ? field : field.trim());
      field = '';
      wasQuoted = false;
    } else field += c;
  }
  out.push(wasQuoted ? field : field.trim());
  return out;
}

/** The separator of a list: a tab, a semicolon, a comma, or spaces; told from its first lines. */
export function detectSeparator(lines: readonly string[]): string {
  const sample = lines.slice(0, 20);
  for (const sep of ['\t', ';', ',']) if (sample.some((l) => l.includes(sep)) && sample.every((l) => !l.trim() || l.includes(sep))) return sep;
  for (const sep of ['\t', ';', ',']) if (sample.some((l) => l.includes(sep))) return sep;
  return ' ';
}

const HEADER_WORDS = {
  address: /^(address|recipient|to|pay ?to|destination|addr)$/i,
  amount: /^(amount|value|sum|coins|chn|sats?|satoshis?|btc)(\s*[([][^)\]]*[)\]])?$/i,
  label: /^(label|name|memo|note|description|comment|reference|ref)$/i,
};

/**
 * The unit a header names for the amounts (audit 7 E-TH4): "Amount (mCHN)" as this app exports, or a column
 * named by its unit ("sats", "CHN"). null when it names none; '?' when it names one this app does not know.
 */
export function unitOfHeader(field: string): Unit | '?' | null {
  const f = field.trim();
  const inside = /[([]\s*([^)\]]*?)\s*[)\]]$/.exec(f);
  const word = inside ? inside[1] : /^(sats?|satoshis?)$/i.test(f) ? 'sat' : /^chn$/i.test(f) ? 'CHN' : '';
  if (!word) return null;
  const w = word.toLowerCase();
  if (w === 'sats' || w === 'satoshi' || w === 'satoshis') return 'sat';
  const found = UNITS.find((u) => u.id.toLowerCase() === w || u.short.toLowerCase() === w);
  return found ? found.id : '?';
}

/**
 * An amount whose comma may separate thousands as well as decimals (audit 7 E-TH6): "1,000" is a thousand
 * to some and one to others, "12,500" twelve thousand five hundred or twelve and a half. Such an amount is
 * not read: it is to be written again without the comma, or with a decimal point. ("1,5" and "0,001" are
 * not ambiguous: a group of thousands has three digits, and none starts with 0.)
 */
export function ambiguousComma(text: string): boolean {
  return /^[1-9]\d{0,2}(,\d{3})+$/.test(text.trim().replace(/[\s  _]/g, ''));
}

export interface ParsedList {
  recipients: Recipient[];
  /** Lines that were not a recipient (the header is not one of them), with why. */
  skipped: { line: number; text: string; why: string }[];
  header: boolean;
  separator: string;
  /** The list was longer than MAX_RECIPIENTS: the rest was left out. */
  truncated: boolean;
  /** The unit the amounts were read in: the one the header names, else the one asked for. */
  unit: Unit;
  /** The unit the header names: null when it names none (the amounts were read in the unit asked for), '?' when not one of this app. */
  headerUnit: Unit | '?' | null;
}

/** Strip the unit after an amount ("1.5 CHN", "200 sat") when it is the unit the amounts are read in. */
function amountOnly(text: string, unit: Unit, short: string): string {
  const t = text.trim();
  const m = /^(.*?)[\s ]*([A-Za-z]+)$/.exec(t);
  if (!m) return t;
  if (m[2].toLowerCase() === short.toLowerCase() || m[2].toLowerCase() === unit.toLowerCase()) return m[1];
  return t;
}

/**
 * The text of a file of recipients, or null when it is not text (audit port-2 #12: a binary file was read as
 * hundreds of garbage recipients). A NUL byte, or more than 1 in 100 characters that are controls other than
 * tabs and line ends, is not text; UTF-8 first, else Windows-1252 (a spreadsheet's export on Windows).
 */
export function textOfFile(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    text = new TextDecoder('windows-1252').decode(bytes);
  }
  let controls = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if ((c < 32 && c !== 9 && c !== 10 && c !== 13) || c === 127 || (c >= 0x80 && c < 0xa0)) controls++;
  }
  return controls > text.length / 100 ? null : text;
}

/**
 * Recipients from text: one a line, the address, the amount and an optional label, separated by a comma,
 * a semicolon, a tab or spaces; a header line naming the columns is read for their order and left out.
 * Amounts are read in `unit`. Nothing is checked against the chain yet (checkRecipients).
 */
export function parseRecipients(text: string, askedUnit: Unit, askedShort: string, firstLine = 1): ParsedList {
  let unit = askedUnit;
  let unitShort = askedShort;
  let headerUnit: Unit | '?' | null = null;
  const lines = text.replace(/^﻿/, '').split(/\r\n|\n|\r/);
  const separator = detectSeparator(lines.filter((l) => l.trim() && !l.trim().startsWith('#')));
  const split = (l: string) => (separator === ' ' ? l.trim().split(/\s+/) : splitCsvLine(l, separator));
  let order = { address: 0, amount: 1, label: 2 };
  let header = false;
  const recipients: Recipient[] = [];
  const skipped: ParsedList['skipped'] = [];
  let truncated = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const lineNo = firstLine + i;
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const fields = split(raw);
    if (!header && recipients.length === 0 && skipped.length === 0) {
      const named = fields.map((f) => f.trim());
      const at = (re: RegExp) => named.findIndex((f) => re.test(f));
      const a = at(HEADER_WORDS.address);
      const m = at(HEADER_WORDS.amount);
      if (a >= 0 || m >= 0) {
        header = true;
        const l = at(HEADER_WORDS.label);
        order = { address: a >= 0 ? a : 0, amount: m >= 0 ? m : a === 1 ? 0 : 1, label: l >= 0 ? l : -1 };
        // The unit the header names is the unit of the amounts, whatever unit was asked for.
        headerUnit = m >= 0 ? unitOfHeader(named[m]) : null;
        if (headerUnit && headerUnit !== '?') {
          unit = headerUnit;
          unitShort = unitInfo(unit).short;
        }
        continue;
      }
    }
    if (recipients.length >= MAX_RECIPIENTS) {
      truncated = true;
      break;
    }
    const address = (fields[order.address] ?? '').trim();
    const amountText = amountOnly(fields[order.amount] ?? '', unit, unitShort);
    let label = order.label >= 0 ? (fields[order.label] ?? '') : '';
    // Without a header, the words after the amount are the label (spaces in it too).
    if (!header && separator === ' ' && fields.length > 3) label = fields.slice(2).join(' ');
    // A label this app exported with a ' before a formula (toCsv) reads back as it was.
    label = csvCell(label.trim()).slice(0, 256);
    if (!address && !amountText) {
      skipped.push({ line: lineNo, text: raw.slice(0, 120), why: 'No address and no amount' });
      continue;
    }
    // Amounts in a unit this app does not know, or with a comma that may separate thousands, are not read.
    const parsed = headerUnit === '?' || ambiguousComma(amountText) ? null : parseAmount(amountText, unit);
    recipients.push(newRecipient({ address, amountText, amount: parsed?.ok ? parsed.sats : null, label, line: lineNo }));
  }
  return { recipients, skipped, header, separator, truncated, unit, headerUnit };
}

/**
 * The least an output to an address may pay (GetDustThreshold, at the dust relay fee of 3000 sat/kvB): the
 * output and the input that would spend it. The node checks again when the transaction is made.
 */
export function dustThreshold(address: string, network: string): bigint {
  const type = addressTypeOf(address, network);
  if (type === 'legacy') return 546n;
  if (type === 'p2sh-segwit') return 540n;
  if (type === 'bech32') {
    const d = bech32Decode(address);
    // 22 bytes of script for a key, 34 for a script.
    return d && d.data.length > 33 ? 330n : 294n;
  }
  // Taproot and other witness versions: 43 bytes of output.
  return 330n;
}

/** The size in bytes of an output to an address (its amount, its script). */
export function outputSize(address: string, network: string): number {
  const params = networkParams(network);
  if (address.toLowerCase().startsWith(params.hrp + '1')) {
    const d = bech32Decode(address);
    // The data is 5-bit groups: version, then the program.
    const program = d ? Math.floor(((d.data.length - 1) * 5) / 8) : 20;
    return 8 + 1 + 2 + program;
  }
  const bytes = base58Decode(address);
  if (bytes && bytes[0] === params.script) return 32;
  return 34;
}

/** What tells two addresses apart: a bech32 address is the same in capitals. */
export function addressKey(address: string): string {
  const text = address.trim();
  const lower = text.toLowerCase();
  return Object.values(NETWORKS).some((p) => lower.startsWith(p.hrp + '1')) ? lower : text;
}

/**
 * Check every recipient: the address is one of this chain and network, the amount is more than nothing and
 * no dust, an address comes once (the wallet takes each once in a transaction). Sets `problem` and `note`
 * of each and returns a new list; the node checks again when the transaction is made.
 */
export async function checkRecipients(list: readonly Recipient[], network: string): Promise<Recipient[]> {
  const seen = new Map<string, number>();
  for (const r of list) {
    const key = addressKey(r.address);
    if (key) seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const cache = new Map<string, string>();
  const out: Recipient[] = [];
  for (const r of list) {
    // A long list gives the page a frame every 1000 rows (audit port-2 #12: a stall of 0.9 s at 50 000).
    if (out.length % 1000 === 999) await new Promise((done) => setTimeout(done, 0));
    const address = r.address.trim();
    let problem = '';
    let note = '';
    if (!address) problem = 'No address';
    else {
      let why = cache.get(address);
      if (why === undefined) {
        const c = await checkAddress(address, network);
        why = c.valid ? '' : c.error;
        cache.set(address, why);
      }
      problem = why;
    }
    if (!problem) {
      if (r.amount === null && ambiguousComma(r.amountText)) problem = 'A comma here may separate thousands: write the amount without it, or with a decimal point';
      else if (r.amount === null) problem = r.amountText.trim() ? 'Not an amount' : 'No amount';
      else if (r.amount <= 0n) problem = 'The amount to pay must be larger than 0.';
      else if (r.amount < dustThreshold(address, network)) problem = 'Too small to send: the output would be dust';
    }
    if (!problem && (seen.get(addressKey(address)) ?? 0) > 1) problem = 'This address is in the list more than once';
    if (!problem && r.amount !== null && r.amount >= 100n * 100_000_000n) note = 'A large amount';
    // Base58 addresses have the prefixes of the Chains mainchain (audit 7 E-TH8): such an address of the
    // mainchain is valid here too, and is paid on Thunder.
    if (!problem && !note) {
      const type = addressTypeOf(address, network);
      if (type === 'legacy' || type === 'p2sh-segwit') note = 'An old-style address: the same address is valid on the mainchain. Check it is meant for Thunder';
    }
    if (!problem && r.inPsbt) note = 'In an unsigned transaction (PSBT) made before: if it was sent, this pays again';
    if (problem === r.problem && note === r.note && address === r.address) out.push(r);
    else out.push({ ...r, address, problem, note });
  }
  return out;
}

/** The recipients paying the same address made into one each, with the sum of their amounts and their labels joined. */
export function mergeDuplicates(list: readonly Recipient[]): { list: Recipient[]; merged: number } {
  const by = new Map<string, Recipient>();
  const out: Recipient[] = [];
  let merged = 0;
  for (const r of list) {
    const key = addressKey(r.address);
    const first = key ? by.get(key) : undefined;
    if (!first || r.amount === null || first.amount === null) {
      const copy = { ...r };
      if (key) by.set(key, copy);
      out.push(copy);
      continue;
    }
    first.amount += r.amount;
    first.amountText = '';
    if (r.label && !first.label.split(' + ').includes(r.label)) first.label = first.label ? `${first.label} + ${r.label}`.slice(0, 256) : r.label;
    merged++;
  }
  return { list: out, merged };
}

export interface ListTotals {
  count: number;
  ready: number;
  problems: number;
  amount: bigint;
  /** The transactions the recipients that are ready take (PART_SIZE each). */
  parts: number;
  /** About the size of those transactions (vbytes), before the wallet chooses the coins: the outputs, a change, an input per 100 recipients. */
  vsize: number;
  /** The share of a block they would take. */
  blockShare: number;
}

export function totalsOf(list: readonly Recipient[], network: string): ListTotals {
  let amount = 0n;
  let ready = 0;
  let outputs = 0;
  for (const r of list) {
    if (r.problem || r.amount === null) continue;
    ready++;
    amount += r.amount;
    outputs += outputSize(r.address, network);
  }
  const parts = Math.ceil(ready / PART_SIZE);
  // Per transaction: its frame (10.5 vbytes), a change of 31 and the inputs (68 each, one per hundred recipients at least).
  const vsize = ready ? Math.ceil(outputs + parts * (11 + 31) + Math.max(parts, Math.ceil(ready / 100)) * 68) : 0;
  return { count: list.length, ready, problems: list.length - ready, amount, parts, vsize, blockShare: (vsize * 4) / MAX_BLOCK_WEIGHT };
}

/**
 * The fees of a batch paid in several transactions, for its confirmation (audit port-2 #1): the first as the
 * wallet made it, each other one from its size (totalsOf) at the rate of the first (or the rate chosen, if
 * higher). `total` is what the confirmation shows; each part is held to its estimate (feeOverEstimate).
 */
export function partFees(parts: readonly (readonly Recipient[])[], network: string, first: { fee: bigint; vsize: number }, feePerK: number): { fees: bigint[]; total: bigint; vsize: number } {
  const firstRate = first.vsize > 0 ? Number(first.fee) * 1000 / first.vsize : 0;
  const rate = Math.max(firstRate, feePerK);
  const fees: bigint[] = [first.fee];
  let vsize = first.vsize;
  for (let k = 1; k < parts.length; k++) {
    const size = totalsOf(parts[k], network).vsize;
    vsize += size;
    fees.push(BigInt(Math.ceil((size * rate) / 1000)));
  }
  return { fees, total: fees.reduce((a, b) => a + b, 0n), vsize };
}

/** A part of a batch whose fee, as the wallet made it, is more than its estimate allows: a fifth above it and 1000 sat. */
export function feeOverEstimate(actual: bigint, estimate: bigint): boolean {
  return actual > estimate + estimate / 5n + 1000n;
}

/**
 * The width (rem) the Amount column of a list needs so that no amount is cut: its longest amount in the
 * unit shown, with the unit (a digit is about 0.62 rem in the table, and 1.5 rem of padding), at least 7.5.
 */
export function amountColumnRem(list: readonly Recipient[], unit: Unit): number {
  let longest = 0;
  for (const r of list) {
    const n = r.amount === null ? Math.min(r.amountText.length, 24) : formatAmount(r.amount, unit).length;
    if (n > longest) longest = n;
  }
  const chars = longest + 1 + unitInfo(unit).short.length;
  return Math.max(7.5, Math.ceil((chars * 0.62 + 1.6) * 10) / 10);
}

/** The recipients that are ready, cut into the transactions that pay them. */
export function partsOf<T>(ready: readonly T[], size = PART_SIZE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < ready.length; i += size) out.push(ready.slice(i, i + size));
  return out;
}

/** A list as CSV (address, amount in the unit, label), to read back with parseRecipients: the header names the unit (audit 7 E-TH4). */
export function recipientsCsv(list: readonly Recipient[], unit: Unit): string {
  return toCsv(
    ['Address', `Amount (${unitInfo(unit).short})`, 'Label'],
    list.map((r) => [r.address, r.amount === null ? r.amountText : formatAmount(r.amount, unit, { separators: false }), r.label]),
  );
}

// --- Payments ---

export type PaymentKind = 'in' | 'out' | 'batch' | 'mined' | 'other';

/** A payment: the records of the wallet of one transaction, as one row (a batch of 500 recipients is one). */
export interface Payment {
  key: string;
  txid: string;
  time: number;
  kind: PaymentKind;
  /** Recipients (sent) or outputs to the wallet (received). */
  count: number;
  /** What it did to the balance (the fee in it for a send). */
  amount: bigint;
  /** The label or the address of the counterpart; for a batch, the first of them. */
  who: string;
  address: string;
  label: string;
  status: TxRecord['status'];
  depth: number;
  maturesIn: number;
  blockHeight: number;
  /** The records, for the recipients of a batch. */
  records: TxRecord[];
  sortKey: string;
}

/** The history as payments, newest first. Records of a transaction become one payment; one that pays several others is a batch. */
export function paymentsOf(records: readonly TxRecord[]): Payment[] {
  const byTx = new Map<string, TxRecord[]>();
  for (const r of records) {
    const list = byTx.get(r.txid);
    if (list) list.push(r);
    else byTx.set(r.txid, [r]);
  }
  const out: Payment[] = [];
  for (const [txid, list] of byTx) {
    list.sort((a, b) => a.idx - b.idx);
    const sends = list.filter((r) => r.type === 'send' || r.type === 'sendOther');
    const recvs = list.filter((r) => r.type === 'recv' || r.type === 'recvOther');
    const kind: PaymentKind = list.some((r) => r.type === 'mined') ? 'mined' : sends.length > 1 ? 'batch' : sends.length === 1 ? 'out' : recvs.length ? 'in' : 'other';
    const first = (kind === 'out' || kind === 'batch' ? sends[0] : recvs[0]) ?? list[0];
    const amount = list.reduce((n, r) => n + r.amount, 0n);
    const newest = list.reduce((a, b) => (compareRecords(a, b) >= 0 ? a : b));
    out.push({
      key: txid,
      txid,
      time: newest.time,
      kind,
      count: kind === 'out' || kind === 'batch' ? sends.length : recvs.length || list.length,
      amount,
      who: first.label || first.address,
      address: first.address,
      label: first.label,
      status: first.status,
      depth: first.depth,
      maturesIn: first.maturesIn,
      blockHeight: first.blockHeight,
      records: list,
      sortKey: newest.sortKey,
    });
  }
  return out.sort((a, b) => compareRecords(b, a));
}

/** The start of the local day of a time (seconds). */
export function dayOf(secs: number): number {
  const d = new Date(secs * 1000);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

export interface Day {
  day: number;
  in: bigint;
  out: bigint;
  countIn: number;
  countOut: number;
}

/** What came in and went out each day of the last `days` days, the oldest first (days without payments too). */
export function dailyTotals(payments: readonly Payment[], days: number, now: number): Day[] {
  const today = dayOf(now);
  const out: Day[] = [];
  const index = new Map<number, Day>();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today * 1000);
    d.setDate(d.getDate() - i);
    const day: Day = { day: Math.floor(d.getTime() / 1000), in: 0n, out: 0n, countIn: 0, countOut: 0 };
    out.push(day);
    index.set(day.day, day);
  }
  for (const p of payments) {
    const day = index.get(dayOf(p.time));
    if (!day) continue;
    if (p.amount >= 0n) {
      day.in += p.amount;
      day.countIn += p.count;
    } else {
      day.out += -p.amount;
      day.countOut += p.count;
    }
  }
  return out;
}

/** The payments as CSV: one line per payment, and with `recipients` one per recipient of the batches too. */
export function paymentsCsv(payments: readonly Payment[], unit: Unit, recipients: boolean): string {
  const rows: string[][] = [];
  for (const p of payments) {
    if (recipients && p.kind === 'batch') {
      for (const r of p.records) if (r.type === 'send' || r.type === 'sendOther') rows.push([isoLocal(p.time), p.kind, String(p.status), r.label, r.address, formatAmount(r.amount, unit, { separators: false }), p.txid]);
    } else rows.push([isoLocal(p.time), p.kind, String(p.status), p.label, p.address, formatAmount(p.amount, unit, { separators: false }), p.txid]);
  }
  return toCsv(['Date', 'Kind', 'Status', 'Label', 'Address', `Amount (${unit})`, 'ID'], rows);
}

// --- Throughput ---

/** The statistics of a block (getblockstats), as the pages use them. */
export interface BlockStat {
  height: number;
  hash: string;
  time: number;
  /** Transactions, the coinbase not counted. */
  txs: number;
  /** Weight of the transactions (the coinbase not counted, as getblockstats gives it). */
  weight: number;
  size: number;
  /** Fees, in satoshis. */
  fees: number;
  /** The median fee rate (sat/vB), and the 10th and 90th percentile. */
  feeRate: number;
  feeLow: number;
  feeHigh: number;
  ins: number;
  outs: number;
}

/** The fields asked of getblockstats. */
export const BLOCK_STATS = ['height', 'blockhash', 'time', 'txs', 'total_weight', 'total_size', 'totalfee', 'feerate_percentiles', 'ins', 'outs'] as const;

/** A BlockStat from what getblockstats answered. */
export function blockStatOf(raw: Record<string, unknown>): BlockStat {
  const num = (k: string) => (typeof raw[k] === 'number' ? (raw[k] as number) : 0);
  const pct = Array.isArray(raw.feerate_percentiles) ? (raw.feerate_percentiles as number[]) : [0, 0, 0, 0, 0];
  return {
    height: num('height'),
    hash: typeof raw.blockhash === 'string' ? raw.blockhash : '',
    time: num('time'),
    txs: Math.max(0, num('txs') - 1),
    weight: num('total_weight'),
    size: num('total_size'),
    fees: num('totalfee'),
    feeRate: pct[2] ?? 0,
    feeLow: pct[0] ?? 0,
    feeHigh: pct[4] ?? 0,
    ins: num('ins'),
    outs: num('outs'),
  };
}

export interface Throughput {
  blocks: number;
  txs: number;
  /** Seconds from the first block of the window to the last. */
  span: number;
  /** Transactions a second over the window; null with fewer than two blocks. */
  tps: number | null;
  avgTxs: number;
  maxTxs: number;
  /** Average and highest share of a block taken (0..1). */
  avgFill: number;
  maxFill: number;
  fees: number;
  /** Fees per transaction, in satoshis. */
  feePerTx: number;
  /** Median of the median fee rates of the blocks (sat/vB). */
  feeRate: number;
  /** Seconds between blocks, on average. */
  interval: number;
  outs: number;
}

/** The throughput over some blocks (any order). */
export function throughputOf(stats: readonly BlockStat[]): Throughput {
  const blocks = [...stats].sort((a, b) => a.height - b.height);
  const n = blocks.length;
  const txs = blocks.reduce((s, b) => s + b.txs, 0);
  const fees = blocks.reduce((s, b) => s + b.fees, 0);
  const span = n > 1 ? Math.max(1, blocks[n - 1].time - blocks[0].time) : 0;
  const fills = blocks.map((b) => b.weight / MAX_BLOCK_WEIGHT);
  const rates = blocks.filter((b) => b.txs > 0).map((b) => b.feeRate).sort((a, b) => a - b);
  return {
    blocks: n,
    txs,
    span,
    // The transactions of the first block were made before the window began.
    tps: n > 1 ? (txs - blocks[0].txs) / span : null,
    avgTxs: n ? txs / n : 0,
    maxTxs: n ? Math.max(...blocks.map((b) => b.txs)) : 0,
    avgFill: n ? fills.reduce((s, f) => s + f, 0) / n : 0,
    maxFill: n ? Math.max(...fills) : 0,
    fees,
    feePerTx: txs ? fees / txs : 0,
    feeRate: rates.length ? rates[Math.floor(rates.length / 2)] : 0,
    interval: n > 1 ? span / (n - 1) : 0,
    outs: blocks.reduce((s, b) => s + b.outs, 0),
  };
}

/** What a block holds of typical payments (one input, two outputs): the capacity of the chain. */
export function capacityOf(spacing: number): { perBlock: number; perSecond: number } {
  const perBlock = Math.floor(MAX_BLOCK_WEIGHT / TYPICAL_TX_WEIGHT);
  return { perBlock, perSecond: spacing > 0 ? perBlock / spacing : 0 };
}

/** The blocks it would take to mine what waits in the mempool (its weight, four times its virtual size), if nothing else came. */
export function blocksToClear(mempoolVsize: number): number {
  return Math.ceil((mempoolVsize * 4) / MAX_BLOCK_WEIGHT);
}

/** A share (0..1) as a percentage, with more digits for the small ones: a block of Thunder is seldom full. */
export function formatShare(share: number): string {
  if (!Number.isFinite(share) || share <= 0) return '0%';
  if (share < 0.0001) return '<0.01%';
  if (share < 0.01) return `${(share * 100).toFixed(2)}%`;
  if (share < 0.1) return `${(share * 100).toFixed(1)}%`;
  return `${Math.round(share * 100)}%`;
}

/** A rate of transactions, short: "0.42/s", "1 250/s". */
export function formatRate(perSecond: number | null): string {
  if (perSecond === null || !Number.isFinite(perSecond)) return '–';
  if (perSecond < 10) return perSecond.toFixed(2);
  return String(Math.round(perSecond)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}
