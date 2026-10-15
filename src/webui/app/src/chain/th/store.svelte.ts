// What the pages and cards of Thunder share: the statistics of the latest blocks (getblockstats, kept by
// height and asked again only for the blocks that are new, or near the tip where a reorganisation can
// change them), the mempool and the fee estimates, the counts of the whole chain (getchaintxstats); and
// the list of a batch payment being made, kept while the user goes to other pages.
import { rpc } from '../../lib/rpc';
import { node } from '../../lib/state.svelte';
import type { Unit } from '../../lib/units';
import { BLOCK_STATS, blockStatOf, type BlockStat, type Recipient } from './model';

export interface MempoolInfo {
  size: number;
  /** The virtual size of what waits (getmempoolinfo "bytes"). */
  bytes: number;
  usage: number;
  total_fee: number;
  mempoolminfee?: number;
}

export interface ChainTxStats {
  txcount: number;
  window_block_count: number;
  window_tx_count?: number;
  window_interval?: number;
  txrate?: number;
}

/** Fee estimates (sat/vB) to be mined within these blocks; null when the node cannot tell yet. */
export const ESTIMATE_TARGETS = [1, 6, 144] as const;

class Throughput {
  /** The statistics of the blocks asked for, by height, newest last. Raw: replaced as a whole. */
  blocks = $state.raw<BlockStat[]>([]);
  mempool = $state<MempoolInfo | null>(null);
  estimates = $state<Record<number, number | null>>({});
  chain = $state<ChainTxStats | null>(null);
  loading = $state(false);
  error = $state('');
  /** When the blocks were last brought up to date (ms). */
  updated = $state(0);
}

export const th = new Throughput();

const cache = new Map<number, BlockStat>();
/** The heights near the tip asked again with each new block: a reorganisation changes them. */
const REORG_DEPTH = 6;
const PARALLEL = 6;
let running: Promise<void> | null = null;
let again = 0;
let lastTip = -1;

async function fetchStats(height: number): Promise<BlockStat> {
  return blockStatOf(await rpc.raw<Record<string, unknown>>('getblockstats', [height, [...BLOCK_STATS]]));
}

async function bringUpToDate(count: number): Promise<void> {
  const tip = node.tip?.height ?? 0;
  if (tip < 1) {
    th.blocks = [];
    return;
  }
  // A new tip: the blocks near it are asked again (a reorganisation), and those above it forgotten.
  if (tip !== lastTip) {
    for (const h of [...cache.keys()]) if (h > tip - REORG_DEPTH) cache.delete(h);
    lastTip = tip;
  }
  const from = Math.max(1, tip - count + 1);
  const missing: number[] = [];
  for (let h = from; h <= tip; h++) if (!cache.has(h)) missing.push(h);
  for (let i = 0; i < missing.length; i += PARALLEL) {
    const got = await Promise.all(missing.slice(i, i + PARALLEL).map((h) => fetchStats(h)));
    for (const s of got) cache.set(s.height, s);
  }
  // Keep what a window of the page can show, and no more.
  for (const h of [...cache.keys()]) if (h < tip - 1000) cache.delete(h);
  const out: BlockStat[] = [];
  for (let h = from; h <= tip; h++) {
    const s = cache.get(h);
    if (s) out.push(s);
  }
  th.blocks = out;
  th.updated = Date.now();
}

/** The statistics of the latest `count` blocks, brought up to date (one run at a time; the largest count asked for wins). */
export function refreshBlocks(count: number): Promise<void> {
  again = Math.max(again, count);
  if (running) return running;
  const run = (async () => {
    th.loading = true;
    try {
      while (again > 0) {
        const n = again;
        again = 0;
        await bringUpToDate(n);
      }
      th.error = '';
    } catch (e) {
      th.error = e instanceof Error ? e.message : String(e);
    } finally {
      th.loading = false;
    }
  })();
  running = run.finally(() => {
    running = null;
  });
  return running;
}

/** The mempool and the fee estimates. */
export async function refreshMempool(): Promise<void> {
  try {
    th.mempool = await rpc.raw<MempoolInfo>('getmempoolinfo', []);
    const estimates: Record<number, number | null> = {};
    for (const target of ESTIMATE_TARGETS) {
      const r = await rpc.raw<{ feerate?: number; errors?: string[] }>('estimatesmartfee', [target]).catch(() => null);
      // CHN per kvB to satoshis per vbyte.
      estimates[target] = r && typeof r.feerate === 'number' ? (r.feerate * 1e8) / 1000 : null;
    }
    th.estimates = estimates;
  } catch {
    // The node is going away; the next refresh says so.
  }
}

/** The counts of the whole chain, over the window of blocks the page shows (getchaintxstats). */
export async function refreshChain(window: number): Promise<void> {
  const tip = node.tip?.height ?? 0;
  if (tip < 2) {
    th.chain = null;
    return;
  }
  try {
    th.chain = await rpc.raw<ChainTxStats>('getchaintxstats', [Math.min(window, tip - 1)]);
  } catch {
    th.chain = null;
  }
}

/** Forget everything (tests). */
export function resetThroughput(): void {
  cache.clear();
  lastTip = -1;
  again = 0;
  running = null;
  th.blocks = [];
  th.mempool = null;
  th.estimates = {};
  th.chain = null;
  th.error = '';
  th.loading = false;
  th.updated = 0;
}

/**
 * Keep the mempool up to date while something shows it: every `seconds`, when the window is shown (the
 * timers rest while it is hidden). Returns the function that stops it.
 */
export function watchMempool(seconds = 10): () => void {
  void refreshMempool();
  const timer = setInterval(() => {
    if (typeof document !== 'undefined' && document.hidden) return;
    void refreshMempool();
  }, seconds * 1000);
  return () => clearInterval(timer);
}

// --- The batch being made ---

class Draft {
  /** The recipients. Raw: a long list, replaced as a whole. */
  list = $state.raw<Recipient[]>([]);
  /** The unit the amounts of a paste or a file are read in ('' until chosen: the unit of the app). */
  unit = $state<Unit | ''>('');
  subtractFee = $state(false);
  /** Lines of the last paste or file that were not recipients. */
  skipped = $state.raw<{ line: number; text: string; why: string }[]>([]);
  /** Where the list came from, in words of the app (a file name is shown apart). */
  source = $state('');
  sourceFile = $state('');
}

export const draft = new Draft();

export function resetDraft(): void {
  draft.list = [];
  draft.unit = '';
  draft.subtractFee = false;
  draft.skipped = [];
  draft.source = '';
  draft.sourceFile = '';
}
