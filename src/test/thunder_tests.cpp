// Copyright (c) 2026 The Chains developers
// Distributed under the MIT software license, see the accompanying
// file COPYING or http://www.opensource.org/licenses/mit-license.php.

// What Thunder changes: its chain parameters, and the limits of its blocks: 32 million weight
// units, 31 million of them for the transactions other than the coinbase, and 640,000 signature
// operations. Each limit is checked at its value: a block exactly at the limit is valid, a block
// one unit over is refused with the reason of that limit.

#include <chainparams.h>
#include <chainparamsbase.h>
#include <coins.h>
#include <consensus/consensus.h>
#include <consensus/merkle.h>
#include <consensus/validation.h>
#include <crypto/sha256.h>
#include <hash.h>
#include <httpserver.h>
#include <kernel/chainparams.h>
#include <merkleblock.h>
#include <node/miner.h>
#include <node/mining_types.h>
#include <pow.h>
#include <primitives/block.h>
#include <script/script.h>
#include <test/util/setup_common.h>
#include <test/util/txmempool.h>
#include <txmempool.h>
#include <util/chaintype.h>
#include <validation.h>
#include <versionbits.h>

#include <boost/test/unit_test.hpp>

#include <memory>
#include <optional>
#include <string>
#include <vector>

namespace {
constexpr uint32_t THUNDER_BLOCK_WEIGHT{32'000'000};
constexpr uint32_t THUNDER_TX_WEIGHT{31'000'000};
constexpr int64_t THUNDER_SIGOPS{640'000};
constexpr uint32_t THUNDER_SLOT{2};

/** The regtest chain of Thunder as a sidechain, in its slot. */
struct ThunderSetup : TestingSetup {
    ThunderSetup() : TestingSetup{ChainType::REGTEST, {.extra_args = {"-sidechainslot=2"}}} {}

    /** A coin of `script`, put straight in the chainstate, for a block to spend. */
    COutPoint AddCoin(const CScript& script)
    {
        LOCK(cs_main);
        const COutPoint out{Txid::FromUint256(m_rng.rand256()), 0};
        m_node.chainman->ActiveChainstate().CoinsTip().AddCoin(out, Coin{CTxOut{COIN, script}, /*nHeightIn=*/0, /*fCoinBaseIn=*/false}, /*possible_overwrite=*/false);
        return out;
    }

    /** The next block on the tip, with these transactions after its coinbase, which carries `coinbase_pad` bytes of data. */
    CBlock MakeBlock(const std::vector<CTransactionRef>& txs, size_t coinbase_pad)
    {
        LOCK(cs_main);
        const CBlockIndex* tip{m_node.chainman->ActiveChain().Tip()};
        CBlock block;
        block.nVersion = VERSIONBITS_TOP_BITS;
        block.hashPrevBlock = tip->GetBlockHash();
        block.nTime = tip->GetMedianTimePast() + 1;
        block.nBits = GetNextWorkRequired(tip, &block, m_node.chainman->GetConsensus());
        CMutableTransaction coinbase;
        coinbase.vin.resize(1);
        coinbase.vin[0].prevout.SetNull();
        coinbase.vin[0].scriptSig = CScript() << (tip->nHeight + 1) << OP_0;
        coinbase.vout.emplace_back(0, CScript() << OP_TRUE);
        if (coinbase_pad) coinbase.vout.emplace_back(0, CScript() << OP_RETURN << std::vector<unsigned char>(coinbase_pad, 0xcb));
        block.vtx.push_back(MakeTransactionRef(std::move(coinbase)));
        block.vtx.insert(block.vtx.end(), txs.begin(), txs.end());
        if (std::any_of(txs.begin(), txs.end(), [](const auto& tx) { return tx->HasWitness(); })) {
            m_node.chainman->GenerateCoinbaseCommitment(block, tip);
        }
        block.hashMerkleRoot = BlockMerkleRoot(block);
        return block;
    }

    /** As MakeBlock, with the coinbase padded to make the block exactly `weight`, which has to be a multiple of 4 away. */
    CBlock MakeBlockOfWeight(const std::vector<CTransactionRef>& txs, int64_t weight)
    {
        // Past 65535 bytes the padding's length prefixes have a fixed size: a byte more of it is 4 weight units more.
        constexpr int64_t BASE_PAD{70'000};
        const int64_t diff{weight - GetBlockWeight(MakeBlock(txs, BASE_PAD))};
        BOOST_REQUIRE_EQUAL(diff % WITNESS_SCALE_FACTOR, 0);
        BOOST_REQUIRE_GE(BASE_PAD + diff / WITNESS_SCALE_FACTOR, 65'536);
        CBlock block{MakeBlock(txs, BASE_PAD + diff / WITNESS_SCALE_FACTOR)};
        BOOST_REQUIRE_EQUAL(GetBlockWeight(block), weight);
        return block;
    }

    BlockValidationState Check(const CBlock& block)
    {
        LOCK(cs_main);
        return TestBlockValidity(m_node.chainman->ActiveChainstate(), block, /*check_pow=*/false, /*check_merkle_root=*/true);
    }
};

int64_t TxWeight(const CBlock& block)
{
    int64_t weight{0};
    for (size_t i{1}; i < block.vtx.size(); ++i) weight += GetTransactionWeight(*block.vtx[i]);
    return weight;
}

/** A transaction of exactly `size` bytes without a witness: spends `in` (an OP_TRUE coin) to an OP_RETURN output. */
CTransactionRef DataTx(const COutPoint& in, size_t size)
{
    const auto make{[&](size_t pad) {
        CMutableTransaction tx;
        tx.vin.emplace_back(in);
        tx.vout.emplace_back(0, CScript() << OP_RETURN << std::vector<unsigned char>(pad, 0xda));
        return tx;
    }};
    // Lengths have a fixed size from 256 to 65535 bytes of data, and past 65535: a byte more of data is a byte more.
    const size_t base_pad{size >= 80'000 ? 70'000U : 300U};
    const size_t base{::GetSerializeSize(TX_WITH_WITNESS(make(base_pad)))};
    BOOST_REQUIRE_GE(size, base);
    CTransactionRef tx{MakeTransactionRef(make(base_pad + size - base))};
    BOOST_REQUIRE_EQUAL(::GetSerializeSize(TX_WITH_WITNESS(*tx)), size);
    return tx;
}

/** Spends `in` (an OP_TRUE coin) to an output of `sigops` OP_CHECKSIGs: that many legacy signature operations. */
CTransactionRef LegacySigopsTx(const COutPoint& in, size_t sigops)
{
    CMutableTransaction tx;
    tx.vin.emplace_back(in);
    const std::vector<unsigned char> checksigs(sigops, OP_CHECKSIG);
    tx.vout.emplace_back(0, CScript(checksigs.begin(), checksigs.end()));
    return MakeTransactionRef(std::move(tx));
}

/** A script that runs one signature check, which fails without an error (empty signature and key), and succeeds: one signature operation. */
const CScript ONE_SIGOP_SCRIPT{CScript() << OP_0 << OP_0 << OP_CHECKSIG << OP_NOT};

CScript P2WSH(const CScript& script)
{
    uint256 hash;
    CSHA256().Write(script.data(), script.size()).Finalize(hash.begin());
    return CScript() << OP_0 << ToByteVector(hash);
}

CScript P2SH(const CScript& script)
{
    return CScript() << OP_HASH160 << ToByteVector(Hash160(script)) << OP_EQUAL;
}

/** A witness script that drops 380 stack items and leaves true: up to 380 * 520 bytes of witness, spent at consensus. */
CScript DropScript()
{
    CScript script;
    for (int i{0}; i < 190; ++i) script << OP_2DROP;
    return script << OP_TRUE;
}

/** Spends `ins` (coins of P2WSH(DropScript())) to an OP_RETURN output, each with 380 witness items of 520 bytes; the last item of the last input has `last_item` bytes. */
CTransactionRef WitnessTx(const std::vector<COutPoint>& ins, size_t last_item = 520)
{
    const CScript script{DropScript()};
    CMutableTransaction tx;
    for (const COutPoint& in : ins) {
        tx.vin.emplace_back(in);
        auto& stack{tx.vin.back().scriptWitness.stack};
        stack.assign(380, std::vector<unsigned char>(520, 0x77));
        stack.emplace_back(script.begin(), script.end());
    }
    tx.vin.back().scriptWitness.stack[379].resize(last_item);
    tx.vout.emplace_back(0, CScript() << OP_RETURN);
    return MakeTransactionRef(std::move(tx));
}
} // namespace

/** On regtest: on the main network, where the slot's activation height is not set yet, a node refuses to start (and says so). */
struct RegTestBasicSetup : BasicTestingSetup {
    RegTestBasicSetup() : BasicTestingSetup{ChainType::REGTEST} {}
};

BOOST_FIXTURE_TEST_SUITE(thunder_tests, RegTestBasicSetup)

BOOST_AUTO_TEST_CASE(chain_params)
{
    struct Expected {
        ChainType chain;
        std::unique_ptr<const CChainParams> params;
        uint16_t port;
        uint16_t rpc_port;
        uint8_t magic;
        std::string hrp;
        int activation_height;
    };
    CChainParams::RegTestOptions side_opts;
    side_opts.sidechain_slot = THUNDER_SLOT;
    std::vector<Expected> chains;
    chains.push_back({ChainType::MAIN, CChainParams::Main(), 9755, 9754, 0x01, "th", 0});
    chains.push_back({ChainType::TESTNET, CChainParams::TestNet(), 19755, 19754, 0x02, "tth", 670});
    chains.push_back({ChainType::SIGNET, CChainParams::SigNet(), 39755, 39754, 0x03, "tth", 0});
    chains.push_back({ChainType::REGTEST, CChainParams::RegTest(side_opts), 29755, 29754, 0x04, "rth", 0});
    for (const auto& [chain, params, port, rpc_port, magic, hrp, activation_height] : chains) {
        BOOST_TEST_INFO("chain " << ChainTypeToString(chain));
        const Consensus::Params& consensus{params->GetConsensus()};
        BOOST_CHECK(params->GetChainType() == chain);
        BOOST_CHECK(consensus.sidechain.enabled);
        BOOST_CHECK_EQUAL(consensus.sidechain.slot, THUNDER_SLOT);
        BOOST_CHECK_EQUAL(consensus.sidechain.main_activation_height, activation_height);
        // Eight times the limits of Bitcoin, with a million weight units set aside for the coinbase.
        BOOST_CHECK_EQUAL(consensus.max_block_weight, THUNDER_BLOCK_WEIGHT);
        BOOST_CHECK_EQUAL(consensus.max_block_tx_weight, THUNDER_TX_WEIGHT);
        BOOST_CHECK_EQUAL(consensus.MaxBlockSigOpsCost(), THUNDER_SIGOPS);
        BOOST_CHECK_EQUAL(consensus.max_block_weight, 8 * MAX_BLOCK_WEIGHT);
        BOOST_CHECK_EQUAL(consensus.MaxBlockSigOpsCost(), 8 * MAX_BLOCK_SIGOPS_COST);
        BOOST_CHECK_EQUAL(consensus.MaxBlockSerializedSize(), THUNDER_BLOCK_WEIGHT);
        // The RPC server takes a request that submits the largest block, as hex.
        BOOST_CHECK_LE(2 * uint64_t{consensus.MaxBlockSerializedSize()} + 1'000'000, bitcoin_http::MAX_BODY_SIZE);
        BOOST_CHECK_EQUAL(params->GetDefaultPort(), port);
        BOOST_CHECK_EQUAL(CreateBaseChainParams(chain)->RPCPort(), rpc_port);
        const MessageStartChars expected_magic{0x74, 0x68, 0x75, magic};
        BOOST_CHECK(params->MessageStart() == expected_magic);
        BOOST_CHECK_EQUAL(params->Bech32HRP(), hrp);
    }

    // Plain regtest, for the tests of Bitcoin: no sidechain, and the limits of Bitcoin.
    const auto regtest{CChainParams::RegTest()};
    BOOST_CHECK(!regtest->GetConsensus().sidechain.enabled);
    BOOST_CHECK_EQUAL(regtest->GetConsensus().max_block_weight, MAX_BLOCK_WEIGHT);
    BOOST_CHECK_EQUAL(regtest->GetConsensus().max_block_tx_weight, MAX_BLOCK_WEIGHT);
    BOOST_CHECK_EQUAL(regtest->GetConsensus().MaxBlockSigOpsCost(), MAX_BLOCK_SIGOPS_COST);
    BOOST_CHECK_EQUAL(regtest->GetDefaultPort(), 29755);
    BOOST_CHECK_EQUAL(regtest->Bech32HRP(), "rth");

    // The data directory of each network.
    BOOST_CHECK_EQUAL(CreateBaseChainParams(ChainType::MAIN)->DataDir(), "");
    BOOST_CHECK_EQUAL(CreateBaseChainParams(ChainType::TESTNET)->DataDir(), "testnet");
    BOOST_CHECK_EQUAL(CreateBaseChainParams(ChainType::SIGNET)->DataDir(), "signet");
    BOOST_CHECK_EQUAL(CreateBaseChainParams(ChainType::REGTEST)->DataDir(), "regtest");
}

BOOST_AUTO_TEST_CASE(network_for_magic)
{
    // The magic bytes of each network give it back: what a UTXO snapshot is checked against.
    BOOST_CHECK(GetNetworkForMagic(CChainParams::Main()->MessageStart()) == ChainType::MAIN);
    BOOST_CHECK(GetNetworkForMagic(CChainParams::TestNet()->MessageStart()) == ChainType::TESTNET);
    BOOST_CHECK(GetNetworkForMagic(CChainParams::SigNet()->MessageStart()) == ChainType::SIGNET);
    BOOST_CHECK(GetNetworkForMagic(CChainParams::RegTest()->MessageStart()) == ChainType::REGTEST);
    // Not those of the sidechain template, nor of Bitcoin.
    BOOST_CHECK(!GetNetworkForMagic(MessageStartChars{0x5c, 0x1d, 0xec, 0x01}));
    BOOST_CHECK(!GetNetworkForMagic(MessageStartChars{0xf9, 0xbe, 0xb4, 0xd9}));
    BOOST_CHECK(!GetNetworkForMagic(MessageStartChars{0x74, 0x68, 0x75, 0x05}));
}

BOOST_AUTO_TEST_CASE(merkle_proof_of_a_large_block)
{
    // A block of Thunder can have more transactions than a block of Bitcoin could (4,000,000 / 240
    // = 16,666): a proof of a transaction in it is taken against Thunder's limit, not Bitcoin's.
    const auto extract{[&](size_t count, uint32_t max_block_weight) {
        std::vector<Txid> txids;
        for (size_t i{0}; i < count; ++i) txids.push_back(Txid::FromUint256(m_rng.rand256()));
        std::vector<bool> match(count, false);
        match[count - 1] = true;
        CPartialMerkleTree tree{txids, match};
        std::vector<Txid> found;
        std::vector<unsigned int> index;
        std::vector<uint256> leaves;
        for (const Txid& txid : txids) leaves.push_back(txid.ToUint256());
        const uint256 root{tree.ExtractMatches(found, index, max_block_weight)};
        const bool ok{root == ComputeMerkleRoot(leaves) && found == std::vector<Txid>{txids.back()} && index == std::vector<unsigned int>{static_cast<unsigned int>(count - 1)}};
        return ok;
    }};
    BOOST_CHECK(extract(20'000, THUNDER_BLOCK_WEIGHT));
    BOOST_CHECK(!extract(20'000, MAX_BLOCK_WEIGHT));
    // The limit of Thunder: 32,000,000 / 240 = 133,333 transactions.
    BOOST_CHECK(extract(THUNDER_BLOCK_WEIGHT / MIN_TRANSACTION_WEIGHT, THUNDER_BLOCK_WEIGHT));
    BOOST_CHECK(!extract(THUNDER_BLOCK_WEIGHT / MIN_TRANSACTION_WEIGHT + 1, THUNDER_BLOCK_WEIGHT));
}

BOOST_AUTO_TEST_SUITE_END()

BOOST_FIXTURE_TEST_SUITE(thunder_tests_limits, ThunderSetup)

BOOST_AUTO_TEST_CASE(fixture_is_thunder)
{
    const Consensus::Params& consensus{m_node.chainman->GetConsensus()};
    BOOST_CHECK(consensus.sidechain.enabled);
    BOOST_CHECK_EQUAL(consensus.sidechain.slot, THUNDER_SLOT);
    BOOST_CHECK_EQUAL(consensus.max_block_weight, THUNDER_BLOCK_WEIGHT);
    BOOST_CHECK_EQUAL(consensus.max_block_tx_weight, THUNDER_TX_WEIGHT);
    BOOST_CHECK_EQUAL(consensus.MaxBlockSigOpsCost(), THUNDER_SIGOPS);
}

BOOST_AUTO_TEST_CASE(block_size_and_transaction_weight)
{
    // Eight transactions of 968,750 bytes: 31,000,000 weight units, Thunder's limit for them. Each
    // is under the 1,000,000 bytes that any transaction is held to.
    constexpr size_t TX_SIZE{968'750};
    std::vector<COutPoint> coins;
    for (int i{0}; i < 9; ++i) coins.push_back(AddCoin(CScript() << OP_TRUE));
    std::vector<CTransactionRef> txs;
    for (int i{0}; i < 8; ++i) txs.push_back(DataTx(coins[i], TX_SIZE));

    // At both limits: transactions of 31,000,000, a block of 32,000,000 (8,000,000 bytes, none of
    // them witness). Valid: four times what Bitcoin takes.
    const CBlock full{MakeBlockOfWeight(txs, THUNDER_BLOCK_WEIGHT)};
    BOOST_CHECK_EQUAL(TxWeight(full), THUNDER_TX_WEIGHT);
    BOOST_CHECK_EQUAL(::GetSerializeSize(TX_WITH_WITNESS(full)), THUNDER_BLOCK_WEIGHT / WITNESS_SCALE_FACTOR);
    {
        const BlockValidationState state{Check(full)};
        BOOST_CHECK_MESSAGE(state.IsValid(), state.ToString());
    }

    struct Case {
        std::string name;
        CBlock block;
        std::string reason;
        std::string debug;
    };
    std::vector<Case> cases;
    // One byte more in the coinbase: 8,000,001 bytes without witness.
    cases.push_back({"a byte over 8,000,000", MakeBlockOfWeight(txs, THUNDER_BLOCK_WEIGHT + WITNESS_SCALE_FACTOR), "bad-blk-length", "size limits failed"});
    // One byte more in a transaction, one less in the coinbase: the block is still 32,000,000.
    {
        std::vector<CTransactionRef> over{txs};
        over.back() = DataTx(coins[7], TX_SIZE + 1);
        cases.push_back({"transactions over 31,000,000", MakeBlockOfWeight(over, THUNDER_BLOCK_WEIGHT), "bad-blk-tx-weight", "ContextualCheckBlock : transaction weight limit failed"});
        BOOST_CHECK_EQUAL(TxWeight(cases.back().block), THUNDER_TX_WEIGHT + WITNESS_SCALE_FACTOR);
    }
    // Transactions over 31,000,000 in a block far under 32,000,000: the coinbase's share cannot be used by others.
    {
        std::vector<CTransactionRef> over{txs};
        over.push_back(DataTx(coins[8], 100'000));
        cases.push_back({"transactions over 31,000,000, small coinbase", MakeBlock(over, 0), "bad-blk-tx-weight", "ContextualCheckBlock : transaction weight limit failed"});
        BOOST_CHECK_LE(GetBlockWeight(cases.back().block), THUNDER_BLOCK_WEIGHT);
    }
    for (const auto& [name, block, reason, debug] : cases) {
        BOOST_TEST_INFO("case: " << name);
        const BlockValidationState state{Check(block)};
        BOOST_CHECK(state.IsInvalid());
        BOOST_CHECK(state.GetResult() == BlockValidationResult::BLOCK_CONSENSUS);
        BOOST_CHECK_EQUAL(state.GetRejectReason(), reason);
        BOOST_CHECK_EQUAL(state.GetDebugMessage(), debug);
    }
}

BOOST_AUTO_TEST_CASE(block_weight_with_witness)
{
    // Only witness data takes a block over 32,000,000 weight units without going over 8,000,000
    // bytes first. Seven transactions of 968,750 bytes (27,125,000 weight units), and 18 spends of
    // 380 witness items of 520 bytes each (some 3,580,000 more): the rest is the coinbase.
    std::vector<CTransactionRef> base;
    for (int i{0}; i < 7; ++i) base.push_back(DataTx(AddCoin(CScript() << OP_TRUE), 968'750));
    std::vector<COutPoint> witness_coins;
    for (int i{0}; i < 18; ++i) witness_coins.push_back(AddCoin(P2WSH(DropScript())));
    std::vector<COutPoint> first(witness_coins.begin(), witness_coins.begin() + 9);
    std::vector<COutPoint> second(witness_coins.begin() + 9, witness_coins.end());

    // The last witness item makes the weight a multiple of 4 away from the target; the coinbase does the rest.
    const auto block_of_weight{[&](int64_t weight) {
        std::vector<CTransactionRef> txs{base};
        txs.push_back(WitnessTx(first));
        txs.push_back(WitnessTx(second, 400));
        const int64_t off{(weight - GetBlockWeight(MakeBlock(txs, 70'000))) % WITNESS_SCALE_FACTOR};
        txs.back() = WitnessTx(second, 400 + (off + WITNESS_SCALE_FACTOR) % WITNESS_SCALE_FACTOR);
        return MakeBlockOfWeight(txs, weight);
    }};

    const CBlock full{block_of_weight(THUNDER_BLOCK_WEIGHT)};
    BOOST_CHECK_LT(TxWeight(full), THUNDER_TX_WEIGHT);
    BOOST_CHECK_LE(::GetSerializeSize(TX_NO_WITNESS(full)) * WITNESS_SCALE_FACTOR, THUNDER_BLOCK_WEIGHT);
    // More than 8,000,000 bytes in all: with witness data a block is larger than a block without can be.
    BOOST_CHECK_GT(::GetSerializeSize(TX_WITH_WITNESS(full)), THUNDER_BLOCK_WEIGHT / WITNESS_SCALE_FACTOR + 2'000'000);
    {
        const BlockValidationState state{Check(full)};
        BOOST_CHECK_MESSAGE(state.IsValid(), state.ToString());
    }

    const CBlock over{block_of_weight(THUNDER_BLOCK_WEIGHT + 1)};
    BOOST_CHECK_LT(TxWeight(over), THUNDER_TX_WEIGHT);
    const BlockValidationState state{Check(over)};
    BOOST_CHECK(state.GetResult() == BlockValidationResult::BLOCK_CONSENSUS);
    BOOST_CHECK_EQUAL(state.GetRejectReason(), "bad-blk-weight");
    BOOST_CHECK_EQUAL(state.GetDebugMessage(), "ContextualCheckBlock : weight limit failed");
}

BOOST_AUTO_TEST_CASE(block_sigops)
{
    // 640,000 signature operations at most, legacy ones counting four times. CheckBlock counts the
    // legacy ones only; ConnectBlock all of them, P2SH and witness ones too.
    struct Case {
        std::string name;
        size_t legacy;
        int witness_inputs;
        int p2sh_inputs;
        std::string reason; // empty: valid
        std::string debug;
    };
    const std::vector<Case> cases{
        {"legacy at the limit", 160'000, 0, 0, "", ""},
        {"legacy over the limit", 160'001, 0, 0, "bad-blk-sigops", "out-of-bounds SigOpCount"},
        {"legacy and witness at the limit", 159'999, 4, 0, "", ""},
        {"witness over the limit", 159'999, 5, 0, "bad-blk-sigops", "too many sigops"},
        {"legacy and P2SH at the limit", 159'999, 0, 1, "", ""},
        {"P2SH over the limit", 159'999, 0, 2, "bad-blk-sigops", "too many sigops"},
    };
    for (const auto& c : cases) {
        BOOST_TEST_INFO("case: " << c.name);
        std::vector<CTransactionRef> txs{LegacySigopsTx(AddCoin(CScript() << OP_TRUE), c.legacy)};
        if (c.witness_inputs || c.p2sh_inputs) {
            CMutableTransaction tx;
            for (int i{0}; i < c.witness_inputs; ++i) {
                tx.vin.emplace_back(AddCoin(P2WSH(ONE_SIGOP_SCRIPT)));
                tx.vin.back().scriptWitness.stack.emplace_back(ONE_SIGOP_SCRIPT.begin(), ONE_SIGOP_SCRIPT.end());
            }
            for (int i{0}; i < c.p2sh_inputs; ++i) {
                tx.vin.emplace_back(AddCoin(P2SH(ONE_SIGOP_SCRIPT)));
                tx.vin.back().scriptSig = CScript() << std::vector<unsigned char>(ONE_SIGOP_SCRIPT.begin(), ONE_SIGOP_SCRIPT.end());
            }
            tx.vout.emplace_back(0, CScript() << OP_RETURN);
            txs.push_back(MakeTransactionRef(std::move(tx)));
        }
        const BlockValidationState state{Check(MakeBlock(txs, 0))};
        if (c.reason.empty()) {
            BOOST_CHECK_MESSAGE(state.IsValid(), state.ToString());
        } else {
            BOOST_CHECK(state.GetResult() == BlockValidationResult::BLOCK_CONSENSUS);
            BOOST_CHECK_EQUAL(state.GetRejectReason(), c.reason);
            BOOST_CHECK_EQUAL(state.GetDebugMessage(), c.debug);
        }
    }
}

BOOST_AUTO_TEST_CASE(miner_stays_under_the_limits)
{
    using node::BlockAssembler;
    using node::BlockCreateOptions;
    CTxMemPool& mempool{*m_node.mempool};
    TestMemPoolEntryHelper entry;
    const auto make_block{[&] {
        BlockCreateOptions options;
        options.test_block_validity = false;
        return BlockAssembler{m_node.chainman->ActiveChainstate(), &mempool, options}.CreateNewBlock();
    }};

    // Signature operations: 45 transactions of 16,000 (the most a transaction may have to be
    // relayed). The miner sets 400 aside for the coinbase and 4,000 for the deposits and refunds it
    // may pay: 4,400 + 39 * 16,000 = 628,400 fits under 640,000, a 40th would not.
    {
        LOCK2(cs_main, mempool.cs);
        for (int i{0}; i < 45; ++i) {
            const CTransactionRef tx{LegacySigopsTx(COutPoint{Txid::FromUint256(m_rng.rand256()), 0}, 4'000)};
            TryAddToMempool(mempool, entry.Fee(COIN).SigOpsCost(16'000).FromTx(tx));
        }
    }
    {
        const auto block_template{make_block()};
        BOOST_REQUIRE(block_template);
        BOOST_CHECK_EQUAL(block_template->block.vtx.size(), 1U + 39);
        int64_t sigops{0};
        for (const int64_t cost : block_template->vTxSigOpsCost) sigops += cost;
        BOOST_CHECK_EQUAL(sigops, 39 * 16'000);
    }

    // Weight: 320 transactions of 100,000 weight units (a mempool cluster is kept under 101,000
    // vbytes). The transactions of a block stay under 31,000,000: 309 of them, as the miner keeps
    // strictly under its limit.
    {
        LOCK2(cs_main, mempool.cs);
        for (const auto& tx : mempool.infoAll()) mempool.removeRecursive(*tx.tx, MemPoolRemovalReason::REPLACED);
        BOOST_REQUIRE_EQUAL(mempool.size(), 0U);
        for (int i{0}; i < 320; ++i) {
            const CTransactionRef tx{DataTx(COutPoint{Txid::FromUint256(m_rng.rand256()), 0}, 25'000)};
            BOOST_REQUIRE_EQUAL(GetTransactionWeight(*tx), 100'000);
            TryAddToMempool(mempool, entry.Fee(COIN).SigOpsCost(0).FromTx(tx));
        }
    }
    const auto block_template{make_block()};
    BOOST_REQUIRE(block_template);
    BOOST_CHECK_EQUAL(block_template->block.vtx.size(), 1U + 309);
    BOOST_CHECK_EQUAL(TxWeight(block_template->block), 30'900'000);
}

BOOST_AUTO_TEST_SUITE_END()
