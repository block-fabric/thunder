#!/usr/bin/env python3
# Copyright (c) 2026 The Chains developers
# Distributed under the MIT software license, see the accompanying
# file COPYING or http://www.opensource.org/licenses/mit-license.php.
"""Test that Thunder mines and relays blocks larger than those of the mainchain."""

from decimal import Decimal

from feature_sidechain import ACTIVATION_PERIOD, COINBASE_MATURITY, SLOT, SidechainTest
from test_framework.util import assert_equal, assert_greater_than

# The weight limit of blocks of the mainchain, which a block of this test has to exceed.
MAINCHAIN_MAX_BLOCK_WEIGHT = 6_000_000
BIG_TXS = 18
DATA_SIZE = 99_000


class ThunderBlocksTest(SidechainTest):
    def set_test_params(self):
        super().set_test_params()

    def run_test(self):
        super().run_test()

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

        self.log.info("Fill a block with more than the mainchain would take")
        for _ in range(BIG_TXS):
            side.send(outputs=[{"data": "5a" * DATA_SIZE}], fee_rate=2)
        assert_equal(side.getmempoolinfo()["size"], BIG_TXS)
        assert_greater_than(side.getmempoolinfo()["bytes"] * 4, MAINCHAIN_MAX_BLOCK_WEIGHT)
        self.sync_mempools()

        block = side.getblock(self.bmm())
        assert_equal(block["nTx"], BIG_TXS + 1)
        assert_greater_than(block["weight"], MAINCHAIN_MAX_BLOCK_WEIGHT)
        assert_equal(side.getmempoolinfo()["size"], 0)
        assert_equal(other.getbestblockhash(), block["hash"])
        self.log.info(f"Mined and relayed a block of {block['size']} bytes, weight {block['weight']}")

        self.log.info("The limit of Thunder holds")
        assert_equal(Decimal(side.getmininginfo()["currentblockweight"]) <= 32_000_000, True)


if __name__ == '__main__':
    ThunderBlocksTest(__file__).main()
