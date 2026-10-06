#!/usr/bin/env python3
# Copyright (c) 2023-present The Bitcoin Core developers
# Distributed under the MIT software license, see the accompanying
# file COPYING or http://www.opensource.org/licenses/mit-license.php.
"""Test validateaddress for main chain"""

from test_framework.address import HRP_BY_CHAIN
from test_framework.segwit_addr import encode_segwit_address
from test_framework.test_framework import BitcoinTestFramework

from test_framework.util import assert_equal

# Addresses of the main network that are off by one character. They are made here,
# so that they follow the address prefix of the chain.
_V0 = encode_segwit_address(HRP_BY_CHAIN["main"], 0, bytes.fromhex("751e76e8199196d454941c45d1b3a323f1433bd6"))
ONE_ERROR = _V0[:-1] + ("q" if _V0[-1] != "q" else "p")
_V1 = encode_segwit_address(HRP_BY_CHAIN["main"], 1, bytes.fromhex("3c4a41d0c52be9f3b33e34ac657e0d0825c210cf5ad2c3c154af98d1a5146300"))
INVALID_CHARACTER = _V1[:-3] + "o" + _V1[-2:]
# Upper case, but for the last letter.
_LAST_LETTER = max(i for i, c in enumerate(_V0) if c.isalpha())
MIXED_CASE = _V0[:_LAST_LETTER].upper() + _V0[_LAST_LETTER] + _V0[_LAST_LETTER + 1:].upper()

