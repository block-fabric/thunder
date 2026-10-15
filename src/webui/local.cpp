// Copyright (c) 2026 The Chains developers
// Distributed under the MIT software license, see the accompanying
// file COPYING or http://www.opensource.org/licenses/mit-license.php.

// The host side of the pages of Thunder (src/webui/app/src/chain/local.ts): the RPC methods they call
// beyond those of the kit. Batch pay sends through the wallet functions of the kit (wallet.send.*, with
// many recipients), Payments reads the history of the kit (wallet.transactions), and Throughput reads the
// statistics of the blocks (getblockstats) and the mempool (getmempoolinfo), which the kit allows; what it
// adds is read only.

#include <webui/local.h>

namespace webui::local {

std::map<std::string, Bridge::Thread> RpcMethods()
{
    return {
        // Throughput: the fee estimates of the node, for a block soon and later.
        {"estimatesmartfee", Bridge::Thread::WORKER},
        // Throughput: the transactions of the whole chain, and their rate over a window of blocks.
        {"getchaintxstats", Bridge::Thread::WORKER},
    };
}

std::set<std::string> KeyedRpcMethods()
{
    // None: the pages of Thunder sign through the wallet functions of the kit (wallet.send.prepare).
    return {};
}

void RegisterHost(Bridge& bridge, NodeFn node)
{
    (void)bridge;
    (void)node;
}

} // namespace webui::local
