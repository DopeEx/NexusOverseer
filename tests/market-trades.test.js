import { test } from 'node:test';
import assert from 'node:assert';
import { readFile } from 'node:fs/promises';

import { makeBrowserStub, loadBackground } from './helpers.js';
import { marketTradeNet, resourceWeight } from '../nexus-addon/common.js';
import { setSettings } from '../nexus-addon/settings.js';

test('resourceWeight and marketTradeNet compute consistent ore-equivalent values', () => {
  assert.equal(resourceWeight('ore'), 1);
  assert.equal(resourceWeight('silicates'), 2);
  assert.equal(resourceWeight('hydrogen'), 3);
  assert.equal(resourceWeight('alloys'), 5);
  assert.equal(resourceWeight('cryo_ice'), 10); // fallback to RARE_WEIGHT

  const trade = {
    sellerId: 7,
    buyerId: 9,
    amountSold: 5400,
    resourceSold: 'hydrogen',
    amountPaid: 600,
    resourcePaid: 'cryo_ice',
    commissionSeller: 30,
    commissionBuyer: 270,
  };

  assert.deepEqual(marketTradeNet(trade, 9), {
    soldByMe: false,
    fee: 270,
    paidResource: 'cryo_ice',
    receivedResource: 'hydrogen',
    paid: 600,
    received: 5130,
    oreEquivalent: 9390,
  });

  assert.deepEqual(marketTradeNet(trade, 7), {
    soldByMe: true,
    fee: 30,
    paidResource: 'hydrogen',
    receivedResource: 'cryo_ice',
    paid: 5400,
    received: 570,
    oreEquivalent: -10500,
  });
});

test('getMarketTrades loads every paginated page', async () => {
  makeBrowserStub();
  const paths = [];

  globalThis.browser.tabs.query = async () => [{ id: 17 }];
  globalThis.browser.tabs.sendMessage = async (tabId, message) => {
    assert.equal(tabId, 17);
    paths.push(message.path);
    const pageMatch = message.path.match(/[?&]page=(\d+)/);
    const page = pageMatch ? Number(pageMatch[1]) : 1;

    const all = [
      { id: 1, createdAt: '2026-08-10T10:00:00Z' },
      { id: 2, createdAt: '2026-08-11T10:00:00Z' },
      { id: 3, createdAt: '2026-08-12T10:00:00Z' },
      { id: 4, createdAt: '2026-08-13T10:00:00Z' },
      { id: 5, createdAt: '2026-08-14T10:00:00Z' },
    ];

    const limit = 2;
    const start = (page - 1) * limit;
    return {
      ok: true,
      data: {
        trades: all.slice(start, start + limit),
        pagination: { total: all.length, limit },
      },
    };
  };

  const bg = await loadBackground();
  const result = await bg.getMarketTrades();

  assert.equal(result.error, undefined);
  assert.equal(result.trades.length, 5);
  assert.deepEqual(result.trades.map(t => t.id), [1, 2, 3, 4, 5]);

  const tradeCalls = paths.filter(path => path.startsWith('/api/market/my-trades'));
  assert.deepEqual(tradeCalls, [
    '/api/market/my-trades?page=1&limit=100',
    '/api/market/my-trades?page=2&limit=2',
    '/api/market/my-trades?page=3&limit=2',
  ]);
});

test('market tables have separate accessible scroll regions and shared footers', async () => {
  const html = await readFile(new URL('../nexus-addon/dashboard.html', import.meta.url), 'utf8');
  const section = html.slice(html.indexOf('<div id="market-content"'), html.indexOf('<div id="techtree-content"'));
  for (const label of ['Market trade history table', 'Market offers table']) {
    assert.match(section, new RegExp(`role="region" aria-label="${label}" tabindex="0"`));
  }
  assert.match(section, /role="tablist" aria-label="Market"/);
  assert.match(section, /id="m-offers-view" role="tabpanel" aria-labelledby="m-tab-offers"/);
  assert.match(section, /id="m-history-view" role="tabpanel" aria-labelledby="m-tab-history" hidden/);
  assert.match(section, /id="m-history-range" class="toolbar-select"/);
  assert.match(section, /id="m-history-refresh" class="toolbar-button secondary-button"/);
  assert.ok(section.indexOf('id="m-tbody"') < section.indexOf('id="m-history-view"'));
  assert.ok(section.indexOf('id="m-history-tbody"') > section.indexOf('id="m-history-view"'));
  assert.equal((section.match(/class="table-footer"/g) || []).length, 2);
  assert.equal((section.match(/<th class="sortable"[^>]*><button type="button">/g) || []).length, 6);
});