INVALID_DATA = [
    # BIP 173
    (
        "tc1qw508d6qejxtdg4y5r3zarvary0c5xw7kg3g4ty",
        "Invalid or unsupported Segwit (Bech32) or Base58 encoding.",  # Invalid hrp
        [],
    ),
    (ONE_ERROR, "Invalid Bech32 checksum", [len(ONE_ERROR) - 1]),
    (
        "TH13W508D6QEJXTDG4Y5R3ZARVARY0C5XW7KWHXX2D",
        "Version 1+ witness address must use Bech32m checksum",
        [],
    ),
    (
        "th1rw5ffflh9",
        "Version 1+ witness address must use Bech32m checksum",  # Invalid program length
        [],
    ),
    (
        "th10w508d6qejxtdg4y5r3zarvary0c5xw7kw508d6qejxtdg4y5r3zarvary0c5xw7kw5zxdd87",
        "Version 1+ witness address must use Bech32m checksum",  # Invalid program length
        [],
    ),
    (
        "TH1QR508D6QEJXTDG4Y5R3ZARVARYVY7DTZK",
        "Invalid Bech32 v0 address program size (16 bytes), per BIP141",
        [],
    ),
    (
        "tchn1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sL5k7",
        "Invalid or unsupported Segwit (Bech32) or Base58 encoding.",  # tchn1, Mixed case
        [],
    ),
    (
        MIXED_CASE,
        "Invalid character or mixed case",  # Mixed case, not in BIP 173 test vectors
        [_LAST_LETTER],
    ),
    (
        "th1zw508d6qejxtdg4y5r3zarvaryvqq3yr8w",
        "Version 1+ witness address must use Bech32m checksum",  # Wrong padding
        [],
    ),
    (
        "tth1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3pec22ll",
        "Invalid or unsupported Segwit (Bech32) or Base58 encoding.",  # tchn1, Non-zero padding in 8-to-5 conversion
        [],
    ),
    ("th14420n3", "Empty Bech32 data section", []),
    # BIP 350
    (
        "tc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vq5zuyut",
        "Invalid or unsupported Segwit (Bech32) or Base58 encoding.",  # Invalid human-readable part
        [],
    ),
    (
        "th1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vq29pag7",
        "Version 1+ witness address must use Bech32m checksum",  # Invalid checksum (Bech32 instead of Bech32m)
        [],
    ),
    (
        "tth1z0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqrp24h6",
        "Invalid or unsupported Segwit (Bech32) or Base58 encoding.",  # tchn1, Invalid checksum (Bech32 instead of Bech32m)
        [],
    ),
    (
        "TH1S0XLXVLHEMJA6C4DQV22UAPCTQUPFHLXM9H8Z3K2E72Q4K9HCZ7VQF6T6QV",
        "Version 1+ witness address must use Bech32m checksum",  # Invalid checksum (Bech32 instead of Bech32m)
        [],
    ),
    (
        "th1qw508d6qejxtdg4y5r3zarvary0c5xw7kyes4ds",
        "Version 0 witness address must use Bech32 checksum",  # Invalid checksum (Bech32m instead of Bech32)
        [],
    ),
    (
        "tth1q0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqptnnpd",
        "Invalid or unsupported Segwit (Bech32) or Base58 encoding.",  # tchn1, Invalid checksum (Bech32m instead of Bech32)
        [],
    ),
    (
        INVALID_CHARACTER,
        "Invalid Base 32 character",  # Invalid character in checksum
        [len(INVALID_CHARACTER) - 3],
    ),
    (
        "TH130XLXVLHEMJA6C4DQV22UAPCTQUPFHLXM9H8Z3K2E72Q4K9HCZ7VQRDTNCS",
        "Invalid Bech32 address witness version",
        [],
    ),
    ("th1pw5c3t5f7", "Invalid Bech32 address program size (1 byte)", []),
    (
        "th1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7v8n0nx0muaewav25smhyla",
        "Invalid Bech32 address program size (41 bytes)",
        [],
    ),
    (
        "TH1QR508D6QEJXTDG4Y5R3ZARVARYVY7DTZK",
        "Invalid Bech32 v0 address program size (16 bytes), per BIP141",
        [],
    ),
    (
        "tchn1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vq47Zagq",
        "Invalid or unsupported Segwit (Bech32) or Base58 encoding.",  # tchn1, Mixed case
        [],
    ),
    (
        "th1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7v07qte30vd",
        "Invalid padding in Bech32 data section",  # zero padding of more than 4 bits
        [],
    ),
    (
        "tth1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vprkhrpp",
        "Invalid or unsupported Segwit (Bech32) or Base58 encoding.",  # tchn1, Non-zero padding in 8-to-5 conversion
        [],
    ),
    ("th14420n3", "Empty Bech32 data section", []),
]
VALID_DATA = [
    # BIP 350
    (
        "TH1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7K39QEGJ",
        "0014751e76e8199196d454941c45d1b3a323f1433bd6",
    ),
    # (
    #   "tth1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qyw7lzd",
    #   "00201863143c14c5166804bd19203356da136c985678cd4d27a1b8c6329604903262",
    # ),
    (
        "th1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q9hvcnz",
        "00201863143c14c5166804bd19203356da136c985678cd4d27a1b8c6329604903262",
    ),
    (
        "th1pw508d6qejxtdg4y5r3zarvary0c5xw7kw508d6qejxtdg4y5r3zarvary0c5xw7k87f5k2",
        "5128751e76e8199196d454941c45d1b3a323f1433bd6751e76e8199196d454941c45d1b3a323f1433bd6",
    ),
    ("TH1SW50Q2WDWCT", "6002751e"),
    ("th1zw508d6qejxtdg4y5r3zarvaryvulrcl8", "5210751e76e8199196d454941c45d1b3a323"),
    # (
    #   "tth1qqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesgck3rh",
    #   "0020000000c4a5cad46221b2a187905e5266362b99d5e91c6ce24d165dab93e86433",
    # ),
    (
        "th1qqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesfpykjc",
        "0020000000c4a5cad46221b2a187905e5266362b99d5e91c6ce24d165dab93e86433",
    ),
    # (
    #   "tth1pqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesz0kcmt",
    #   "5120000000c4a5cad46221b2a187905e5266362b99d5e91c6ce24d165dab93e86433",
    # ),
    (
        "th1pqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesrkyl2y",
        "5120000000c4a5cad46221b2a187905e5266362b99d5e91c6ce24d165dab93e86433",
    ),
    (
        "th1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqle33du",
        "512079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
    ),
    # PayToAnchor(P2A)
    (
        "th1pfeesjqj2ys",
        "51024e73",
    ),
]


class ValidateAddressMainTest(BitcoinTestFramework):
    def set_test_params(self):
        self.setup_clean_chain = True
        self.chain = ""  # main
        self.num_nodes = 1
        self.extra_args = [["-prune=899"]] * self.num_nodes

    def check_valid(self, addr, spk):
        info = self.nodes[0].validateaddress(addr)
        assert_equal(info["isvalid"], True)
        assert_equal(info["scriptPubKey"], spk)
        assert "error" not in info
        assert "error_locations" not in info

    def check_invalid(self, addr, error_str, error_locations):
        res = self.nodes[0].validateaddress(addr)
        assert_equal(res["isvalid"], False)
        assert_equal(res["error"], error_str)
        assert_equal(res["error_locations"], error_locations)

    def test_validateaddress(self):
        for (addr, error, locs) in INVALID_DATA:
            self.check_invalid(addr, error, locs)
        for (addr, spk) in VALID_DATA:
            self.check_valid(addr, spk)

    def run_test(self):
        self.test_validateaddress()


if __name__ == "__main__":
    ValidateAddressMainTest(__file__).main()
