// Market tab: every open market offer, filterable by hub and by the resource
// you want to buy (offered) / sell (paid), sortable by exchange ratio.
//
// To take any order you give its requestResource and receive its offerResource,
// so "buy" filters on offerResource and "sell" on requestResource. Ratio is
// received-per-given (offerAmount / requestAmount) — higher is a better deal.

import { ALL_RES_COLORS, applySort, attachSortable, fmt, makeStatCard, marketTradeNet, resourceWeight, setStatusText } from '../common.js';

let iconBase = 'https://s0.nexuslegacy.space/images/resources/';
// All tradable resources, always shown as filter icons (basic first, then exotic).
const RESOURCES = ['ore', 'silicates', 'hydrogen', 'alloys', 'cryo_ice',
  'quantum_dust', 'plasma_core', 'bio_extract', 'dark_matter', 'antimatter'];
const RES_COLOR = ALL_RES_COLORS;
// Mean ratio after dropping the worst 5% (lowball listings nobody trades), so
// the baseline reflects the real market rather than junk orders.
const trimmedMean = nums => {
  if (!nums.length) return 0;
  const s = nums.slice().sort((a, b) => a - b);
  const kept = s.slice(Math.floor(s.length * 0.05));   // cut the lowest 5% of ratios
  return kept.reduce((a, b) => a + b, 0) / kept.length;
};

// Baseline exchange ratio per offer→request pair, across all current-market
// orders. A row is judged good/bad by how its ratio compares to its baseline.
function pairBaselines(list) {
  const groups = {};
  for (const o of list) {
    const k = `${o.offerResource}>${o.requestResource}`;
    (groups[k] = groups[k] || []).push(o.ratio);
  }
  const base = {};
  for (const k in groups) base[k] = trimmedMean(groups[k]);
  return base;
}

let inited = false;
let orders = [];
let buyFilter = new Set(), sellFilter = new Set();   // empty = any; multi-select
let allianceMembers = new Set();   // userIds of your alliance — seller shown green
export const marketSort = { key: 'rate', dir: 1 };   // cheapest cost-per-unit first

const res = s => String(s || '').replace(/_/g, ' ');

let source = 'market';   // 'market' | 'alliance'
let history = [];
let historyUserId = null;
let historyPage = 1;
let historyHubNames = {};
const HISTORY_PER_PAGE = 20;

function byId(id) {
  return document.getElementById(id);
}

function on(id, type, handler) {
  const el = byId(id);
  if (!el) return;
  el.addEventListener(type, handler);
}

attachSortable('m-head', marketSort, () => renderMarket());
on('m-refresh', 'click', () => loadOrders());
on('m-clear', 'click', () => {
  buyFilter.clear(); sellFilter.clear();
  const ratioInput = byId('m-ratio-wanted');
  if (ratioInput) ratioInput.value = '';
  drawIcons('m-buy'); drawIcons('m-sell');
  renderMarket();
});
on('m-ratio-wanted', 'input', () => renderMarket());
on('m-source', 'change', e => {
  source = e.target.checked ? 'alliance' : 'market';
  loadOrders();
});
on('m-history-refresh', 'click', () => loadHistory());
on('m-history-range', 'change', () => {
  historyPage = 1;
  renderHistory();
});
on('m-history-prev', 'click', () => {
  if (historyPage > 1) {
    historyPage--;
    renderHistory();
  }
});
on('m-history-next', 'click', () => {
  const pages = Math.max(1, Math.ceil(filteredHistory().length / HISTORY_PER_PAGE));
  if (historyPage < pages) {
    historyPage++;
    renderHistory();
  }
});

