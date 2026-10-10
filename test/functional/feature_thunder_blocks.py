#!/usr/bin/env python3
# Copyright (c) 2026 The Chains developers
# Distributed under the MIT software license, see the accompanying
# file COPYING or http://www.opensource.org/licenses/mit-license.php.
"""Test Thunder's limits on a running chain.

- getblocktemplate gives Thunder's limits; the mempool keeps the transaction limits of Bitcoin.
- A block heavier than a block of the mainchain is mined and relayed.
- A block larger than a P2P message of Bitcoin (4,000,000 bytes), most of it witness data, is
  relayed, proved (gettxoutproof, verifytxoutproof, importprunedfunds), taken back by a
  reorganisation of the mainchain and connected again, and read back by -reindex.
- The miner stops below 640,000 signature operations.
- submitblock refuses a block over each limit of Thunder with the limit's reason.
- Blocks only Thunder can have: more than 65,536 transactions (not relayed as a compact block), and
  more than 16,777,215 bytes (submitted through RPC, past what an entry of the transaction index
  holds).
- Restarts, -reindex and -reindex-chainstate read the large blocks back.
"""

from decimal import Decimal
import os

from feature_sidechain import ACTIVATION_PERIOD, COINBASE_MATURITY, SLOT, SidechainTest
from test_framework.address import script_to_p2wsh
from test_framework.blocktools import add_witness_commitment, create_block, create_coinbase
from test_framework.messages import COIN, COutPoint, CTransaction, CTxIn, CTxInWitness, CTxOut, tx_from_hex
from test_framework.script import CScript, OP_2DROP, OP_CHECKSIG, OP_DROP, OP_RETURN, OP_TRUE
from test_framework.script_util import script_to_p2wsh_script
from test_framework.util import assert_equal, assert_greater_than, assert_raises_rpc_error

THUNDER_BLOCK_WEIGHT = 32_000_000
THUNDER_TX_WEIGHT = 31_000_000
THUNDER_SIGOPS = 640_000
# The weight limit of blocks of the mainchain, which a block of this test has to exceed.
MAINCHAIN_MAX_BLOCK_WEIGHT = 6_000_000
# The largest P2P message of Bitcoin, which a block of this test has to exceed.
MAX_PROTOCOL_MESSAGE_LENGTH = 4_000_000
# Transaction limits of the mempool, Bitcoin's.
MAX_STANDARD_TX_SIGOPS_COST = 16_000
MAX_STANDARD_TX_WEIGHT = 400_000
BIG_TXS = 18
DATA_SIZE = 99_000
# Spends of 380 witness items of 520 bytes each, two per transaction: some 397,000 bytes of witness
# per transaction, under the 101,000 vbytes of a mempool cluster.
WITNESS_TXS = 13
WITNESS_ITEMS = 380
SIGOPS_TXS = 45
# Blocks of more transactions are not relayed as compact blocks (MAX_COMPACT_BLOCK_TXS).
MAX_COMPACT_BLOCK_TXS = 0x10000
FAN_OUT_TXS = 26
FAN_OUT_SIZE = 2_550
# The largest offset of a transaction in its block that an entry of the transaction index holds.
MAX_TXINDEX_OFFSET = 0xFFFFFF
HUGE_BLOCK_TXS = 45
# What the miner sets aside: 400 for the coinbase, 4,000 for the deposits and refunds it may pay.
MINER_RESERVED_SIGOPS = 4_400


