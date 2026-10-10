# Testing the sidechain template

What the tests of the template check, and how to run them. The template
carries Chains' drivechain code (it follows the mainchain with it). Those
tests are described in Chains' `doc/testing.md` and run here too. This page
describes what the sidechain adds:

- following the mainchain;
- blind merged mining;
- deposits and withdrawals on the sidechain side;
- the withdrawal peg;
- behaviour under network faults.

Each sidechain built on the template adds a section for its own rules.

## Running them

The functional tests need a Chains node: they use `chainsd` from
`../chains/build/bin`, which is where it is when the two repositories sit side
by side.

```
cmake -B build && cmake --build build -j4
build/bin/test_bitcoin --run_test=drivechain_tests
python3 build/test/functional/feature_sidechain.py
python3 build/test/functional/feature_sidechain_network.py
```

Fuzzing:

```
cmake -B build_fuzz -DBUILD_FOR_FUZZING=ON -DSANITIZERS=address,fuzzer,undefined \
      -DCMAKE_C_COMPILER=clang -DCMAKE_CXX_COMPILER=clang++
cmake --build build_fuzz -j4
FUZZ=sidechain_state build_fuzz/bin/fuzz
FUZZ=sidechain_scripts build_fuzz/bin/fuzz
```

## Unit tests (`src/test/drivechain_tests.cpp`)

Beyond the mainchain tests:

| Test | What it checks |
|---|---|
| `deposit_script` | Deposit outputs of the mainchain are read into payouts on the sidechain. |
| `withdrawal_to_treasury_refused` | A withdrawal paying into a treasury is no withdrawal (the mainchain would refuse its bundle). |
| `payout_queue` | A block pays at most `MAX_PAYOUTS_PER_BLOCK` outputs; the rest wait in order, and undo restores them. |
| `bundle_nonce` | A bundle names the block before the one that commits to it: its hash cannot be known ahead. |
| `paid_on_another_branch` | A bundle committed on another branch, then paid by the mainchain, removes the withdrawals it paid. |
| `paid_on_another_branch_oldest_first` | Of identical withdrawals, a payout from another branch removes the oldest. |
| `pending_bundle_holds_refunds_back_only_with_support` | The double payout: no refund while a bundle of another branch is pending on the mainchain with support; a new bundle can start. |
| `record_format` | A mainchain record keeps the bundles each block proposed and those pending after it; one an older release wrote is refused. |
| `duplicate_commitment_survives_reorg` | A block committed to twice keeps its first commitment when the mainchain drops the second. |

## Functional tests

`feature_sidechain.py`, against one Chains node:

- the node follows the mainchain; blocks need a mainchain commitment (BMM);
- activation, blind merged mining, deposits, fees to the block's miner;
- withdrawals, refunds, bundles voted through and paid, bundles that fail and
  whose withdrawals go in a later one;
- a mainchain reorg takes the sidechain blocks it committed to with it;
- restarts, reindex, a node that was away catching up;
- continuous mining, mining for fees, mining by hand;
- the mainchain node gone, or taking connections and never answering: the
  node keeps running and says so;
- **the double payout**: a reorg of the sidechain leaves a bundle pending on
  the mainchain that the sidechain no longer has. The sidechain refuses
  refunds while it is pending with support, commits to a bundle of its own
  with the same withdrawal, and its node stops vouching
  for it. The miners vote it down, it fails, and the next bundle pays each
  withdrawal once.

`feature_sidechain_network.py`, two mainchain nodes and a line of sidechain
nodes:

- deposits and blocks through either mainchain node; payments relayed across
  the line;
- a bundle reaching both mainchain nodes, voted through;
- the mainchain splits, each half committing to its own sidechain blocks; the
  halves join, and every sidechain node goes over to the branch with more
  work;
- a mainchain node stops: the nodes that follow it hold what they cannot
  check;
- a late joiner syncs from its peers; restarted and reindexed nodes come back
  to the same state.

On regtest, every block that fails to connect is checked against a copy of the
database taken beforehand, which the in-place rollback must give back exactly.

## Fuzz targets (`src/test/fuzz/sidechain.cpp`)

| Target | What it checks |
|---|---|
| `sidechain_scripts` | Withdrawal, refund and bundle-commitment scripts read back what built them; mainchain records of both formats read and write alike. |
| `sidechain_state` | Withdrawals, refunds and a fuzzed mainchain (bundles proposed, paid, failed, paid on another branch, deposits): <br>• every block undone gives the state back; <br>• **no refund is ever accepted, and no bundle started, while a bundle is pending on the mainchain**. |

The mainchain targets `drivechain_messages` and `drivechain_scdb` are here too
(`src/test/fuzz/drivechain.cpp`).

## Thunder

Thunder's rule is size: blocks of 32 million weight units (31 million for
transactions, against Chains' 4 million), and 640,000 sigops.

`src/test/thunder_tests.cpp` checks each limit at its value, a block exactly at
the limit being valid and one unit over refused with the limit's reason:

- `bad-blk-length` (8,000,000 bytes without witness), `bad-blk-tx-weight`
  (31,000,000 weight units, with a small coinbase too), `bad-blk-weight` (only
  reachable with witness data), and `bad-blk-sigops`, both where `CheckBlock`
  counts legacy sigops and where `ConnectBlock` adds P2SH and witness ones;
- the miner: 39 transactions of 16,000 sigops, and transactions under 31,000,000
  weight units;
- the chain parameters of each network, `GetNetworkForMagic`, merkle proofs of
  blocks of more transactions than Bitcoin's could hold, and that the RPC server
  takes a request that submits the largest block.

`feature_thunder_blocks.py` runs them on a chain, against a mainchain node:

- `getblocktemplate` gives Thunder's limits; the mempool keeps Bitcoin's
  transaction limits;
- a block heavier than the mainchain's, and one larger than a P2P message of
  Bitcoin (mostly witness data), are mined and relayed; transactions of them
  are proved (`gettxoutproof`, `verifytxoutproof`, `importprunedfunds`);
- a reorganisation of the mainchain takes the large block back and gives it back;
- the miner stops below 640,000 sigops;
- `submitblock` refuses a block over each limit with its reason;
- a block of more than 65,536 transactions is relayed as a whole block, not a
  compact block;
- a block of more than 16,777,215 bytes is submitted through RPC and relayed,
  and the transaction index finds a transaction past the offsets its entries
  hold;
- `-reindex` and `-reindex-chainstate` read the large blocks back.