export async function initMarketTab() {
  if (inited) return;
  inited = true;
  try {
    const server = await globalThis.nexusStorage.getActiveServer();
    if (server?.origin) iconBase = `${server.origin}/images/resources/`;
  } catch {
    // Keep the default icon host if server lookup is unavailable.
  }
  // Alliance membership colours alliance sellers green; reused across sources.
  browser.runtime.sendMessage({ type: 'GET_ALLIANCE' }).then(a => {
    allianceMembers = new Set((a && !a.error && a.memberIds) || []);
    renderMarket();
  });
  loadOrders();
  loadHistory();
}

function filteredHistory() {
  const rangeEl = byId('m-history-range');
  if (!rangeEl) return [];
  const range = rangeEl.value;
  if (range === 'all') return history;
  const days = Number(range);
  if (!days) return history;
  const now = new Date();
  const cutoff = days === 1
    ? new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    : Date.now() - days * 86400000;
  return history.filter(trade => new Date(trade.createdAt).getTime() >= cutoff);
}

async function loadHistory() {
  const status = byId('m-history-progress');
  if (!status || !byId('m-profit-stats') || !byId('m-resource-flows') || !byId('m-history-tbody')) {
    return;
  }
  setStatusText(status, 'Loading history…');
  const [data, me, hubs] = await Promise.all([
    browser.runtime.sendMessage({ type: 'GET_MARKET_TRADES' }),
    browser.runtime.sendMessage({ type: 'GET_AUTH_ME' }),
    browser.runtime.sendMessage({ type: 'GET_HUBS' }),
  ]);
  if (data?.error) { setStatusText(status, `Error: ${data.error}`, 'error'); return; }
  if (hubs?.error) { setStatusText(status, `Error: ${hubs.error}`, 'error'); return; }
  if (me?.error || !me?.user) { setStatusText(status, `Error: ${me?.error || 'Unable to identify player.'}`, 'error'); return; }

  historyUserId = me.user.id ?? me.user.userId;
  if (historyUserId == null) {
    setStatusText(status, 'Error: Player ID unavailable.', 'error');
    return;
  }

  history = data.trades || [];
  historyHubNames = Object.fromEntries((hubs.hubs || []).map(hub => [hub.id, hub.name]));
  history.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  historyPage = 1;
  setStatusText(status, `${history.length} trades`);
  renderHistory();
}