def drop_script(i):
    """A witness script, one per i, that drops 380 items and leaves true."""
    return CScript([i, OP_DROP] + [OP_2DROP] * (WITNESS_ITEMS // 2) + [OP_TRUE])


def data_tx(size, salt):
    """A transaction of some `size` bytes, spending a made-up coin: for blocks that are refused before their inputs are looked at."""
    tx = CTransaction()
    tx.vin.append(CTxIn(COutPoint(int.from_bytes(os.urandom(32), "big"), salt)))
    tx.vout.append(CTxOut(0, CScript([OP_RETURN, b"\xda" * (size - 70)])))
    return tx


class ThunderBlocksTest(SidechainTest):
    def set_test_params(self):
        super().set_test_params()
        # Only the first node takes non-standard transactions; the other gets them with the blocks,
        # and keeps a transaction index.
        self.extra_args = [self.extra_args[0] + ["-acceptnonstdtxn=1"], self.extra_args[1] + ["-txindex"]]

    def run_test(self):
        super().run_test()

    def spend(self, node, utxo, outputs):
        """A transaction of the wallet's coin `utxo` to `outputs` (CTxOut), signed."""
        tx = CTransaction()
        tx.vin.append(CTxIn(COutPoint(int(utxo["txid"], 16), utxo["vout"])))
        tx.vout = outputs
        signed = node.signrawtransactionwithwallet(tx.serialize().hex())
        assert signed["complete"]
        return tx_from_hex(signed["hex"])

    def new_block(self, node, txs):
        """A block on the tip of `node` with these transactions, with proof of work."""
        tip = node.getblock(node.getbestblockhash())
        block = create_block(int(tip["hash"], 16), create_coinbase(tip["height"] + 1, nValue=0), ntime=tip["time"] + 1, version=0x20000000, txlist=txs)
        block.nBits = int(tip["bits"], 16)
        if any(not tx.wit.is_null() for tx in txs):
            add_witness_commitment(block)
        block.hashMerkleRoot = block.calc_merkle_root()
        block.solve()
        return block

    def wallet_coin(self, node, amount):
        """A confirmed coin of the wallet of `node`, of `amount`."""
        address = node.getnewaddress()
        txid = node.sendtoaddress(address, amount)
        block = self.bmm()
        tx = node.getrawtransaction(txid, True, block)
        n = next(o["n"] for o in tx["vout"] if o["scriptPubKey"].get("address") == address)
        return {"txid": txid, "vout": n, "amount": amount}

    def commit_and_submit(self, block):
        """Have the mainchain commit to `block`, then submit it: it becomes the tip."""
        self.main.createbmmrequest(SLOT, block.hash_hex, Decimal("0.001"))
        self.mine_main()
        assert_equal(self.nodes[0].submitblock(block.serialize().hex()), None)
        assert_equal(self.nodes[0].getbestblockhash(), block.hash_hex)

    def run_sidechain_test(self):
        main = self.main
        side, other = self.nodes
        self.main_address = main.getnewaddress()
        self.side_address = side.getnewaddress()

        self.log.info("Set up the sidechain and fund a wallet with many coins")
        self.mine_main(110)
        main.createsidechainproposal(SLOT, "Thunder", "Large blocks")
        self.mine_main(ACTIVATION_PERIOD + 1)
        main.createsidechaindeposit(SLOT, side.getnewaddress(), 40)
        self.mine_main()
        for _ in range(COINBASE_MATURITY + 1):
            self.bmm()
        side.sendmany("", {side.getnewaddress(): 1 for _ in range(BIG_TXS)})
        self.bmm()

        self.log.info("getblocktemplate gives Thunder's limits")
        template = side.getblocktemplate({"rules": ["segwit"]})
        assert_equal(template["weightlimit"], THUNDER_BLOCK_WEIGHT)
        assert_equal(template["txweightlimit"], THUNDER_TX_WEIGHT)
        assert_equal(template["sigoplimit"], THUNDER_SIGOPS)
        assert_equal(template["sizelimit"], THUNDER_BLOCK_WEIGHT)
        assert_equal(side.getblockchaininfo()["chain"], "regtest")

        self.log.info("The mempool keeps the transaction limits of Bitcoin")
        utxo = max(side.listunspent(), key=lambda u: u["amount"])
        # Only taken by a node that takes non-standard transactions, if at all: the other refuses its output first.
        too_many_sigops = self.spend(side, utxo, [CTxOut(int(utxo["amount"] * COIN) - 1_000_000, CScript([OP_CHECKSIG] * (MAX_STANDARD_TX_SIGOPS_COST // 4 + 1)))])
        result = side.testmempoolaccept([too_many_sigops.serialize().hex()])[0]
        assert_equal((result["allowed"], result["reject-reason"]), (False, "bad-txns-too-many-sigops"))
        assert_raises_rpc_error(-26, "bad-txns-too-many-sigops", side.sendrawtransaction, too_many_sigops.serialize().hex())
        result = other.testmempoolaccept([too_many_sigops.serialize().hex()])[0]
        assert_equal((result["allowed"], result["reject-reason"]), (False, "scriptpubkey"))
        too_large = self.spend(side, utxo, [CTxOut(0, CScript([OP_RETURN, b"\x11" * (MAX_STANDARD_TX_WEIGHT // 4)]))])
        assert_greater_than(too_large.get_weight(), MAX_STANDARD_TX_WEIGHT)
        result = other.testmempoolaccept([too_large.serialize().hex()])[0]
        assert_equal((result["allowed"], result["reject-reason"]), (False, "tx-size"))

        self.log.info("Fill a block with more than the mainchain would take")
        proofs_address = other.getnewaddress()
        paid = side.sendtoaddress(proofs_address, 1)
        for _ in range(BIG_TXS):
            side.send(outputs=[{"data": "5a" * DATA_SIZE}], fee_rate=2)
        assert_equal(side.getmempoolinfo()["size"], BIG_TXS + 1)
        assert_greater_than(side.getmempoolinfo()["bytes"] * 4, MAINCHAIN_MAX_BLOCK_WEIGHT)
        self.sync_mempools()

        block = side.getblock(self.bmm())
        assert_equal(block["nTx"], BIG_TXS + 2)
        assert_greater_than(block["weight"], MAINCHAIN_MAX_BLOCK_WEIGHT)
        assert_equal(side.getmempoolinfo()["size"], 0)
        assert_equal(other.getbestblockhash(), block["hash"])
        self.log.info(f"Mined and relayed a block of {block['size']} bytes, weight {block['weight']}")

        self.log.info("A transaction of it is proved, and the proof imported by a wallet that did not see it")
        proof = other.gettxoutproof([paid], block["hash"])
        assert_equal(other.verifytxoutproof(proof), [paid])
        assert_equal(side.verifytxoutproof(side.gettxoutproof([block["tx"][5]], block["hash"])), [block["tx"][5]])
        other.createwallet(wallet_name="pruned", disable_private_keys=True)
        pruned = other.get_wallet_rpc("pruned")
        # The proof checks out, but the wallet has nothing to do with the transaction yet.
        assert_raises_rpc_error(-5, "No addresses", pruned.importprunedfunds, side.gettransaction(paid)["hex"], proof)
        pruned.importdescriptors([{"desc": other.getdescriptorinfo(f"addr({proofs_address})")["descriptor"], "timestamp": "now"}])
        pruned.importprunedfunds(side.gettransaction(paid)["hex"], proof)
        assert_equal([t["txid"] for t in pruned.listtransactions()], [paid])
        # A proof of another transaction of the block is refused.
        assert_raises_rpc_error(-5, "Transaction given doesn't exist in proof", pruned.importprunedfunds, side.getrawtransaction(block["tx"][5], False, block["hash"]), proof)
        other.unloadwallet("pruned")

        self.log.info("A block larger than a P2P message of Bitcoin, most of it witness data")
        scripts = [drop_script(i) for i in range(2 * WITNESS_TXS)]
        funding = side.send(outputs={script_to_p2wsh(s): Decimal("0.01") for s in scripts})["txid"]
        funded = self.bmm()
        funding_outputs = side.getrawtransaction(funding, True, funded)["vout"]
        coins = []
        for script in scripts:
            coins.append(next(o["n"] for o in funding_outputs if o["scriptPubKey"]["hex"] == script_to_p2wsh_script(script).hex()))
        witness_txids = []
        for t in range(WITNESS_TXS):
            tx = CTransaction()
            for i in (2 * t, 2 * t + 1):
                tx.vin.append(CTxIn(COutPoint(int(funding, 16), coins[i])))
                wit = CTxInWitness()
                wit.scriptWitness.stack = [bytes([t, i]) * 260 for _ in range(WITNESS_ITEMS)] + [bytes(scripts[i])]
                tx.wit.vtxinwit.append(wit)
            tx.vout.append(CTxOut(int(Decimal("0.019") * COIN), bytes.fromhex(side.getaddressinfo(side.getnewaddress())["scriptPubKey"])))
            witness_txids.append(side.sendrawtransaction(tx.serialize().hex()))
        assert_equal(len(side.getrawmempool()), WITNESS_TXS)
        # Not standard: the other node does not take them, and gets them with the block.
        result = other.testmempoolaccept([side.getrawtransaction(witness_txids[0])])[0]
        assert_equal((result["allowed"], result["reject-reason"]), (False, "bad-witness-nonstandard"))
        witness_block = self.bmm()
        block = side.getblock(witness_block)
        assert_equal(block["nTx"], WITNESS_TXS + 1)
        assert_greater_than(block["size"], MAX_PROTOCOL_MESSAGE_LENGTH)
        assert_greater_than(block["size"], 4 * block["strippedsize"])
        assert_equal(other.getbestblockhash(), witness_block)
        assert_equal(other.getblock(witness_block)["size"], block["size"])
        self.log.info(f"Mined and relayed a block of {block['size']} bytes, weight {block['weight']}")
        proof = other.gettxoutproof([witness_txids[-1]], witness_block)
        assert_equal(other.verifytxoutproof(proof), [witness_txids[-1]])

        self.log.info("A reorganisation of the mainchain takes the large block with it, and gives it back")
        commitment = main.getbestblockhash()
        main.invalidateblock(commitment)
        replacement = main.generateblock(self.main_address, [])["hash"]
        for node in self.nodes:
            node.syncmainchain()
            assert_equal(node.getbestblockhash(), block["previousblockhash"])
        assert_equal(sorted(side.getrawmempool()), sorted(witness_txids))
        main.invalidateblock(replacement)
        main.reconsiderblock(commitment)
        for node in self.nodes:
            node.syncmainchain()
            assert_equal(node.getbestblockhash(), witness_block)
        assert_equal(side.getrawmempool(), [])
        self.check_in_sync()

        self.log.info("The miner stops below 640,000 signature operations")
        # Coins of P2WPKH: a signature operation each to spend, with 3,999 legacy ones in the output
        # 4 * 3,999 + 1 = 15,997, under the 16,000 a transaction may have in the mempool.
        sigops_addresses = [side.getnewaddress(address_type="bech32") for _ in range(SIGOPS_TXS)]
        side.sendmany("", {a: Decimal("0.01") for a in sigops_addresses})
        self.bmm()
        sigops_per_tx = 4 * 3_999 + 1
        for utxo in side.listunspent(addresses=sigops_addresses):
            tx = self.spend(side, utxo, [CTxOut(int(Decimal("0.008") * COIN), CScript([OP_CHECKSIG] * 3_999))])
            side.sendrawtransaction(tx.serialize().hex())
        assert_equal(len(side.getrawmempool()), SIGOPS_TXS)
        fits = (THUNDER_SIGOPS - MINER_RESERVED_SIGOPS - 1) // sigops_per_tx
        assert_equal(fits, 39)
        template = side.getblocktemplate({"rules": ["segwit"]})
        assert_equal(len(template["transactions"]), fits)
        assert_equal({t["sigops"] for t in template["transactions"]}, {sigops_per_tx})
        block = side.getblock(self.bmm())
        assert_equal(block["nTx"], fits + 1)
        assert_equal(len(side.getrawmempool()), SIGOPS_TXS - fits)
        # The rest by a block asked for by hand.
        assert_equal(side.getbmminfo()["mining"], False)
        asked = side.requestbmmblock(self.side_address, Decimal("0.001"))
        assert_equal(asked["transactions"], SIGOPS_TXS - fits + 1)
        self.mine_main()
        assert_equal(side.getbestblockhash(), asked["hash"])
        assert_equal(side.getrawmempool(), [])
        self.sync_blocks()

        self.log.info("submitblock refuses a block over each limit of Thunder")
        tip = side.getbestblockhash()
        # Found in CheckBlock, before the commitment of the mainchain is looked for.
        over_length = self.new_block(side, [data_tx(950_000, i) for i in range(9)])
        assert_greater_than(len(over_length.serialize()) * 4, THUNDER_BLOCK_WEIGHT)
        assert_equal(side.submitblock(over_length.serialize().hex()), "bad-blk-length")
        sigops = data_tx(1_000, 0)
        sigops.vout.append(CTxOut(0, CScript([OP_CHECKSIG] * (THUNDER_SIGOPS // 4 + 1))))
        assert_equal(side.submitblock(self.new_block(side, [sigops]).serialize().hex()), "bad-blk-sigops")
        # Found once the mainchain committed to the block.
        over_tx_weight = self.new_block(side, [data_tx(968_750, i) for i in range(8)] + [data_tx(30_000, 8)])
        assert_greater_than(sum(tx.get_weight() for tx in over_tx_weight.vtx[1:]), THUNDER_TX_WEIGHT)
        assert_greater_than(THUNDER_BLOCK_WEIGHT, over_tx_weight.get_weight())
        witness_heavy = data_tx(1_000, 9)
        witness_heavy.wit.vtxinwit = [CTxInWitness()]
        witness_heavy.wit.vtxinwit[0].scriptWitness.stack = [b"\x77" * 100_000 for _ in range(50)]
        over_weight = self.new_block(side, [data_tx(968_750, i) for i in range(7)] + [witness_heavy])
        assert_greater_than(over_weight.get_weight(), THUNDER_BLOCK_WEIGHT)
        assert_greater_than(THUNDER_BLOCK_WEIGHT, len(over_weight.serialize(with_witness=False)) * 4)
        for refused, reason in ((over_tx_weight, "bad-blk-tx-weight"), (over_weight, "bad-blk-weight")):
            # Without the commitment, the block waits for one.
            assert_equal(side.submitblock(refused.serialize().hex()), "bmm-unknown")
            main.createbmmrequest(SLOT, refused.hash_hex, Decimal("0.001"))
            self.mine_main()
            assert_equal(side.submitblock(refused.serialize().hex()), reason)
            assert_equal(side.getbestblockhash(), tip)
        # The chain goes on.
        self.bmm()
        self.check_in_sync()

        self.log.info("A block of more than 65,536 transactions: not relayed as a compact block")
        # Anyone-can-spend coins for it, made by a block of this test's own.
        utxo = self.wallet_coin(side, Decimal("1"))
        fan_in = self.spend(side, utxo, [CTxOut(1000, CScript([OP_TRUE])) for _ in range(FAN_OUT_TXS)])
        fan_outs = []
        for n in range(FAN_OUT_TXS):
            fan_out = CTransaction()
            fan_out.vin.append(CTxIn(COutPoint(fan_in.txid_int, n)))
            fan_out.vout = [CTxOut(0, CScript([OP_TRUE])) for _ in range(FAN_OUT_SIZE)]
            fan_outs.append(fan_out)
        self.commit_and_submit(self.new_block(side, [fan_in] + fan_outs))
        many = []
        for fan_out in fan_outs:
            fan_out_txid = fan_out.txid_int
            for n in range(FAN_OUT_SIZE):
                tx = CTransaction()
                tx.vin.append(CTxIn(COutPoint(fan_out_txid, n)))
                tx.vout.append(CTxOut(0, CScript([OP_TRUE])))
                many.append(tx)
        many_block = self.new_block(side, many)
        assert_greater_than(len(many_block.vtx), MAX_COMPACT_BLOCK_TXS)
        self.commit_and_submit(many_block)
        assert_equal(side.getblock(many_block.hash_hex)["nTx"], len(many_block.vtx))
        self.sync_blocks()
        assert_equal(other.getblock(many_block.hash_hex, 1)["nTx"], len(many_block.vtx))
        assert_equal(other.getrawtransaction(many[-1].txid_hex), many[-1].serialize().hex())

        self.log.info("A block of more than 16,777,215 bytes, past the offsets a transaction index entry holds")
        scripts = [drop_script(i) for i in range(2 * HUGE_BLOCK_TXS)]
        funding = side.send(outputs={script_to_p2wsh(s): Decimal("0.01") for s in scripts})["txid"]
        funded = self.bmm()
        funding_outputs = side.getrawtransaction(funding, True, funded)["vout"]
        huge_txs = []
        for t in range(HUGE_BLOCK_TXS):
            tx = CTransaction()
            for i in (2 * t, 2 * t + 1):
                n = next(o["n"] for o in funding_outputs if o["scriptPubKey"]["hex"] == script_to_p2wsh_script(scripts[i]).hex())
                tx.vin.append(CTxIn(COutPoint(int(funding, 16), n)))
                wit = CTxInWitness()
                wit.scriptWitness.stack = [bytes([t, i % 256]) * 260 for _ in range(WITNESS_ITEMS)] + [bytes(scripts[i])]
                tx.wit.vtxinwit.append(wit)
            tx.vout.append(CTxOut(int(Decimal("0.019") * COIN), CScript([OP_TRUE])))
            huge_txs.append(tx)
        huge = self.new_block(side, huge_txs)
        assert_greater_than(len(huge.serialize()) - len(huge_txs[-1].serialize()), MAX_TXINDEX_OFFSET)
        assert_greater_than(THUNDER_TX_WEIGHT, huge.get_weight())
        # As hex in a request, more than twice its size: more than the 32 MiB that Bitcoin's RPC server takes.
        assert_greater_than(2 * len(huge.serialize()), 32 * 1024 * 1024)
        self.commit_and_submit(huge)
        self.sync_blocks()
        assert_equal(other.getblock(huge.hash_hex)["size"], len(huge.serialize()))
        # Found by the index of the other node: before the limit from its entry, past it by reading the block.
        for tx in (huge_txs[0], huge_txs[-1]):
            found = other.getrawtransaction(tx.txid_hex, True)
            assert_equal((found["hex"], found["blockhash"]), (tx.serialize().hex(), huge.hash_hex))
        self.log.info(f"Submitted and relayed a block of {len(huge.serialize())} bytes")

        self.log.info("Restarts and reindexes read the large blocks back")
        expected = (side.getbestblockhash(), side.gettxoutsetinfo()["hash_serialized_3"], side.getsidechainstate())
        self.restart_node(1, extra_args=self.extra_args[1] + ["-reindex"])
        self.wait_until(lambda: other.getbestblockhash() == expected[0])
        assert_equal((other.gettxoutsetinfo()["hash_serialized_3"], other.getsidechainstate()), expected[1:])
        assert_greater_than(other.getblock(witness_block)["size"], MAX_PROTOCOL_MESSAGE_LENGTH)
        self.restart_node(0, extra_args=self.extra_args[0] + ["-reindex-chainstate"])
        self.wait_until(lambda: side.getbestblockhash() == expected[0])
        assert_equal((side.gettxoutsetinfo()["hash_serialized_3"], side.getsidechainstate()), expected[1:])
        self.restart_node(0)
        assert_equal(side.getbestblockhash(), expected[0])
        self.connect_nodes(0, 1)
        self.bmm()
        self.check_in_sync()


if __name__ == '__main__':
    ThunderBlocksTest(__file__).main()
