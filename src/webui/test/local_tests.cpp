// Copyright (c) 2026 The Chains developers
// Distributed under the MIT software license, see the accompanying
// file COPYING or http://www.opensource.org/licenses/mit-license.php.

// The RPC methods the pages of Thunder add to the page's allowlist (local.cpp), as the host ships it: read
// only, on the quick lane, none of them run with the keys; and what spends or writes stays out of it, the
// sending methods of a batch included (Batch pay sends through wallet.send.*, confirmed in the page).

#include <webui/bridge.h>
#include <webui/local.h>
#include <webui/rpcpolicy.h>

#include <boost/test/unit_test.hpp>

#include <algorithm>
#include <string>

BOOST_AUTO_TEST_SUITE(webui_local_tests)

BOOST_AUTO_TEST_CASE(thunder_rpc_methods)
{
    const auto local{webui::local::RpcMethods()};
    BOOST_CHECK_EQUAL(local.size(), 2U);
    const auto methods{webui::PageRpcMethods()};
    for (const char* m : {"estimatesmartfee", "getchaintxstats"}) {
        BOOST_CHECK_MESSAGE(local.contains(m), m);
        // In the policy of the page, as the host builds it.
        BOOST_CHECK_MESSAGE(webui::PageRpcPolicy(m) == webui::Bridge::Thread::WORKER, m);
        BOOST_CHECK_MESSAGE(std::find(methods.begin(), methods.end(), m) != methods.end(), m);
        BOOST_CHECK_MESSAGE(!webui::KeyedWalletRpc(m), m);
    }
    BOOST_CHECK(webui::local::KeyedRpcMethods().empty());
    // What the Throughput page reads of the kit.
    for (const char* m : {"getblockstats", "getmempoolinfo", "getblockchaininfo"}) BOOST_CHECK_MESSAGE(webui::PageRpcPolicy(m).has_value(), m);
    // Batch pay sends through the host's wallet functions: the RPC methods that send many are not the page's.
    for (const char* refused : {"sendmany", "sendtoaddress", "createrawtransaction", "signrawtransactionwithwallet", "fundrawtransaction", "settxfee", "estimaterawfee"}) {
        BOOST_CHECK_MESSAGE(!webui::PageRpcPolicy(refused), refused);
    }
}

BOOST_AUTO_TEST_SUITE_END()