function renderHistory() {
  const stats = byId('m-profit-stats');
  const flowBox = byId('m-resource-flows');
  const pageInfo = byId('m-history-page');
  const prev = byId('m-history-prev');
  const next = byId('m-history-next');
  const tbody = byId('m-history-tbody');
  if (!stats || !flowBox || !pageInfo || !prev || !next || !tbody) return;

  const list = filteredHistory();
  const flow = {};
  let profit = 0;
  let fees = 0;
  let bought = 0;
  let sold = 0;

  const normalized = list.map(trade => {
    const net = marketTradeNet(trade, historyUserId);
    flow[net.paidResource] = (flow[net.paidResource] || 0) - net.paid;
    flow[net.receivedResource] = (flow[net.receivedResource] || 0) + net.received;
    profit += net.oreEquivalent;
    fees += net.fee * resourceWeight(net.receivedResource);
    if (net.soldByMe) sold++; else bought++;
    return { trade, net };
  });

  stats.textContent = '';
  const profitCard = makeStatCard(
    'Estimated profit (ore-equivalent)',
    `${profit >= 0 ? '+' : ''}${fmt(Math.round(profit))}`,
    '',
    profit >= 0 ? 'color:var(--success)' : 'color:var(--error)',
  );
  profitCard.title = 'Each trade uses received amount after fee, then subtracts paid value. Transport fuel is not included.';
  stats.append(
    profitCard,
    makeStatCard('Trades', fmt(list.length), 'missions'),
    makeStatCard('Bought / Sold', `${fmt(bought)} / ${fmt(sold)}`, 'hydrogen'),
    makeStatCard('Fees (already included)', fmt(Math.round(fees)), 'alloys'),
  );

  flowBox.textContent = '';
  const flowEntries = Object.entries(flow)
    .filter(([, value]) => value !== 0)
    .sort((a, b) => Math.abs(b[1] * resourceWeight(b[0])) - Math.abs(a[1] * resourceWeight(a[0])));
  if (!flowEntries.length) {
    flowBox.textContent = 'No trades in this range.';
    flowBox.style.color = '#64748b';
  } else {
    flowBox.style.color = '';
    for (const [resource, value] of flowEntries) {
      const chip = document.createElement('span');
      chip.className = 'market-flow-chip';
      const label = document.createElement('span');
      label.textContent = res(resource);
      const amount = document.createElement('strong');
      amount.className = value >= 0 ? 'positive' : 'negative';
      amount.textContent = `${value >= 0 ? '+' : ''}${fmt(value)}`;
      chip.append(label, amount);
      flowBox.appendChild(chip);
    }
  }

  const pages = Math.max(1, Math.ceil(normalized.length / HISTORY_PER_PAGE));
  historyPage = Math.min(Math.max(1, historyPage), pages);
  pageInfo.textContent = `Page ${historyPage} / ${pages} (${normalized.length} trades)`;
  prev.disabled = historyPage <= 1;
  next.disabled = historyPage >= pages;

  tbody.textContent = '';
  const pageRows = normalized.slice((historyPage - 1) * HISTORY_PER_PAGE, historyPage * HISTORY_PER_PAGE);
  if (!pageRows.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 7;
    cell.className = 'zero';
    cell.textContent = 'No trade records in this range.';
    row.appendChild(cell);
    tbody.appendChild(row);
    return;
  }

  for (const { trade, net } of pageRows) {
    const row = document.createElement('tr');
    const fromHub = trade.hubName || historyHubNames[trade.hubId] || (trade.hubId != null ? `Hub ${trade.hubId}` : '—');
    const toHub = trade.buyerHubName || historyHubNames[trade.buyerHubId] || '';
    const hub = toHub && toHub !== fromHub ? `${fromHub} -> ${toHub}` : fromHub;
    const values = [
      new Date(trade.createdAt).toLocaleString(),
      net.soldByMe ? 'Sold' : 'Bought',
      `${fmt(net.paid)} ${res(net.paidResource)}`,
      `${fmt(net.received)} ${res(net.receivedResource)}`,
      net.fee ? `${fmt(net.fee)} ${res(net.receivedResource)}` : '—',
      hub,
      `${net.oreEquivalent >= 0 ? '+' : ''}${fmt(Math.round(net.oreEquivalent))}`,
    ];
    values.forEach((value, index) => {
      const cell = document.createElement('td');
      cell.textContent = value;
      if (index === 1) cell.style.color = net.soldByMe ? '#ffc070' : '#79c0ff';
      if (index === 6) cell.className = net.oreEquivalent >= 0 ? 'market-profit-positive' : 'market-profit-negative';
      row.appendChild(cell);
    });
    tbody.appendChild(row);
  }
}

async function loadOrders() {
  const alliance = source === 'alliance';
  const status = byId('m-count');
  const hubCol = byId('m-hub-col');
  if (!status || !hubCol) return;
  setStatusText(status, `Loading ${alliance ? 'alliance trade' : 'market'} orders…`);
  hubCol.textContent = alliance ? 'System' : 'Hub';

  const toOrder = (o, hub) => ({
    ...o, hub,
    ratio: o.requestAmount ? o.offerAmount / o.requestAmount : 0,
    rate: o.offerAmount ? o.requestAmount / o.offerAmount : 0,   // requested per 1 offered
  });

  if (alliance) {
    const data = await browser.runtime.sendMessage({ type: 'GET_ALLIANCE_ORDERS' });
    if (data.error) { setStatusText(status, `Error: ${data.error}`); return; }
    orders = (data.orders || []).map(o => toOrder(o, o.systemName || `#${o.id}`));
  } else {
    const [data, hubs] = await Promise.all([
      browser.runtime.sendMessage({ type: 'GET_MARKET_ORDERS' }),
      browser.runtime.sendMessage({ type: 'GET_HUBS' }),
    ]);
    if (data.error) { setStatusText(status, `Error: ${data.error}`); return; }
    const hubNames = {};
    for (const h of (hubs?.hubs || [])) hubNames[h.id] = h.name;
    orders = (data.orders || []).map(o => toOrder(o, hubNames[o.hubId] || `Hub ${o.hubId}`));
  }

  buyFilter.clear(); sellFilter.clear();
  drawIcons('m-buy');
  drawIcons('m-sell');
  setStatusText(status, `${orders.length} open orders.`);
  renderMarket();
}

