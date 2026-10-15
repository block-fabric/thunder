// Icons of this chain's own pages, beside those of the kit (components/Icon.svelte): line icons on a
// 24 grid with a 1.75 stroke, one SVG path each. The pages of Thunder name them in chain/local.ts.
export const LOCAL_ICONS = {
  /** Batch pay: one payment fanning out to several. */
  batch: 'M3 12h6M9 12l4-6h7M9 12h11M9 12l4 6h7M17 3l3 3-3 3M17 9l3 3-3 3M17 15l3 3-3 3',
  /** Payments: a ledger of rows, one marked. */
  ledger: 'M5 4h14v16H5zM8 8h8M8 12h8M8 16h5M16 15.5l1.5 1.5L20 14',
  /** Throughput: a gauge with its needle. */
  gauge: 'M4.5 17a8 8 0 1 1 15 0M12 13l4-4.5M12 13h.01M7 17h10',
  /** A bolt: the mark of Thunder, for its cards. */
  bolt: 'M13 2.5L5 13.5h6l-1.5 8 8-11h-6z',
} as const satisfies Record<string, string>;
