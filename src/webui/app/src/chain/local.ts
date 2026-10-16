// The pages of this chain of its own, beside those of the kit: the one file of the interface (with
// LocalPages.svelte, which shows them, and chain.json) that a chain made from the template changes, so
// that merges of the template stay clean. See doc/webui.md, "Pages of a chain of its own".
//
// Thunder, the chain of large blocks: batch payments (many recipients in one transaction, from a list, a
// paste or a CSV file), a history of payments made for many of them, and the throughput of the chain
// (transactions per block, how full the blocks are against 32 million weight units, fees, the mempool);
// their components in chain/pages and chain/th, the cards of the home in LocalCards.svelte, their icons in
// icons.ts, their RPC methods in src/webui/local.cpp.
import type { IconName } from '../components/Icon.svelte';

export interface LocalPage {
  /** Stable: the page id (go('names')), the command page.<id>. */
  id: string;
  title: string;
  icon: IconName;
  /** What the page is for, in a line (tooltips, the palette). */
  summary: string;
  /**
   * The section of the sidebars and the area of the workspace it goes in. What concerns the chain comes
   * before the tools, whatever the section (the chainBeforeTools tests).
   */
  section: 'wallet' | 'chain' | 'tools';
  /** The page needs a loaded wallet. */
  wallet?: boolean;
  shortcut?: string;
  /** More words to find it by in the palette. */
  keywords?: string;
  /** A quick action of the dashboard's home that opens it (after Send and Receive, with the chain's). */
  quick?: { label: string; icon?: IconName; tab?: string };
  /** Only in the navigation of Advanced mode (lib/uimode.svelte.ts): Simple mode reaches it by the palette and links. */
  advanced?: boolean;
}

export const LOCAL_PAGES = [
  { id: 'batchpay', title: 'Batch pay', icon: 'batch', section: 'chain', summary: 'Pay many recipients at once: typed, pasted or read from a CSV file, checked and previewed', wallet: true, keywords: 'batch bulk csv import payroll many recipients sendmany airdrop', quick: { label: 'Batch pay', icon: 'batch' } },
  { id: 'payments', title: 'Payments', icon: 'ledger', section: 'chain', summary: 'The payments of the wallet, made for many: batches as one, totals by day, export', wallet: true, keywords: 'history payments ledger batches export csv' },
  { id: 'throughput', title: 'Throughput', icon: 'gauge', section: 'chain', summary: 'Transactions per block and per second, how full the blocks are, fees and the mempool', keywords: 'tps capacity block fill fees mempool weight stats' },
] as const satisfies readonly LocalPage[];

export type LocalPageId = (typeof LOCAL_PAGES)[number]['id'];

/** Items of the menus (the Menus button and the palette) of this chain: in the group 'Chains' (before the tools). */
export interface LocalCommand {
  id: string;
  label: string;
  page: LocalPageId;
  tab?: string;
  tip?: string;
  keywords?: string;
}

export const LOCAL_COMMANDS = [
  { id: 'th.import', label: 'Import payments from a CSV file…', page: 'batchpay', tab: 'import', tip: 'Read the recipients of a batch payment from a CSV file', keywords: 'csv import batch' },
  { id: 'th.paste', label: 'Paste a list of payments…', page: 'batchpay', tab: 'paste', tip: 'Paste recipients and amounts, one a line', keywords: 'paste batch list' },
  { id: 'th.batches', label: 'Batch payments made', page: 'payments', tab: 'batches', tip: 'The transactions of the wallet that paid several recipients', keywords: 'batches history' },
  { id: 'th.mempool', label: 'Mempool and fees', page: 'throughput', tab: 'mempool', tip: 'What waits for a block, and the fees to get into one', keywords: 'mempool fees estimate' },
] as const satisfies readonly LocalCommand[];
