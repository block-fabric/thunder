// A batch of Thunder in several transactions (run_sidechain.py --script thunder_parts.js, audit 7 E-TH): 3001
// recipients pasted, paid in three transactions of at most 1500, each asked once in the dialog of the host, the rows
// paid leaving the list as each transaction is sent; then another list stopped after its first transaction (Stop
// pressed while the dialog of the host asks): 1500 paid, the 1501 others left in the list, said so.
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


  /** The questions of the host to send coins, so far (one per transaction committed). */
  const sends = async () => (await host('test.confirmed')).filter((q) => q.title === 'Send coins').length;
  const summary = () => text('[aria-label="Summary of the batch"]');
  const PART = 1500;
  const COUNT = 2 * PART + 1;
  /** Fill the list with `count` payees from `from` on, pasted, and wait until it is checked. */
  async function fill(payees) {
    await click('Paste…');
    set($('#bp-paste'), ['address,amount,label', ...payees.map((a, i) => `${a},0.001,Payee ${i + 1}`)].join('\n'));
    await waitFor('the paste read', () => text('dialog[open]').includes(`${payees.length} recipients read`), 60000);
    await click('Read the list', openDialog());
    await waitFor(`${payees.length} recipients ready`, () => summary().includes(`${payees.length} recipients ready`), 240000);
  }
  /** The number of recipients the list shows, each moment, while a batch runs. */
  function watchList() {
    const seen = [];
    const timer = setInterval(() => {
      const m = /([0-9][0-9,]*) recipients? ready/.exec(summary());
      const n = m ? Number(m[1].replace(/,/g, '')) : text('.batch').includes('No recipient yet') ? 0 : null;
      if (n !== null && seen[seen.length - 1] !== n) seen.push(n);
    }, 40);
    return { seen, stop: () => clearInterval(timer) };
  }

  try {
    await waitFor('the node to run', () => T() && T().app.phase === 'ready' && T().node.tip, 120000);
    await waitFor('the node to reach the mainchain', async () => (await rpc('getmainchaininfo')).connected, 60000);
    await rpc('createwallet', ['th']);
    await waitFor('the wallet in the page', () => T().wallets.current === 'th');
    const deposit = await rpc('getdepositaddress', [], 'th');
    await host('test.confirmAnswer', { yes: true });
    await host('peg.deposit', { destination: deposit.depositaddress, amount: '30' });
    await rpc('setbmm', [true, await rpc('getnewaddress', [], 'th'), true]);
    await waitFor('the deposit credited', async () => (await rpc('getbalances', [], 'th')).mine.trusted >= 30, 240000);
    // The payees: addresses of another wallet, derived at once from its descriptor.
    await rpc('createwallet', ['dest']);
    T().selectWallet('th');
    await waitFor('the paying wallet in the page', () => T().wallets.current === 'th');
    const desc = (await rpc('listdescriptors', [], 'dest')).descriptors.find((d) => d.desc.startsWith('wpkh(') && !d.internal).desc;
    const payees = await rpc('deriveaddresses', [desc, [0, 2 * COUNT]]);
    await go('batchpay');
    await waitFor('the form of Batch pay', () => $('#bp-add-address'));

    // --- 3001 recipients: three transactions (1500, 1500, 1), each asked once in the dialog of the host ---
    await fill(payees.slice(0, COUNT));
    await check('the list takes three transactions', /Transactions\s*3/.test(text('.batch')), summary());
    await host('test.confirmAnswer', { always: true });
    const asked = await sends();
    const watch = watchList();
    $('#bp-pay').click();
    await waitFor('the confirmation of the page', () => text('dialog[open]').includes(`Pay ${COUNT.toLocaleString('en-US')} recipients?`) || text('dialog[open]').includes(`Pay ${COUNT} recipients?`), 120000);
    await answerDialog('Confirm batch payment', 'Send');
    const outcome = await waitFor('the batch sent', () => {
      const d = openDialog();
      if (d && d.textContent.trim()) return `dialog: ${d.textContent.trim().slice(0, 400)}`;
      return text('.batch').includes('No recipient yet') && !$('#bp-stop') ? 'sent' : null;
    }, 600000);
    await check('the batch sent, no error shown', outcome === 'sent', outcome);
    if (outcome !== 'sent') throw new Error(outcome);
    watch.stop();
    await host('test.confirmAnswer', { always: false });
    await check('each transaction asked once in the dialog of the host', (await sends()) - asked === 3, String((await sends()) - asked));
    await check('the paid rows leave the list as each transaction is sent', watch.seen.includes(COUNT - PART) && watch.seen.includes(1) && watch.seen[watch.seen.length - 1] === 0, JSON.stringify(watch.seen));
    await shot('th-parts-paid');
    const got = await waitFor('the payees paid, in blocks', async () => {
      const list = await rpc('listtransactions', ['*', 10000], 'dest');
      const r = list.filter((x) => x.category === 'receive' && x.confirmations > 0);
      return r.length === COUNT ? r : null;
    }, 600000);
    await check('three transactions paid the 3001 payees', new Set(got.map((x) => x.txid)).size === 3);

    // --- Stopped after the first transaction: a correct partial report, the rest in the list ---
    await fill(payees.slice(COUNT, 2 * COUNT));
    const before = await sends();
    // The first transaction's question shows in the dialog window; Stop is pressed meanwhile, then it is accepted.
    await host('test.confirmAnswer', { show: true });
    $('#bp-pay').click();
    await answerDialog('Confirm batch payment', 'Send');
    await waitFor('the first transaction asked in the dialog window', async () => (await host('test.dialog', { action: 'kind' })) === 'themed', 120000);
    await waitFor('the button Stop', () => $('#bp-stop') && !$('#bp-stop').disabled, 30000);
    $('#bp-stop').click();
    await waitFor('stopping after this transaction', () => text('.batch').includes('Stopping after this transaction'), 10000);
    await shot('th-parts-stopping');
    await sleep(2700);
    await host('test.dialog', { action: 'eval', script: "document.getElementById('dialog-accept').click(); true" });
    await waitFor('the batch stopped', () => !$('#bp-stop') && summary().includes(`${COUNT - PART} recipients ready`), 300000);
    await check('one transaction asked, one sent', (await sends()) - before === 1, String((await sends()) - before));
    await check('the report: 1500 paid, 1501 left in the list', /1,?500 recipients paid/.test(text('.done')) && /1,?501 recipients were not paid/.test(text('.done')) && summary().includes(`${COUNT - PART} recipients ready`), text('.done') || text('.batch').slice(0, 300));
    await shot('th-parts-stopped');
    await waitFor('the 1500 paid, in a block', async () => {
      const list = await rpc('listtransactions', ['*', 10000], 'dest');
      return list.filter((x) => x.category === 'receive' && x.confirmations > 0).length === COUNT + PART;
    }, 600000);
    await check('no payee of the rest was paid', true);
    await finish();
  } catch (e) {
    await finish(e);
  }
})();
