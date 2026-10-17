#!/usr/bin/env python3
# Copyright (c) 2026 The Chains developers
# Distributed under the MIT software license, see the accompanying
# file COPYING or http://www.opensource.org/licenses/mit-license.php.
"""Test Thunder's mempool policy for long payment lists, and its limit of legacy signature operations.

- Clusters of Thunder: a wallet with one coin pays three transactions of 1,500 outputs one after the
  other, each spending the change of the one before, to P2WPKH and to P2TR addresses (Batch pay of
  thunder-app). Bitcoin's cluster limit (101 kvB) stopped these at the second or third transaction;
  the miner then takes them all in one block.
- BIP54's limit of 2,500 legacy signature operations per transaction (spent scriptPubKeys counted):
  relay policy always; a network rule from Consensus::Params::legacy_sigops_limit_height, set here by
  -testactivationheight=legacysigops@<height> (a placeholder, never, on Thunder's own networks).
"""

from decimal import Decimal

from feature_sidechain import ACTIVATION_PERIOD, COINBASE_MATURITY, SLOT, SidechainTest
from test_framework.blocktools import add_witness_commitment, create_block, create_coinbase
from test_framework.messages import COIN, COutPoint, CTransaction, CTxIn, CTxOut, tx_from_hex
from test_framework.script import CScript, OP_0, OP_1, OP_CHECKMULTISIG, OP_ENDIF, OP_IF
from test_framework.util import assert_equal, assert_greater_than

# The block from which a transaction may run at most 2,500 legacy signature operations.
LEGACY_SIGOPS_HEIGHT = 12
MAX_TX_LEGACY_SIGOPS = 2_500
# What one transaction of Batch pay pays at most (PART_SIZE of thunder-app).
PART_SIZE = 1_500
PARTS = 3
# Bitcoin's cluster limit, in vbytes, which these parts pass.
BITCOIN_CLUSTER_SIZE = 101_000


def multisigs(n):
    """A scriptPubKey whose `n` CHECKMULTISIGs never run (in an OP_IF not taken) but count 20 legacy signature operations each."""
    return CScript([OP_0, OP_IF] + [OP_CHECKMULTISIG] * n + [OP_ENDIF, OP_1])


