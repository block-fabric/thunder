// Copyright (c) 2026 The Chains developers
// Distributed under the MIT software license, see the accompanying
// file COPYING or http://www.opensource.org/licenses/mit-license.php.

// Golden values of the sidechain rules: a fixed sequence of blocks, connected one after another to a
// state of their own, and the hash of the state and of what each coinbase pays out after each block.
// The values were recorded with the hooks of sidechain/hooks.h off, as they are unless a sidechain
// installs its own: any change in what a block does to the state, or in the order of what its coinbase
// pays, fails here. A change meant to make one has to say so, and record the values again.

#include <addresstype.h>
#include <arith_uint256.h>
#include <common/signmessage.h>
#include <consensus/merkle.h>
#include <consensus/params.h>
#include <hash.h>
#include <key.h>
#include <primitives/block.h>
#include <primitives/transaction.h>
#include <script/script.h>
#include <sidechain/mainchain.h>
#include <sidechain/state.h>
#include <sidechain/store.h>
#include <test/util/setup_common.h>
#include <uint256.h>

#include <boost/test/unit_test.hpp>

#include <algorithm>
#include <functional>
#include <string>
#include <vector>
namespace {

/** A sidechain state, and the record of its mainchain, that blocks are connected to one after another. */
struct GoldenChain {
    Consensus::SidechainParams params;
    sidechain::EmptyStore empty;
    sidechain::StoreOverlay store{empty, /*journal=*/true};
    sidechain::State state{store};
    sidechain::Mainchain mainchain;
    uint256 prev{uint256{0xab}};
    int height{0};
    //! What the coinbase of the last block connected paid out, after its first output.
    std::vector<CTxOut> paid;

    GoldenChain() { Main(); }

    /** Append a block to the record of the mainchain. */
    void Main(const std::function<void(sidechain::MainBlock&)>& fill = {})
    {
        sidechain::MainBlock block;
        const int h{mainchain.Height() + 1};
        block.hash = ArithToUint256(arith_uint256{static_cast<uint64_t>(0x10000 + h)} << 128);
        block.prev_hash = mainchain.TipHash();
        block.time = 1'700'000'000 + h;
        if (fill) fill(block);
        BOOST_REQUIRE(mainchain.Append(block));
    }

    /**
     * A block of these transactions on the last one, after a mainchain block with these events, its
     * coinbase paying what the rules want (worked out on an overlay that is dropped, as a miner does);
     * then a mainchain block that commits to it. Connected if valid; why not, if not.
     */
    std::string Connect(const std::vector<CTransactionRef>& txs, const std::function<void(sidechain::MainBlock&)>& events = {})
    {
        Main(events);
        CBlock block;
        block.nVersion = 0x20000000;
        block.hashPrevBlock = prev;
        block.nTime = 1'700'000'000 + height + 1;
        block.nBits = 0x207fffff;
        CMutableTransaction coinbase;
        coinbase.vin.resize(1);
        coinbase.vin[0].prevout.SetNull();
        coinbase.vin[0].scriptSig = CScript() << (height + 1) << OP_0;
        coinbase.vout.emplace_back(0, CScript() << OP_TRUE);
        block.vtx.push_back(MakeTransactionRef(coinbase));
        block.vtx.insert(block.vtx.end(), txs.begin(), txs.end());
        {
            sidechain::StoreOverlay scratch{store, /*journal=*/false};
            sidechain::State dry{scratch};
            std::vector<CTxOut> payouts, tx_payouts;
            std::string reason;
            if (dry.ApplyMainEvents(mainchain.Height(), mainchain, height + 1, params, payouts, reason) &&
                dry.ApplyTxs(block, height + 1, params, dry.MainPending(mainchain, params), /*peg_step=*/true, tx_payouts, reason)) {
                for (const CTxOut& out : dry.TakePayouts(std::move(payouts), std::move(tx_payouts))) coinbase.vout.push_back(out);
            }
        }
        block.vtx[0] = MakeTransactionRef(coinbase);
        block.hashMerkleRoot = BlockMerkleRoot(block);
        Main([&](sidechain::MainBlock& b) { b.bmm = block.GetHash(); });
        sidechain::StoreOverlay block_store{store, /*journal=*/false};
        sidechain::State block_state{block_store};
        CAmount minted{0};
        std::string reason;
        if (!block_state.ConnectBlock(block, height + 1, params, mainchain, minted, reason)) return reason;
        block_store.MergeInto(store);
        store.TakeUndo();
        ++height;
        prev = block.GetHash();
        paid.assign(coinbase.vout.begin() + 1, coinbase.vout.end());
        return {};
    }

    /** The hash of what the last block paid out, in order. */
    uint256 PaidHash() const
    {
        HashWriter hasher{};
        hasher << paid;
        return hasher.GetHash();
    }