test('market tables paginate independently and clamp when filters or page size change', async t => {
  const original = { document: globalThis.document, browser: globalThis.browser, nexusStorage: globalThis.nexusStorage };
  t.after(() => Object.assign(globalThis, original));
  class Element {
    constructor() {
      this.children = []; this.listeners = {}; this.style = {}; this.value = ''; this.attributes = {};
      this.classList = { toggle() {} };
    }
    set textContent(value) { this.text = value; this.children = []; }
    get textContent() { return (this.text || '') + this.children.map(child => child.textContent).join(''); }
    appendChild(child) { this.children.push(child); return child; }
    append(...children) { children.forEach(child => this.appendChild(child)); }
    addEventListener(type, fn) { this.listeners[type] = fn; }
    setAttribute(name, value) { this.attributes[name] = value; }
    focus() { this.focused = true; }
    querySelector(selector) { return selector === 'button' ? this.children[0] : null; }
    fire(type, event = {}) { return this.listeners[type]?.({ target: this, ...event }); }
  }
  const elements = new Map();
  const el = id => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  globalThis.document = { getElementById: el, createElement: () => new Element(), querySelectorAll: () => [] };
  el('m-hub-col').appendChild(new Element());
  el('m-history-range').value = 'all';
  el('m-history-view').hidden = true;
  globalThis.nexusStorage = { getActiveServer: async () => null, setSettings: async () => {} };
  let orders = Array.from({ length: 26 }, (_, id) => ({
    id, userId: 2, username: `Seller ${id}`, hubId: 1, offerResource: 'ore', requestResource: 'hydrogen',
    offerAmount: id === 25 ? 200 : 100, requestAmount: 100,
  }));
  let trades = Array.from({ length: 26 }, (_, id) => ({
    id, createdAt: new Date(Date.now() - (id ? 10 * 86400000 + id * 1000 : 0)).toISOString(),
    sellerId: id % 2 ? 2 : 1, amountSold: 100, resourceSold: 'ore', amountPaid: 50,
    resourcePaid: id === 0 ? 'cryo_ice' : 'hydrogen',
  }));
  let orderError = '';
  let requests = 0;
  globalThis.browser = { runtime: { sendMessage: async message => {
    requests++;
    if (message.type === 'GET_MARKET_ORDERS' || message.type === 'GET_ALLIANCE_ORDERS') return orderError ? { error: orderError } : { orders };
    if (message.type === 'GET_MARKET_TRADES') return { trades };
    if (message.type === 'GET_AUTH_ME') return { user: { id: 1 } };
    if (message.type === 'GET_HUBS') return { hubs: [{ id: 1, name: 'Hub' }] };
    if (message.type === 'GET_ALLIANCE') return { memberIds: [] };
    throw new Error(`Unexpected request: ${message.type}`);
  } } };
  await setSettings({ 'general.tablePageSize': 25 });
  const market = await import(`../nexus-addon/tabs/market.js?test=${crypto.randomUUID()}`);
  await market.initMarketTab();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(el('m-offers-count').textContent, '26 orders');
  assert.equal(el('m-history-count').textContent, '26 trades');
  assert.equal(el('m-tbody').children.length, 25);
  assert.equal(el('m-history-tbody').children.length, 25);
  const directions = el('m-history-tbody').children.slice(0, 2).map(row => row.children[1].children[0]);
  assert.deepEqual(directions.map(badge => [badge.textContent, badge.className]), [
    ['Sold', 'badge badge-warning badge-outline'],
    ['Bought', 'badge badge-info badge-outline'],
  ]);
  assert.ok(el('m-resource-flows').children.some(chip => chip.children[0].textContent === 'Cryo ice'));
  assert.equal(el('m-offers-pagination').hidden, false);
  assert.equal(el('m-history-pagination').hidden, false);
  const summary = el('m-profit-stats').textContent;
  assert.ok(el('m-tbody').children.some(row => row.style.background), 'baseline includes offers on other pages');
  el('m-offers-next').fire('click');
  el('m-history-next').fire('click');
  assert.equal(el('m-tbody').children.length, 1);
  assert.equal(el('m-history-tbody').children.length, 1);
  assert.equal(el('m-profit-stats').textContent, summary, 'profit is calculated across all filtered trades');
  const requestsBeforeSwitch = requests;
  el('m-tab-history').fire('click');
  assert.equal(el('m-offers-view').hidden, true);
  assert.equal(el('m-history-view').hidden, false);
  assert.equal(el('m-tab-history').attributes['aria-selected'], 'true');
  assert.equal(el('m-tab-offers').tabIndex, -1);
  assert.equal(el('m-history-page').textContent, 'Page 2 / 2');
  let prevented = false;
  el('m-tab-history').fire('keydown', { key: 'Home', preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(el('m-tab-offers').focused, true);
  assert.equal(el('m-offers-view').hidden, false);
  assert.equal(el('m-history-view').hidden, true);
  assert.equal(el('m-offers-page').textContent, 'Page 2 / 2');
  el('m-tab-offers').fire('keydown', { key: 'End', preventDefault() {} });
  assert.equal(el('m-history-view').hidden, false);
  assert.equal(el('m-tab-history').focused, true);
  el('m-tab-history').fire('keydown', { key: 'ArrowLeft', preventDefault() {} });
  assert.equal(el('m-offers-view').hidden, false);
  assert.equal(el('m-history-view').hidden, true);
  assert.equal(requests, requestsBeforeSwitch, 'switching views does not issue extra requests');

  await setSettings({ 'general.tablePageSize': 10 });
  el('m-offers-next').fire('click');
  el('m-history-next').fire('click');
  assert.equal(el('m-offers-page').textContent, 'Page 3 / 3');
  assert.equal(el('m-history-page').textContent, 'Page 3 / 3');
  await setSettings({ 'general.tablePageSize': 25 });
  assert.equal(el('m-offers-page').textContent, 'Page 2 / 2');
  assert.equal(el('m-history-page').textContent, 'Page 2 / 2');

  el('m-ratio-wanted').value = '100';
  el('m-ratio-wanted').fire('input');
  assert.equal(el('m-offers-count').textContent, '0 orders');
  assert.equal(el('m-offers-pagination').hidden, true);
  assert.equal(el('m-offers-page').textContent, 'Page 1 / 1');
  el('m-history-range').value = '7';
  el('m-history-range').fire('change');
  assert.equal(el('m-history-count').textContent, '1 trade');
  assert.equal(el('m-history-pagination').hidden, true);

  el('m-ratio-wanted').value = '';
  orders = orders.slice(0, 25);
  await el('m-refresh').fire('click');
  assert.equal(el('m-offers-count').textContent, '25 orders');
  assert.equal(el('m-offers-pagination').hidden, true);
  orders = orders.slice(0, 1);
  await el('m-refresh').fire('click');
  assert.equal(el('m-offers-count').textContent, '1 order');
  assert.equal(el('m-offers-pagination').hidden, true);
  trades = [];
  await el('m-history-refresh').fire('click');
  assert.equal(el('m-history-count').textContent, '0 trades');
  assert.equal(el('m-history-pagination').hidden, true);
  orderError = 'Market unavailable';
  await el('m-refresh').fire('click');
  el('m-ratio-wanted').fire('input');
  assert.match(el('m-count').textContent, /Market unavailable/);
});
