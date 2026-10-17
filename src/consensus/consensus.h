// Copyright (c) 2009-2010 Satoshi Nakamoto
// Copyright (c) 2009-present The Bitcoin Core developers
// Distributed under the MIT software license, see the accompanying
// file COPYING or http://www.opensource.org/licenses/mit-license.php.

#ifndef BITCOIN_CONSENSUS_CONSENSUS_H
#define BITCOIN_CONSENSUS_CONSENSUS_H

#include <cstddef>
#include <cstdint>

/** The maximum allowed size for a serialized block, in bytes (only for buffer size limits) */
inline constexpr unsigned int MAX_BLOCK_SERIALIZED_SIZE{4'000'000};
/** The maximum allowed weight for a block, see BIP 141 (network rule) */
inline constexpr unsigned int MAX_BLOCK_WEIGHT{4'000'000};
/**
 * Thunder: most non-witness signature operations a transaction may execute, counted as BIP54 does,
 * from Consensus::Params::legacy_sigops_limit_height (network rule from that height). Legacy
 * signature hashing is quadratic in the size of a transaction; Thunder's blocks take eight 1 MB
 * (stripped) transactions, so without it a block can take some eight times Bitcoin's worst case.
 */
inline constexpr unsigned int MAX_TX_LEGACY_SIGOPS_CONSENSUS{2'500};
/** The maximum allowed number of signature check operations in a block (network rule) */
inline constexpr int64_t MAX_BLOCK_SIGOPS_COST{80'000};
/** Coinbase transaction outputs can only be spent after this number of new blocks (network rule) */
inline constexpr int COINBASE_MATURITY = 100;

inline constexpr int WITNESS_SCALE_FACTOR = 4;

inline constexpr size_t MIN_TRANSACTION_WEIGHT = WITNESS_SCALE_FACTOR * 60; // 60 is the lower bound for the size of a valid serialized CTransaction
inline constexpr size_t MIN_SERIALIZABLE_TRANSACTION_WEIGHT = WITNESS_SCALE_FACTOR * 10; // 10 is the lower bound for the size of a serialized CTransaction

/** Flags for nSequence and nLockTime locks */
/** Interpret sequence numbers as relative lock-time constraints. */
inline constexpr unsigned int LOCKTIME_VERIFY_SEQUENCE = (1 << 0);

/**
 * Maximum number of seconds that the timestamp of the first
 * block of a difficulty adjustment period is allowed to
 * be earlier than the last block of the previous period (BIP94).
 */
inline constexpr int64_t MAX_TIMEWARP = 600;

#endif // BITCOIN_CONSENSUS_CONSENSUS_H
