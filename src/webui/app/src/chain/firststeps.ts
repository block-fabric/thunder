// The three first steps of Thunder, shown on Home in Simple mode until dismissed
// (components/FirstRunTips.svelte; lib/firststeps.ts). English here: the card translates them.
import type { FirstStep } from '../lib/firststeps';

export const FIRST_STEPS: readonly FirstStep[] = [
  { title: 'Bring coins here', text: 'Coins come from Chains. Drivechains gives a deposit address: paste it in the Chains app (Sidechains, Move coins). They arrive here a block or two later.', icon: 'down', action: { label: 'Get a deposit address', page: 'peg', tab: 'deposit' } },
  { title: 'Pay fast and cheap', text: 'Thunder has large blocks, so payments here are confirmed quickly, for a tiny fee. Send pays any Thunder address; Payments lists them day by day.', icon: 'send', action: { label: 'Send', page: 'send', panel: 'send' } },
  { title: 'Take coins back', text: 'When you are done, Drivechains sends coins back to Chains. That takes longer: the miners of Chains approve withdrawals together.', icon: 'up', action: { label: 'Send coins back', page: 'peg', tab: 'withdraw' } },
];
