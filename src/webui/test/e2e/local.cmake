# The page scripts of Thunder's own pages, run against a live mainchain as webui_e2e_<name>
# (webui_local_e2e of test/CMakeLists.txt, from the template).
# thunder.js: a batch payment paid, seen in Payments and Throughput.
webui_local_e2e(thunder 29840)
# thunder_parts.js: a batch in three transactions, each confirmed on the desktop, and a batch stopped after one.
webui_local_e2e(thunder_parts 41760)