    /** The state and what the last block paid out are those recorded. */
    void Check(const std::string& state_hash, const std::string& paid_hash, size_t paid_count)
    {
        BOOST_CHECK_EQUAL(state.Hash().GetHex(), state_hash);
        BOOST_CHECK_EQUAL(PaidHash().GetHex(), paid_hash);
        BOOST_CHECK_EQUAL(paid.size(), paid_count);
    }
};

/** The key of the tests: always the same, so that its signatures are too. */
CKey FixedKey(uint8_t n)
{
    std::vector<unsigned char> secret(32, 0);
    secret[0] = 0x5e;
    secret[31] = n;
    CKey key;
    key.Set(secret.begin(), secret.end(), /*fCompressedIn=*/true);
    return key;
}

/** A transaction with these outputs, spending a coin of its own so that every one is different. */
CTransactionRef Tx(std::vector<CTxOut> outputs, uint32_t& nonce)
{
    CMutableTransaction tx;
    ++nonce;
    tx.vin.emplace_back(COutPoint{Txid::FromUint256(ArithToUint256(arith_uint256{nonce} << 64)), nonce});
    tx.vout = std::move(outputs);
    return MakeTransactionRef(std::move(tx));
}

CTxOut RefundOut(const CKey& key, const COutPoint& withdrawal)
{
    sidechain::RefundRequest request;
    request.withdrawal = withdrawal;
    BOOST_REQUIRE(key.SignCompact(MessageHash(sidechain::RefundMessage(withdrawal)), request.signature));
    return CTxOut{0, sidechain::RefundScript(request)};
}

/** Deposits of COIN + `first` and on, one each, in a mainchain block. */
std::function<void(sidechain::MainBlock&)> Deposits(int first, int count)
{
    return [=](sidechain::MainBlock& b) {
        for (int i{first}; i < first + count; ++i) {
            sidechain::MainDeposit deposit;
            deposit.destination = "deposit " + std::to_string(i);
            deposit.amount = COIN + i;
            deposit.txid = ArithToUint256(arith_uint256{static_cast<uint64_t>(i + 1)});
            b.deposits.push_back(deposit);
        }
    };
}

} // namespace

BOOST_FIXTURE_TEST_SUITE(sidechain_state_golden_tests, BasicTestingSetup)

BOOST_AUTO_TEST_CASE(payouts_and_refunds)
{
    // Deposits and refunds of withdrawals, more of each than half a block pays: each queue gets its half,
    // the rest waits, in order; refunds of what is not there are not valid.
    GoldenChain chain;
    uint32_t nonce{0};
    const CKey key{FixedKey(1)};
    const CScript pay{GetScriptForDestination(WitnessV0KeyHash{key.GetPubKey()})};
    const size_t half{sidechain::MAX_PAYOUTS_PER_BLOCK / 2};

    // Block 1: withdrawals, refundable by the key, and fewer deposits than a block pays.
    std::vector<CTxOut> withdrawal_outs;
    for (size_t i{0}; i < half + 100; ++i) withdrawal_outs.emplace_back(COIN + static_cast<CAmount>(i), sidechain::WithdrawalScript(1000, key.GetPubKey().GetID(), pay));
    const CTransactionRef withdrawals{Tx(withdrawal_outs, nonce)};
    BOOST_REQUIRE_EQUAL(chain.Connect({withdrawals}, Deposits(0, 300)), "");
    chain.Check("f183adce7be888c96e64d8be61cfcb4ea9a4d86fbabd8ae2f3fbd53768bea666", "40cf09b7240e936dc0a1bed2d4d6bbdb5f7ea2b45e98ca71d2871c338df4b385", 300);
    BOOST_CHECK(chain.paid[0] == (CTxOut{COIN, sidechain::DepositScript("deposit 0", chain.params.slot)}));

    // Refunds of every withdrawal, 100 a transaction.
    const auto refund{[&](size_t n) { return RefundOut(key, COutPoint{withdrawals->GetHash(), static_cast<uint32_t>(n)}); }};
    std::vector<CTransactionRef> refund_txs;
    for (size_t from{0}; from < withdrawal_outs.size(); from += 100) {
        std::vector<CTxOut> outs;
        for (size_t i{from}; i < std::min(withdrawal_outs.size(), from + 100); ++i) outs.push_back(refund(i));
        refund_txs.push_back(Tx(outs, nonce));
    }

    // A refund of a withdrawal there is not: not valid, and nothing changes.
    const uint256 before{chain.state.Hash()};
    BOOST_CHECK_EQUAL(chain.Connect({Tx({RefundOut(key, COutPoint{Txid::FromUint256(uint256{0x99}), 0})}, nonce)}), "bad-sc-refund-unknown");
    BOOST_CHECK(chain.state.Hash() == before);

    // Block 2: every refund, and more deposits than half a block: half each.
    BOOST_REQUIRE_EQUAL(chain.Connect(refund_txs, Deposits(300, half + 50)), "");
    chain.Check("a1be3c29fcdd57249093b7d7221981184aba1f741591ce130fc567f653dcd17e", "66ad73840da69f42baaceb499c20f164ae00f97c1b129c6eb13dd8467944ff16", sidechain::MAX_PAYOUTS_PER_BLOCK);
    BOOST_CHECK(chain.paid[0] == (CTxOut{COIN + 300, sidechain::DepositScript("deposit 300", chain.params.slot)}));
    BOOST_CHECK(chain.paid[half] == (CTxOut{COIN, pay}));
    BOOST_CHECK_EQUAL(chain.state.Queue().size(), 50U);
    BOOST_CHECK_EQUAL(chain.state.TxQueue().size(), 100U);

    // A refund of a withdrawal refunded already: not valid.
    BOOST_CHECK_EQUAL(chain.Connect({Tx({refund(0)}, nonce)}), "bad-sc-refund-unknown");

    // Block 3: what waited, in order.
    BOOST_REQUIRE_EQUAL(chain.Connect({}), "");
    chain.Check("297e809ac12b060ff8b5e45f08065f5ecea67508d27ccacbb079b6b019741639", "8634276a81569d650cfede635e69b5b3e8f07208b92dbc220a3220bf64ca0774", 150);
    BOOST_CHECK(chain.paid[0] == (CTxOut{COIN + 300 + static_cast<CAmount>(half), sidechain::DepositScript("deposit " + std::to_string(300 + half), chain.params.slot)}));
    BOOST_CHECK(chain.paid.back() == (CTxOut{COIN + static_cast<CAmount>(half + 99), pay}));
    BOOST_CHECK(chain.state.Queue().empty() && chain.state.TxQueue().empty());
}

BOOST_AUTO_TEST_SUITE_END()
