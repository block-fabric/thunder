// Thunder against a live mainchain (run_sidechain.py --script thunder.js): its pages driven as a user
// would. The wallet gets coins (a deposit by the helper of the mainchain wallet, merged mining on); Batch
// pay takes a recipient typed in its form and forty pasted, the list is exported to a CSV file and read
// back from it (both through the file chooser of the desktop, answered by the test), checked, confirmed and
// paid in one transaction of forty-one outputs, mined in a block of Thunder. Payments shows it as one batch
// and opens its recipients; Throughput shows the block that carried it, and the mempool. Pictures of every
// page of Thunder on the way, in Midnight and Light, in the dashboard and the workspace.
(async () => {
  const { host, rpc, sleep, log, T, waitFor, check, snapshot, text, finish } = E2E;
  const DIR = window.__E2E_DIR;
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const set = (el, value) => {
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const openDialog = () => $$('dialog[open]').pop();
  const button = (label, root = document) => $$('button', root).find((b) => b.textContent.trim().replace(/\s+/g, ' ').startsWith(label));
  async function click(label, root, ms) {
    const b = await waitFor(`the button "${label}"`, () => {
      const el = button(label, typeof root === 'function' ? root() : root);
      return el && !el.disabled ? el : null;
    }, ms);
    b.click();
    await sleep(120);
  }
  async function answerDialog(title, label) {
    const d = await waitFor(`the dialog "${title}"`, () => {
      const el = openDialog();
      return el && $('h2', el) && $('h2', el).textContent.trim() === title ? el : null;
    });
    // The send button of a confirmation waits a few seconds (SEND_CONFIRM_DELAY).
    await click(label, d, 15000);
    await waitFor(`the dialog "${title}" to go`, () => openDialog() !== d || !d.open);
  }
  async function go(page, tab = '') {
    T().go(page, tab);
    await sleep(300);
  }
  async function shot(name) {
    const overlay = $$('dialog[open]').find((d) => /Synchronizing/.test(d.textContent));
    if (overlay) {
      const hide = button('Hide', overlay);
      if (hide) hide.click();
      await sleep(300);
    }
    await snapshot(name);
  }
  const grid = (name) => $(`[role="grid"][aria-label="${name}"]`);
  const rows = (name) => $$('[role="row"]', grid(name) || document.createElement('div')).slice(1);

  try {
    await waitFor('the node to run', () => T() && T().app.phase === 'ready' && T().node.tip, 120000);
    await waitFor('the node to reach the mainchain', async () => (await rpc('getmainchaininfo')).connected, 60000);
    await check('Thunder, the dashboard and Midnight by default', T().app.info.name === 'Thunder' && T().prefs.layout === 'dashboard' && (T().prefs.theme ?? 'midnight') === 'midnight', `${T().app.info.name} ${T().prefs.layout}`);
    // In the Chain section, after Peg and Merged mining: the Wallet section is the user's six pages (audit port-2 #9).
    const bar = text('nav.sidebar');
    const at = (w) => bar.indexOf(w);
    await check('the pages of Thunder in the sidebar, in the Chain section after Merged mining',
      at('Advanced transactions') >= 0 && at('Advanced transactions') < at('Peg') && at('Merged mining') < at('Batch pay') && at('Batch pay') < at('Payments') && at('Payments') < at('Throughput'), bar);

    // --- A wallet with coins, and one to pay ---
    await rpc('createwallet', ['th']);
    await waitFor('the wallet in the page', () => T().wallets.current === 'th');
    const deposit = await rpc('getdepositaddress', [], 'th');
    // The wallet of the mainchain node pays: on the desktop's word (audit port-1 #4), accepted here.
    await host('test.confirmAnswer', { yes: true });
    await host('peg.deposit', { destination: deposit.depositaddress, amount: '30' });
    await rpc('setbmm', [true, await rpc('getnewaddress', [], 'th'), true]);
    await waitFor('the deposit credited', async () => (await rpc('getbalances', [], 'th')).mine.trusted >= 30, 240000);
    await rpc('createwallet', ['dest']);
    // The page stays on the wallet that pays.
    T().selectWallet('th');
    await waitFor('the paying wallet in the page', () => T().wallets.current === 'th');
    const payees = [];
    for (let i = 0; i < 41; i++) payees.push(await rpc('getnewaddress', [`payee ${i}`], 'dest'));

    await go('home');
    await waitFor('the cards of Thunder on the home', () => text('.home').includes('Throughput') && text('.home').includes('Payments today'), 30000);
    await sleep(1500);
    await shot('th-home-before');

    // --- Batch pay: one typed, forty pasted ---
    await go('batchpay');
    await waitFor('the form of Batch pay', () => $('#bp-add-address'));
    await shot('th-batch-empty');
    set($('#bp-add-address'), payees[0]);
    set($('#bp-add-amount'), '0.5');
    set($('#bp-add-label'), 'Typed in');
    await sleep(200);
    $('form[aria-label="Add a recipient"]').requestSubmit();
    await waitFor('the recipient typed in the list', () => rows('Recipients of the batch').length === 1, 10000);
    await click('Paste…');
    const lines = ['address,amount,label', ...payees.slice(1).map((a, i) => `${a},${(0.01 * (i + 1)).toFixed(2)},Payee ${i + 1}`)];
    set($('#bp-paste'), lines.join('\n'));
    await waitFor('the paste read', () => text('dialog[open]').includes('40 recipients read'), 10000);
    await shot('th-batch-paste');
    await click('Read the list', openDialog());
    await waitFor('41 recipients, all ready', () => text('[aria-label="Summary of the batch"]').includes('41 recipients ready'), 20000);
    await check('the list totalled: 0.5 and 0.01 to 0.40', text('[aria-label="Summary of the batch"]').includes('8.70000000'), text('[aria-label="Summary of the batch"]'));

    // --- Exported to a CSV file, cleared, imported again: the file chooser of the desktop answered by the test ---
    await host('test.fileAnswer', { path: `${DIR}/batch.csv` });
    await click('Export…');
    await sleep(800);
    await click('Clear');
    await answerDialog('Clear the list', 'Clear');
    await waitFor('the list empty', () => text('.batch').includes('No recipient yet'), 10000);
    await host('test.fileAnswer', { path: `${DIR}/batch.csv` });
    await click('Import CSV…');
    await waitFor('the list read from the file', () => text('[aria-label="Summary of the batch"]').includes('41 recipients ready'), 20000);
    await check('the file named in the list', text('.batch').includes('batch.csv'));
    await sleep(800);
    await shot('th-batch-list');
    // Every amount whole, its first digit too, wide and at 420 px (audit port-2 #2: 0.001 read "00100000 CHN").
    const amountsWhole = () => rows('Recipients of the batch').every((r) => {
      const cell = [...r.querySelectorAll('[role="gridcell"]')].find((c) => /CHN/.test(c.textContent));
      const amount = cell && cell.querySelector('.amount');
      if (!amount) return false;
      const a = amount.getBoundingClientRect();
      const c = cell.getBoundingClientRect();
      return a.left >= c.left - 1 && a.right <= c.right + 1 && amount.scrollWidth <= amount.clientWidth + 1;
    });
    await check('the amounts of the list whole', amountsWhole());
    $('.th-table').style.width = '420px';
    await sleep(500);
    await check('the amounts of the list whole at 420 px', amountsWhole());
    await shot('th-batch-list-420');
    $('.th-table').style.width = '';

    // --- Paid in one transaction ---
    $('#bp-pay').click();
    await waitFor('the confirmation', () => text('dialog[open]').includes('Pay 41 recipients?'), 30000);
    await shot('th-batch-confirm');
    await answerDialog('Confirm batch payment', 'Send');
    const txid = await waitFor('the batch sent', () => T().nav.highlightTx || (text('.batch').includes('41 recipients paid') && $('.done .mono') && $('.done .mono').textContent.trim()), 60000);
    await check('the list emptied once paid', text('.batch').includes('No recipient yet'));
    await sleep(800);
    await shot('th-batch-paid');
    const received = await waitFor('the payees paid, in a block', async () => {
      const list = await rpc('listtransactions', ['*', 100], 'dest');
      return list.filter((x) => x.category === 'receive' && x.confirmations > 0).length === 41 ? list : null;
    }, 240000);
    const txids = [...new Set(received.map((x) => x.txid))];
    await check('forty-one payees paid by one transaction', txids.length === 1, JSON.stringify(txids));
    const destBalance = (await rpc('getbalances', [], 'dest')).mine.trusted;
    await check('the payees got 8.7', Math.abs(destBalance - 8.7) < 1e-8, String(destBalance));

    // --- Payments: one batch, its recipients ---
    await go('payments');
    await waitFor('the batch in the payments', () => rows('Payments of the wallet').some((r) => /Batch\s*×41/.test(r.textContent)), 60000);
    await sleep(600);
    await shot('th-payments');
    rows('Payments of the wallet').find((r) => /Batch\s*×41/.test(r.textContent)).click();
    await waitFor('the recipients of the batch', () => rows('Recipients of the batch').length >= 10, 10000);
    await check('the batch opened to its recipients', text('.payments').includes('Batch of 41 recipients'), text('.payments').slice(0, 300));
    await sleep(600);
    await shot('th-payments-batch');
    await go('payments', 'days');
    await sleep(800);
    await shot('th-payments-days');

    // --- Throughput: the block that carried the batch ---
    const height = (await rpc('getblockheader', [received[0].blockhash])).height;
    await go('throughput');
    await waitFor('the block of the batch in the table', () => rows('The latest blocks').some((r) => r.textContent.trim().startsWith(String(height))), 60000);
    const stats = await rpc('getblockstats', [height, ['txs', 'outs']]);
    await check('the block carried the batch', stats.txs >= 2 && stats.outs >= 42, JSON.stringify(stats));
    await sleep(800);
    await shot('th-throughput');
    await go('throughput', 'mempool');
    await waitFor('the mempool tab', () => text('.throughput').includes('Fee estimates'), 10000);
    await sleep(600);
    await shot('th-throughput-mempool');
    await go('home');
    await waitFor('the payments of today on the home', () => text('.home').includes('41 recipients'), 30000);
    await sleep(1200);
    await shot('th-home-midnight');

    // --- Every page of Thunder, in the layouts and looks ---
    T().savePrefs({ theme: 'light' });
    for (const page of ['home', 'batchpay', 'payments', 'throughput']) {
      await go(page);
      await sleep(1000);
      await shot(`th-${page}-light`);
    }
    T().savePrefs({ theme: 'midnight', layout: 'workspace' });
    for (const page of ['home', 'batchpay', 'payments', 'throughput']) {
      await go(page);
      await sleep(1000);
      await shot(`th-workspace-${page}`);
    }
    T().savePrefs({ theme: 'light' });
    for (const page of ['home', 'payments', 'throughput']) {
      await go(page);
      await sleep(1000);
      await shot(`th-workspace-${page}-light`);
    }
    T().savePrefs({ theme: 'midnight', layout: 'dashboard' });
    await go('home');
    await sleep(500);

    await rpc('setbmm', [false]);
    await log(`BATCH ${txids[0]} ${typeof txid === 'string' ? txid : ''}`);
    await finish();
  } catch (e) {
    await finish(e);
  }
})();