// Clickable resource-icon toggles. Click an icon to filter by it, click the
// selected one again to clear. Broken image URLs fall back to the alt text.
function drawIcons(id) {
  const box = byId(id);
  if (!box) return;
  box.textContent = '';
  const set = id === 'm-buy' ? buyFilter : sellFilter;
  for (const v of RESOURCES) {
    const img = document.createElement('img');
    img.className = 'res-icon' + (set.has(v) ? ' sel' : '');
    img.src = `${iconBase}${v}.webp`;
    img.alt = res(v);
    img.title = res(v);
    img.addEventListener('click', () => {
      if (set.has(v)) set.delete(v); else set.add(v);
      drawIcons(id);
      renderMarket();
    });
    box.appendChild(img);
  }
}

export function renderMarket() {
  const ratioEl = byId('m-ratio-wanted');
  const tbody = byId('m-tbody');
  const count = byId('m-count');
  if (!ratioEl || !tbody || !count) return;
  const ratioWanted = parseFloat(ratioEl.value);
  const rows = applySort('m-head', orders.filter(o =>
    (!buyFilter.size || buyFilter.has(o.offerResource)) &&
    (!sellFilter.size || sellFilter.has(o.requestResource)) &&
    (isNaN(ratioWanted) || o.ratio >= ratioWanted)), marketSort, 'id');

  tbody.textContent = '';
  count.textContent = `${rows.length} orders`;
  if (!rows.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 6; td.style.color = '#64748b';
    td.textContent = orders.length ? 'No orders match these filters.' : 'No open orders.';
    tr.appendChild(td); tbody.appendChild(tr);
    return;
  }
  const med = pairBaselines(orders);
  for (const o of rows) {
    const tr = document.createElement('tr');
    const n = o.rate >= 100 ? Math.round(o.rate) : Math.round(o.rate * 100) / 100;
    const cells = [
      o.hub, o.username,
      `${fmt(o.offerRemaining ?? o.offerAmount)} ${res(o.offerResource)}`,
      `${fmt(o.requestAmount)} ${res(o.requestResource)}`,
      `1 ${res(o.offerResource)} for ${n.toLocaleString()} ${res(o.requestResource)}`,
      o.ratio.toFixed(3),
    ];
    const colColor = { 2: RES_COLOR[o.offerResource], 3: RES_COLOR[o.requestResource], 5: '#ffc070' };
    if (allianceMembers.has(o.userId)) colColor[1] = '#7ee787';   // alliance seller

    // Tint by deal quality vs the market: this ratio ÷ the pair's baseline ratio
    // (trimmed mean). Above baseline = better-than-typical deal (green), below = red.
    const m = med[`${o.offerResource}>${o.requestResource}`];
    if (m && o.ratio) {
      const score = o.ratio / m;
      if (score > 1) tr.style.background = `rgba(88,130,96,${0.2 + 0.5 * Math.min(1, score - 1)})`;
      else if (score < 1) tr.style.background = `rgba(150,96,94,${0.2 + 0.5 * Math.min(1, 1 - score)})`;
    }
    cells.forEach((v, i) => {
      const td = document.createElement('td');
      td.textContent = v;
      if (colColor[i]) td.style.color = colColor[i];
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }
}