class ThunderPolicyTest(SidechainTest):
    def set_test_params(self):
        super().set_test_params()
        rule = f"-testactivationheight=legacysigops@{LEGACY_SIGOPS_HEIGHT}"
        # The first node takes non-standard transactions, to show what the rule itself refuses.
        self.extra_args = [self.extra_args[0] + ["-acceptnonstdtxn=1", rule], self.extra_args[1] + [rule]]

    def run_test(self):
        super().run_test()

    def spend(self, node, utxo, outputs):
        tx = CTransaction()
        tx.vin.append(CTxIn(COutPoint(int(utxo["txid"], 16), utxo["vout"])))
        tx.vout = outputs
        signed = node.signrawtransactionwithwallet(tx.serialize().hex())
        assert signed["complete"]
        return tx_from_hex(signed["hex"])

    def new_block(self, node, txs):
        tip = node.getblock(node.getbestblockhash())
        block = create_block(int(tip["hash"], 16), create_coinbase(tip["height"] + 1, nValue=0), ntime=tip["time"] + 1, version=0x20000000, txlist=txs)
        block.nBits = int(tip["bits"], 16)
        if any(not tx.wit.is_null() for tx in txs):
            add_witness_commitment(block)
        block.hashMerkleRoot = block.calc_merkle_root()
        block.solve()
        return block

    def commit(self, block):
        self.main.createbmmrequest(SLOT, block.hash_hex, Decimal("0.001"))
        self.mine_main()

    def run_sidechain_test(self):
        main = self.main
        side, other = self.nodes
        self.main_address = main.getnewaddress()
        self.side_address = side.getnewaddress()

        self.log.info("Set up the sidechain and fund a wallet")
        self.mine_main(110)
        main.createsidechainproposal(SLOT, "Thunder", "Large blocks")
        self.mine_main(ACTIVATION_PERIOD + 1)
        main.createsidechaindeposit(SLOT, side.getnewaddress(), 40)
        self.mine_main()
        for _ in range(COINBASE_MATURITY + 1):
            self.bmm()
        assert_equal(side.getbalance(), 40)

        self.log.info("Legacy signature operations: 2,520 and 2,500 in spent scriptPubKeys")
        address = side.getnewaddress()
        txid = side.sendtoaddress(address, 1)
        coin_block = self.bmm()
        tx = side.getrawtransaction(txid, True, coin_block)
        utxo = {"txid": txid, "vout": next(o["n"] for o in tx["vout"] if o["scriptPubKey"].get("address") == address)}
        over, at = multisigs(126), multisigs(125)
        # Bare scripts are not standard: the coins come in a block of the test's own.
        coins = self.spend(side, utxo, [CTxOut(COIN // 10, over), CTxOut(COIN // 10, over), CTxOut(COIN // 10, at)])
        block = self.new_block(side, [coins])
        self.commit(block)
        assert_equal(side.submitblock(block.serialize().hex()), None)
        self.sync_blocks()

        # To a standard output: what the nodes refuse is the input.
        paid_to = bytes.fromhex(side.getaddressinfo(side.getnewaddress())["scriptPubKey"])

        def spend_bare(n):
            tx = CTransaction()
            tx.vin.append(CTxIn(COutPoint(coins.txid_int, n)))
            tx.vout.append(CTxOut(COIN // 10 - 10_000, paid_to))
            return tx

        over_1, over_2, at_limit = spend_bare(0), spend_bare(1), spend_bare(2)
        assert_greater_than(LEGACY_SIGOPS_HEIGHT, side.getblockcount() + 1)

        self.log.info("Before the rule's height: relay policy refuses it, a block takes it")
        result = other.testmempoolaccept([over_1.serialize().hex()])[0]
        assert_equal((result["allowed"], result["reject-reason"]), (False, "bad-txns-nonstandard-inputs"))
        assert_equal(side.testmempoolaccept([over_1.serialize().hex()])[0]["allowed"], True)
        block = self.new_block(side, [over_1])
        self.commit(block)
        assert_equal(side.submitblock(block.serialize().hex()), None)
        self.sync_blocks()
        assert_equal(other.getbestblockhash(), block.hash_hex)

        self.log.info("From the rule's height: no block or mempool takes it")
        while side.getblockcount() + 1 < LEGACY_SIGOPS_HEIGHT:
            self.bmm()
        assert_equal(side.getblockcount() + 1, LEGACY_SIGOPS_HEIGHT)
        result = side.testmempoolaccept([over_2.serialize().hex()])[0]
        assert_equal((result["allowed"], result["reject-reason"]), (False, "bad-txns-legacy-sigops"))
        tip = side.getbestblockhash()
        block = self.new_block(side, [over_2])
        self.commit(block)
        assert_equal(side.submitblock(block.serialize().hex()), "bad-txns-legacy-sigops")
        assert_equal(side.getbestblockhash(), tip)
        # 2,500 is the limit, and is taken.
        assert_equal(side.testmempoolaccept([at_limit.serialize().hex()])[0]["allowed"], True)
        block = self.new_block(side, [at_limit])
        self.commit(block)
        assert_equal(side.submitblock(block.serialize().hex()), None)
        assert_equal(side.getblockcount(), LEGACY_SIGOPS_HEIGHT)
        self.check_in_sync()

        self.log.info("Thunder's clusters: 2,000 kvB on its networks")
        assert_equal(side.getmempoolinfo()["limitclustersize"], 2_000_000)

        for address_type in ("bech32", "bech32m"):
            self.log.info(f"Three transactions of {PART_SIZE} {address_type} outputs, one after the other, from one coin")
            name = f"batch_{address_type}"
            side.createwallet(name)
            wallet = side.get_wallet_rpc(name)
            side.get_wallet_rpc(self.default_wallet_name).sendtoaddress(wallet.getnewaddress(), 2)
            self.bmm()
            assert_equal(len(wallet.listunspent()), 1)
            desc = next(d["desc"] for d in other.listdescriptors()["descriptors"]
                        if not d.get("internal", False) and d["desc"].startswith("wpkh(" if address_type == "bech32" else "tr("))
            addresses = other.deriveaddresses(desc, [0, PARTS * PART_SIZE - 1])
            txids = []
            for part in range(PARTS):
                outputs = {a: Decimal("0.00001") for a in addresses[part * PART_SIZE:(part + 1) * PART_SIZE]}
                txids.append(wallet.sendmany("", outputs))
            # Each spends the change of the one before, unconfirmed.
            for before, after in zip(txids, txids[1:]):
                assert before in [i["txid"] for i in side.getrawtransaction(after, True)["vin"]]
            cluster = side.getmempoolcluster(txids[0])
            assert_equal(cluster["txcount"], PARTS)
            assert_greater_than(cluster["clusterweight"], 4 * BITCOIN_CLUSTER_SIZE)
            self.sync_mempools()
            block = side.getblock(self.bmm())
            assert all(t in block["tx"] for t in txids)
            assert_equal(side.getrawmempool(), [])
            wallet.unloadwallet()
        self.check_in_sync()


if __name__ == '__main__':
    ThunderPolicyTest(__file__).main()
