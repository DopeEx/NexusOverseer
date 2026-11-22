import assert from 'node:assert/strict';
import test from 'node:test';
import { makeBrowserStub } from './helpers.js';
import { fmt } from '../nexus-addon/common.js';
import { setSettings } from '../nexus-addon/settings.js';

test('Xeno fleet checks refresh both progress panels once per observed survey change', async t => {
  makeBrowserStub();
  const browser = globalThis.browser;
  browser.storage.local.onChanged = browser.storage.onChanged;
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.parse('2030-01-20T12:00:00Z') });
  const elements = new Map();
  const element = tag => ({
    tag,
    textContent: '', value: '', style: {}, dataset: {}, options: [], children: [], listeners: {},
    addEventListener(type, listener) { this.listeners[type] = listener; },
    setAttribute(name, value) { if (name === 'id') elements.set(value, this); },
    add(option) { this.options.push(option); },
    append(...children) { this.children.push(...children); },
    appendChild(child) { this.children.push(child); },
    replaceChildren(...children) { this.children = children; },
    querySelector(tag) { return get(`archive-${tag}`); },
  });
  const get = id => {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  };
  const original = globalThis.document;
  const originalOption = globalThis.Option;
  t.after(() => {
    globalThis.document = original;
    globalThis.Option = originalOption;
  });
  globalThis.document = { getElementById: get, createElement: element };
  globalThis.Option = function (text, value) { Object.assign(this, { text, value }); };

  const survey = { id: 1, missionType: 'xeno_survey', status: 'exploring' };
  let missions = [survey];
  let clues = 2;
  let overviewReads = 0;
  let missionReads = 0;
  let chainId = 5;
  let site = null;
  let liveDig = null;
  let paused = false;
  let expiresAt = null;
  let siteClues = 3;
  let codex = { stone: [], voice: [], gaze: [1, 1], memory: [] };
  let monuments = [{ key: 'support_pillar', copies: 1 }, { key: 'celestial_chronometer', copies: 2, untouched: true }];
  let hasResearch = true;
  let overviewError = null;
  let missionError = null;
  const savedComparison = { chainId: 5, siteMoonId: 10, planet: 'Home', zone: 'sentinel', at: 0,
    results: [{ entrance: 'Main (ruins)', candidate: { label: 'Fleet', mass: 100 },
      result: { outcome: 'attacker_won', viable: true, excavators: 3, destroyed: 0, damaged: 0, losses: [] } }] };
  await browser.storage.local.set({ xeno_dig_missions: {
    900202: { simulation: { result: { outcome: 'attacker_won', excavators: 3, destroyed: 1, damaged: 0 } } },
  }, xeno_dig_comparison: savedComparison });
  browser.runtime.sendMessage = async ({ type }) => {
    if (type === 'GET_PLANETS') return { planets: [] };
    if (type === 'GET_MISSIONS') {
      missionReads++;
      return missionError ? { error: missionError } : { missions };
    }
    if (type === 'GET_XENO_OVERVIEW') {
      overviewReads++;
      if (overviewError) return { error: overviewError };
      return {
        chain: chainId == null ? null : { id: chainId, trace: 'ruins', zone: 'sentinel', siteClues, site, paused, expiresAt,
          garrison: [], sideEntrances: [], clues: clues === null ? null : Array.from({ length: clues }, (_, i) =>
            ({ index: i + 1, moonName: `Clue Moon ${i + 1}`, systemName: `SYS-${i + 1}` })) },
        config: { maxClues: 5, zones: { sentinel: { excavators: 3, massLimit: 45000 } } },
        codex, monuments, hasResearch,
        liveDig,
        stats: { successfulDigs: overviewReads, totalDigs: overviewReads },
        reports: [
          { missionId: 900202, battleReportId: 900301, createdAt: '2030-01-21T10:00:00.000Z', zone: 'sentinel', trace: 'ruins',
            entranceTrace: 'spire', mode: 'careful', outcome: 'success', excavatorsSent: 3, excavatorsLost: 0,
            report: { moonName: 'Demo Archive Moon', systemName: 'Demo System', rounds: 7,
              shipsLost: [{ key: 'missile_cruiser', name: 'Missile Cruiser', destroyed: 6, damaged: 2 }],
              delivered: { fragments: 0, resources: { silicates: 9111 }, artifactTier: null },
              overflow: { fragments: 0, resources: { silicates: 33014 }, artifactTier: null },
              monument: { key: 'support_pillar', copies: 1 }, codex: { set: 'gaze', entry: 1 } } },
          { createdAt: '2030-01-20T10:00:00.000Z', report: {} },
          { createdAt: '2030-01-19T10:00:00.000Z',
            report: { shipsLost: [], monument: null,
              delivered: { resources: {}, fragments: 0, artifactTier: null },
              overflow: { resources: {}, fragments: 2, artifactTier: 'rare' } } },
        ],
      };
    }
    throw new Error(`Unexpected request: ${type}`);
  };

  const { initXenoTab, resetXenoTab, renderDigComparison } = await import('../nexus-addon/tabs/xeno.js');
  await initXenoTab();
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const checkFleets = async () => { t.mock.timers.tick(30_000); await settle(); };
  const cardValue = (id, index) => get(id).children[index].children[1].textContent;
  const text = node => typeof node === 'string' ? node
    : [node.textContent, ...(node.children || []).map(text)].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  const disclosure = report => report.children.find(node => node.tag === 'details');
  await settle();
  assert.equal(overviewReads, 1);
  assert.equal(get('xn-overview-status').textContent, '', 'successful account reads do not display an Updated timestamp');
  assert.equal(cardValue('xn-campaign-stats', 0), '2 / 3 clues');
  assert.equal(get('xn-dig-panel').hidden, true, 'no located site yet');
  assert.equal(get('xn-dig-results').hidden, true, 'saved results do not appear before a site is available');
  assert.equal(get('xn-campaign-layout').hidden, false);
  assert.equal(get('xn-campaign-context').hidden, false);
  assert.equal(get('xn-campaign-empty').hidden, true);
  assert.deepEqual(get('xn-clue-milestones').children.map(node => node.title), [
    'Clue 1: unlocked', 'Clue 2: unlocked', 'Dig site: not unlocked', 'Side 1: not unlocked', 'Side 2: not unlocked',
  ]);
  assert.match(text(get('archive-ol')), /SYS-1 Clue Moon 1/);
  const gaze = get('xn-overview-codex').children[2];
  assert.equal(gaze.children[0].children[1].textContent, '1 / 6', 'duplicate entries do not inflate progress');
  assert.equal(gaze.children[1].children[0].title, 'Gaze I: unlocked');
  assert.equal(gaze.children[1].children[1].title, 'Gaze II: not found');
  assert.equal(get('xn-overview-codex').children[0].children[0].children[1].textContent, '0 / 6', 'known empty sets stay zero');
  assert.equal(get('xn-monument-count').textContent, '2 / 12');
  assert.match(text(get('xn-overview-monuments')), /Support Pillar 1 copy.*Celestial Chronometer 2 copies Untouched/);
  const [report, incomplete, empty] = get('xn-overview-reports').children;
  assert.match(text(report.children[0]), /Demo Archive Moon · Demo System Success/);
  assert.match(text(report.children[1]), /Sentinel Careful Channel: Ruins Entrance: Spire/);
  assert.equal(report.children[2].textContent, `Delivered: ${fmt(9111)} silicates`);
  assert.match(report.children[3].textContent, /Monument: Support Pillar · copies: 1 · Codex: Gaze I/);
  const detail = disclosure(report);
  assert.equal(detail.open, false, 'verbose information starts collapsed');
  assert.match(text(detail), /Excavators: 3 sent · 0 lost/);
  assert.match(text(detail), /Ship losses: Missile Cruiser: 6 destroyed, 2 damaged/);
  assert.ok(text(detail).includes(`Overflow: ${fmt(33014)} silicates`));
  assert.match(text(detail), /Battle report: #900301 · Rounds: 7/);
  assert.match(text(detail), /excavators survived 3 \/ 3; destroyed 1 \/ 6; damaged 0 \/ 2/);
  assert.equal(disclosure(incomplete).children.at(-1).textContent, 'No simulation archived for this mission.');
  assert.equal(incomplete.children[2].textContent, 'Delivered: unavailable');
  assert.deepEqual(disclosure(incomplete).children.slice(1, 6).map(node => node.textContent), [
    'Excavators: unknown sent · unknown lost', 'Ship losses: unavailable',
    'Overflow: unavailable', 'Monument: unavailable', 'Codex: unavailable',
  ]);
  assert.equal(empty.children[2].textContent, 'Delivered: none reported');
  assert.deepEqual(disclosure(empty).children.slice(2, 5).map(node => node.textContent), [
    'Ship losses: none reported',
    'Overflow: 2 fragments, Artifact: rare', 'Monument: none reported',
  ]);
  detail.open = true;
  detail.listeners.toggle();

  missions = [survey, { id: 2, missionType: 'expedition', status: 'returning' }];
  await checkFleets();
  assert.equal(overviewReads, 1);

  missions = [{ ...survey, status: 'returning' }];
  clues = 3;
  await checkFleets();
  assert.equal(overviewReads, 2);
  assert.equal(cardValue('xn-campaign-stats', 0), '3 / 3 clues');
  assert.equal(cardValue('xn-overview-stats', 1), '2 / 2');
  assert.equal(disclosure(get('xn-overview-reports').children[0]).open, true, 'refresh preserves an expanded report');

  await checkFleets();
  assert.equal(overviewReads, 2);
  missions = [];
  await checkFleets();
  assert.equal(overviewReads, 3);
  missions = [{ id: 3, missionType: 'xeno_dig', status: 'exploring', targetSystemId: 900001,
    targetSystemName: 'Demo System', sourcePlanetName: 'Demo Home', fleetComposition: [{ quantity: 44 }],
    cargo: { _xenoDig: { moonId: 900401, entranceTrace: 'spire' } } }];
  await checkFleets();
  assert.equal(get('xn-transit-count').textContent, '1 in flight');
  const digRow = get('xn-transit-list').children.at(-1);
  const digMeta = digRow.children[0].children[0].children[1].children[1];
  assert.equal(digMeta.children[0].textContent, 'Excavating');
  assert.equal(digMeta.children[1].textContent, 'Dig · Entrance: Spire · 44 ships');
  missions = [];
  await checkFleets();
  const refreshOverview = async () => {
    get('xeno-content').style.display = 'none';
    t.mock.timers.tick(1000);
    await settle();
    get('xeno-content').style.display = '';
    await initXenoTab();
    await checkFleets();
  };
  clues = 5;
  await refreshOverview();
  assert.equal(get('xn-dig-panel').hidden, true, 'clue count alone does not unlock comparison');
  assert.equal(get('xn-clue-milestones').children[2].title, 'Dig site: not unlocked');
  site = { moonId: 10, moonName: 'Dig Moon' };
  await refreshOverview();
  assert.equal(get('xn-dig-panel').hidden, false);
  assert.equal(get('xn-dig-results').hidden, false);
  assert.match(get('xn-dig-context').textContent, /Saved comparison/);
  assert.equal(get('xn-clue-milestones').children[2].title, 'Dig site: unlocked');
  assert.match(get('xn-site-requirements').textContent, /3 Excavators · Mass limit:/);
  assert.match(text(get('xn-site-entrances')), /Main entrance Ruins No guardians reported/);
  missionError = 'Fleet state unavailable';
  const missionLog = t.mock.method(console, 'error', () => {});
  await checkFleets();
  assert.equal(get('xn-dig-panel').hidden, true, 'unknown fleet state must not imply that dispatch is available');
  assert.equal(missionLog.mock.callCount(), 1);
  missionLog.mock.restore();
  missionError = null;
  await checkFleets();
  assert.equal(get('xn-dig-results').hidden, false);

  const readsBeforeHiding = { overview: overviewReads, missions: missionReads };
  get('xeno-content').style.display = 'none';
  t.mock.timers.tick(60_000);
  await settle();
  assert.deepEqual({ overview: overviewReads, missions: missionReads }, readsBeforeHiding, 'hidden tabs do not poll');
  get('xeno-content').style.display = '';
  await initXenoTab();
  t.mock.timers.tick(1000);
  await settle();
  assert.equal(overviewReads, readsBeforeHiding.overview + 1, 'returning to the tab refreshes account data even with unchanged missions');
  await checkFleets();
  assert.equal(overviewReads, readsBeforeHiding.overview + 1, 'stable missions do not continuously reload the overview');
  get('xeno-content').style.display = 'none';
  t.mock.timers.tick(1000);
  get('xeno-content').style.display = '';
  await initXenoTab();
  t.mock.timers.tick(1000);
  await settle();
  assert.equal(overviewReads, readsBeforeHiding.overview + 1, 'quick tab switches keep the shared refresh throttle');
  await checkFleets();
  assert.equal(overviewReads, readsBeforeHiding.overview + 2);

  overviewError = 'Temporary overview failure';
  await refreshOverview();
  const readsAfterFailure = overviewReads;
  assert.match(text(get('xn-overview-status')), /Temporary overview failure/);
  overviewError = null;
  await checkFleets();
  assert.equal(overviewReads, readsAfterFailure + 1, 'retry failed overview reads without needing a mission change');
  assert.equal(get('xn-overview-status').textContent, '', 'successful retries clear the visible account status');
  await checkFleets();
  assert.equal(overviewReads, readsAfterFailure + 1, 'successful retries clear the pending refresh');

  overviewError = 'Account refresh unavailable';
  missions = [{ id: 42, missionType: 'xeno_dig', status: 'outbound' }];
  await checkFleets();
  assert.equal(get('xn-dig-panel').hidden, true, 'an in-game launch hides controls even if the account refresh fails');
  assert.equal(get('xn-dig-results').hidden, true);
  assert.equal(get('xn-campaign-state').textContent, 'Dig in progress', 'known missions update the status even when the overview refresh fails');
  overviewError = null;
  for (const status of ['exploring', 'returning']) {
    missions = [{ ...missions[0], status }];
    await checkFleets();
    assert.equal(get('xn-dig-panel').hidden, true, `hide while a dig fleet is ${status}`);
  }
  liveDig = { missionId: 42 };
  missions = [];
  await checkFleets();
  assert.equal(get('xn-dig-panel').hidden, true, 'account liveDig also hides controls without a mission-list entry');
  liveDig = null;
  await refreshOverview();
  assert.equal(get('xn-dig-panel').hidden, false, 'comparison can be rerun after a failed or cancelled dig');
  assert.equal(get('xn-dig-results').hidden, true, 'the dispatched comparison does not reappear in the same session');
  chainId = null;
  await refreshOverview();
  assert.equal(get('xn-dig-panel').hidden, true, 'completed campaign');
  assert.equal(get('xn-campaign-layout').hidden, true);
  assert.equal(get('xn-campaign-context').hidden, true);
  assert.equal(get('xn-campaign-empty').hidden, false);
  assert.match(get('xn-campaign-empty').textContent, /No active campaign/);
  assert.equal(get('xn-account-details').hidden, false, 'account inventory remains visible without a campaign');
  chainId = 6;
  site = { moonId: 11, moonName: 'New Dig Moon' };
  await refreshOverview();
  assert.equal(get('xn-dig-panel').hidden, false, 'new eligible campaign');
  assert.equal(get('xn-dig-results').hidden, true, 'old results must not reappear in the new campaign');
  assert.equal(get('xn-dig-context').textContent, '');
  renderDigComparison({ ...savedComparison, chainId: 6, siteMoonId: 11 });
  assert.equal(get('xn-dig-results').hidden, false);
  paused = true;
  await refreshOverview();
  assert.equal(get('xn-dig-panel').hidden, true, 'paused campaigns cannot dispatch digs');
  paused = false;
  await refreshOverview();
  assert.equal(get('xn-dig-results').hidden, false);
  site = null;
  siteClues = 4;
  clues = 3;
  await refreshOverview();
  assert.equal(cardValue('xn-campaign-stats', 0), '3 / 4 clues', 'use the reported requirement, not a hardcoded third survey');
  assert.equal(get('xn-clue-milestones').children[3].title, 'Dig site: not unlocked');
  codex = { gaze: [1] };
  monuments = null;
  hasResearch = undefined;
  clues = null;
  await refreshOverview();
  assert.equal(cardValue('xn-overview-stats', 0), 'Unknown');
  assert.equal(cardValue('xn-campaign-stats', 0), 'Unknown');
  assert.equal(get('xn-overview-codex').children[0].children[0].children[1].textContent, 'Unknown');
  assert.equal(get('xn-overview-codex').children[0].children[1].children[0].title, 'Stone I: unavailable');
  assert.equal(get('xn-monument-count').textContent, 'Unknown');
  assert.equal(text(get('xn-overview-monuments')), 'Monument inventory unavailable.');
  monuments = [];
  await refreshOverview();
  assert.equal(get('xn-monument-count').textContent, '0 / 12');
  assert.equal(text(get('xn-overview-monuments')), 'No monuments reported.');
  site = { moonId: 11, moonName: 'New Dig Moon' };
  siteClues = 3;
  clues = 5;
  expiresAt = new Date(Date.now() + 32_000).toISOString();
  await refreshOverview();
  assert.match(get('xn-campaign-stats').children.at(-1).textContent, /^Expires in /);
  t.mock.timers.tick(2000);
  assert.equal(get('xn-campaign-stats').children.at(-1).textContent, 'Expired');
  assert.equal(get('xn-dig-panel').hidden, true, 'the existing clock hides comparison on expiry');
  const preserved = await browser.storage.local.get(['xeno_dig_comparison', 'xeno_dig_missions']);
  assert.deepEqual(preserved.xeno_dig_comparison, savedComparison, 'visibility never deletes the saved comparison');
  assert.ok(preserved.xeno_dig_missions[900202].simulation);
  missions = [
    ...Array.from({ length: 4 }, (_, i) => ({ ...survey, id: 100 + i })),
    { id: 200, missionType: 'xeno_dig', status: 'returning' },
    { id: 201, missionType: 'patrol', status: 'patrolling' },
  ];
  await checkFleets();
  assert.equal(get('xn-scan').disabled, false, 'dig and other fleets do not consume survey capacity');
  assert.equal(text(get('xn-survey-limit')), 'Surveys: 4 / 5');
  missions.push({ ...survey, id: 104, status: 'returning' });
  await checkFleets();
  assert.equal(get('xn-scan').disabled, true, 'returning surveys count towards the parallel limit');
  assert.match(get('xn-scan').title, /including returning fleets/);
  assert.match(get('xn-survey-limit').children[0].className, /badge-warning/);
  missions.push({ ...survey, id: 105 });
  await checkFleets();
  assert.equal(get('xn-scan').disabled, true, 'in-game launches above five also block addon launches');
  assert.equal(text(get('xn-survey-limit')), 'Surveys: 6 / 5');
  missions = missions.filter(mission => mission.id < 104 || mission.missionType !== 'xeno_survey');
  await checkFleets();
  assert.equal(get('xn-scan').disabled, false, 'the normal fleet check releases the launch control below five');
  missionError = 'Fleet check unavailable';
  await checkFleets();
  assert.equal(get('xn-scan').disabled, true, 'failed fleet checks must not authorize another survey');
  assert.equal(text(get('xn-survey-limit')), 'Surveys: unknown / 5');
  missionError = null;
  await checkFleets();
  assert.equal(get('xn-scan').disabled, false, 'a successful automatic retry restores verified capacity');
  const classifiedMissions = missions;
  missions = [{}];
  await checkFleets();
  assert.equal(get('xn-scan').disabled, true, 'unclassified fleets cannot be assumed to leave survey capacity');
  assert.equal(text(get('xn-survey-limit')), 'Surveys: unknown / 5');
  missions = classifiedMissions;
  await checkFleets();
  resetXenoTab();
  assert.equal(get('xn-scan').disabled, true, 'server reset invalidates survey capacity');
  assert.equal(get('xn-dig-panel').hidden, true);
  assert.equal(get('xn-dig-results').hidden, true);
});

test('Xeno survey sends full templates without confirmation, validates before searching and preserves Stop', async t => {
  const previous = { document: globalThis.document, browser: globalThis.browser, nexusStorage: globalThis.nexusStorage,
    Option: globalThis.Option };
  let reset;
  t.after(() => {
    reset?.();
    Object.assign(globalThis, previous);
  });
  makeBrowserStub();
  const browser = globalThis.browser;
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.parse('2030-01-20T12:00:00Z') });
  browser.storage.local.onChanged = browser.storage.onChanged;
  const template = { id: 7, name: 'Survey wing', ships: { 2: 1, 16: 1, 8: 3 } };
  await browser.storage.local.set({ fleet_templates: [template] });
  globalThis.nexusStorage = { getSelectedServer: async () => ({ key: 's0' }) };
  const elements = new Map();
  const element = () => ({
    textContent: '', value: '', style: {}, dataset: {}, options: [], children: [], listeners: {},
    addEventListener(type, listener) { this.listeners[type] = listener; },
    setAttribute(name, value) { if (name === 'id') elements.set(value, this); },
    add(option) { this.options.push(option); },
    append(...children) { this.children.push(...children); },
    appendChild(child) { this.children.push(child); },
    replaceChildren(...children) { this.children = children; },
    querySelector(tag) { return get(`archive-${tag}`); },
    remove() {}, focus() {},
  });
  const get = id => {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  };
  const body = element();
  let dialogs = 0;
  body.append = () => { dialogs++; throw new Error('Survey launch must not open a confirmation dialog.'); };
  globalThis.document = { getElementById: get, createElement: element,
    createTextNode: text => ({ textContent: text, children: [] }), body };
  globalThis.Option = function (text, value) { Object.assign(this, { text, value }); };
  get('xn-planet').value = '1';
  get('xn-template').value = '7';
  const survey = id => ({ id, missionType: 'xeno_survey', status: 'exploring' });
  let missions = Array.from({ length: 4 }, (_, i) => survey(i + 1));
  let missionError = null;
  let missionThrows = false;
  let finalCheckFails = false;
  let dispatchThrows = false;
  let missionReads = 0;
  let pauseMoon = true;
  let releaseMoon;
  let campaignZone = 'sentinel';
  const moonDetails = { trace: 'ruins', zone: 'sentinel', cooldownRemainingSeconds: 0 };
  const sent = [];
  const reads = [];
  const scannedSystems = [];
  const systemReads = [];
  let galaxyScans = {};
  let sectorError = null;
  let inventory = { available: { 2: 5, 16: 5, 8: 3 } };
  browser.runtime.sendMessage = async message => {
    reads.push(message.type);
    switch (message.type) {
      case 'GET_PLANETS': return { planets: [{ id: 1, name: 'Home', systemId: 1 }] };
      case 'GET_PLANET_SHIPS': return inventory;
      case 'GET_SHIP_DEFS': return { ships: [
        { shipDefId: 2, key: 'spy_probe', name: 'Spy Probe' },
        { shipDefId: 16, key: 'hacker_ship', name: 'Hacker Ship' },
        { shipDefId: 8, key: 'cruiser', name: 'Cruiser' },
      ] };
      case 'GET_MISSIONS':
        missionReads++;
        if (missionThrows) throw new Error('Fleet transport unavailable');
        return missionError ? { error: missionError } : { missions: structuredClone(missions) };
      case 'GET_XENO_OVERVIEW': return {
        hasResearch: true, reports: [], chain: { id: 1, trace: 'ruins', zone: campaignZone, clues: [] },
        config: { zones: { sentinel: { excavators: 3, massLimit: 45000 } } },
      };
      case 'GET_GALAXY_MAP': return { systems: [
        { id: 1, name: 'Home system', x: 0, y: 0 },
        { id: 3, name: 'Other zone', x: 0.5, y: 0, sectorId: 9, visibility: 'full' },
        { id: 2, name: 'Target system', x: 1, y: 0, sectorId: 9, visibility: 'full' },
      ] };
      case 'GET_SECTOR_SYSTEMS': return sectorError ? { error: sectorError } : { systems: [
        { id: 3, securityZone: 'open' }, { id: 2, securityZone: 'sentinel' },
      ] };
      case 'GET_GALAXY_SCANS': return { scans: galaxyScans };
      case 'GET_SYSTEM_PLANETS':
        scannedSystems.push(message.systemId);
        systemReads.push(message);
        return { moons: [{ id: 20, name: 'Ancient moon', moonType: 'ancient' }] };
      case 'GET_XENO_MOON':
        return pauseMoon ? new Promise(resolve => { releaseMoon = resolve; }) : moonDetails;
      case 'SEND_XENO_SURVEY': {
        sent.push(message);
        if (dispatchThrows) throw new Error('Launch acknowledgement unavailable');
        if (finalCheckFails) return { error: 'Final fleet check unavailable', missionCheckFailed: true };
        const missionSnapshot = { missions: structuredClone(missions) };
        if (missions.length >= 5) return { error: 'Survey limit reached', surveyLimitReached: true, missionSnapshot };
        missions.push(survey(5));
        return { ok: true, data: { missionId: 5 }, missionSnapshot };
      }
      default: throw new Error(`Unexpected request: ${message.type}`);
    }
  };
  const { initXenoTab, resetXenoTab } = await import('../nexus-addon/tabs/xeno.js');
  reset = resetXenoTab;
  const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
  const text = node => [node.textContent, ...(node.children || []).map(text)].filter(Boolean).join(' ');
  const checkFleets = async () => { t.mock.timers.tick(30_000); await settle(); };
  await initXenoTab();
  await settle();
  const launch = () => get('xn-scan').listeners.click();
  const start = reads.length;
  const pending = launch();
  await launch();
  assert.match(text(get('xn-progress')), /already being checked or sent/);
  await settle();
  assert.equal(missionReads, 2, 'a duplicate click does not begin a second launch preflight');
  assert.ok(reads.indexOf('GET_PLANET_SHIPS', start) < reads.indexOf('GET_GALAXY_MAP', start),
    'full template availability is checked before searching');
  assert.equal(get('xn-scan').textContent, 'Stop');
  assert.deepEqual(scannedSystems, [2], 'a nearer system in another zone is excluded before requesting its moons');
  missions.push({ ...survey(5), status: 'returning' });
  releaseMoon(moonDetails);
  await pending;
  assert.equal(sent.length, 1);
  assert.equal(sent[0].serverKey, 's0');
  assert.equal(get('xn-scan').disabled, true, 'a late background limit updates the visible fleet state');
  assert.equal(text(get('xn-survey-limit')), 'Surveys: 5 / 5');
  assert.match(text(get('xn-progress')), /Launch failed: Survey limit reached/);
  assert.equal(dialogs, 0);

  missions.pop();
  await checkFleets();
  pauseMoon = true;
  const searching = launch();
  await settle();
  assert.equal(get('xn-scan').textContent, 'Stop');
  missions.push(survey(5));
  await checkFleets();
  assert.equal(get('xn-scan').disabled, false, 'Stop remains usable even when a fresh check finds five surveys');
  assert.equal(text(get('xn-survey-limit')), 'Surveys: 5 / 5');
  await launch();
  releaseMoon(moonDetails);
  await searching;
  assert.equal(sent.length, 1, 'stopping the search does not dispatch a fleet');
  assert.match(text(get('xn-progress')), /Search stopped/);
  assert.equal(get('xn-scan').disabled, true);

  missions.pop();
  pauseMoon = false;
  await checkFleets();
  await launch();
  assert.equal(sent.length, 2, 'verified capacity allows the fifth fleet');
  assert.deepEqual(sent[1].ships, [
    { shipDefId: 2, quantity: 1 }, { shipDefId: 8, quantity: 3 }, { shipDefId: 16, quantity: 1 },
  ], 'the exact template is sent without trimming or adding ships');
  assert.match(text(get('xn-progress')), /Fleet sent to Ancient moon/);
  assert.equal(get('xn-scan').disabled, true, 'confirmed dispatch refreshes missions before unlocking');
  missionError = 'Fleet check unavailable';
  await launch();
  assert.equal(sent.length, 2, 'an unverifiable initial preflight cannot dispatch');
  assert.equal(get('xn-scan').disabled, true);
  assert.match(text(get('xn-progress')), /Could not check active surveys/);
  missionError = null;
  missions.pop();
  await checkFleets();
  missionThrows = true;
  await launch();
  assert.equal(sent.length, 2, 'thrown fleet transport errors also abort before dispatch');
  assert.equal(get('xn-scan').disabled, true);
  assert.equal(text(get('xn-survey-limit')), 'Surveys: unknown / 5');
  missionThrows = false;
  await checkFleets();
  finalCheckFails = true;
  await launch();
  assert.equal(get('xn-scan').disabled, true, 'failed background preflights invalidate the visible fleet count');
  assert.equal(text(get('xn-survey-limit')), 'Surveys: unknown / 5');
  assert.match(text(get('xn-progress')), /Final fleet check unavailable/);
  finalCheckFails = false;
  await checkFleets();
  dispatchThrows = true;
  await launch();
  assert.equal(get('xn-scan').disabled, true, 'an unconfirmed send cannot immediately be repeated');
  assert.match(text(get('xn-progress')), /Could not confirm survey launch.*Check the game before retrying/);
  dispatchThrows = false;
  await checkFleets();
  globalThis.nexusStorage = { getActiveServer: async () => ({ key: 's0' }) };
  const completeInventory = inventory;
  for (const stock of [
    { available: { 16: 5, 8: 3 } },
    { available: { 2: 5, 8: 3 } },
    { available: { 8: 3 } },
    { available: { 2: 5, 16: 5, 8: 2 } },
    {},
  ]) {
    inventory = stock;
    const count = sent.length;
    const start = reads.length;
    await launch();
    assert.equal(sent.length, count, 'missing ships never send a reduced template');
    assert.equal(reads.slice(start).some(type => ['GET_GALAXY_MAP', 'GET_GALAXY_SCANS', 'GET_XENO_MOON',
      'GET_XENO_OVERVIEW'].includes(type)), false, 'invalid fleets stop before the campaign read and moon search');
    assert.match(text(get('xn-progress')), /Full survey template unavailable|invalid availability response/);
  }
  inventory = completeInventory;
  template.ships = { 2: 1, 8: 3 };
  const count = sent.length;
  const invalidTemplateStart = reads.length;
  await launch();
  assert.equal(sent.length, count, 'required ships on the planet are not silently added to a template');
  assert.equal(reads.slice(invalidTemplateStart).includes('GET_PLANET_SHIPS'), false);
  assert.match(text(get('xn-progress')), /Missing: Hacker Ship/);
  assert.equal(dialogs, 0, 'neither valid nor invalid survey launches show a confirmation dialog');
  template.ships = { 2: 1, 16: 1, 8: 3 };
  sectorError = 'Sector unavailable';
  const beforeSectorError = scannedSystems.length;
  await launch();
  assert.equal(sent.length, count, 'an unverifiable system zone cannot launch a survey');
  assert.equal(scannedSystems.length, beforeSectorError, 'sector failure stops before any moon scan');
  assert.match(text(get('xn-progress')), /Could not search for Xeno moons: Could not check sector 9: Sector unavailable/);
  sectorError = null;
  campaignZone = 'open';
  moonDetails.zone = 'open';
  const beforeOpen = scannedSystems.length;
  await launch();
  assert.deepEqual(scannedSystems.slice(beforeOpen), [3], 'an Open campaign scans the Open system, not Sentinel');
  assert.equal(sent.length, count + 1);
  assert.equal(systemReads.at(-1).purpose, 'static', 'missing moon data uses a static lookup');
  assert.equal(systemReads.at(-1).group, 'moons');

  const moon = { id: 20, name: 'Ancient moon', moonType: 'ancient' };
  for (const metadata of [
    { times: { moons: 1 }, ownership: { moons: 1 } },
    { times: {}, ownership: {}, publicGroups: ['moons'] },
  ]) {
    missions.pop();
    await checkFleets();
    galaxyScans = { 3: { data: { moons: [moon], _galaxyCache: metadata } } };
    const systemCount = systemReads.length;
    const moonCount = reads.filter(type => type === 'GET_XENO_MOON').length;
    const sendCount = sent.length;
    await launch();
    assert.equal(systemReads.length, systemCount, 'stored moon types do not require fresh ownership');
    assert.equal(reads.filter(type => type === 'GET_XENO_MOON').length, moonCount + 1,
      'cached candidates still require a Xeno detail lookup');
    assert.equal(sent.length, sendCount + 1);
  }
  missions.pop();
  await checkFleets();
  moonDetails.cooldownRemainingSeconds = 60;
  const beforeCooldown = sent.length;
  await launch();
  assert.equal(sent.length, beforeCooldown, 'cached Ancient moons with an active server cooldown are not sent');
  assert.match(text(get('xn-progress')), /No eligible Ancient moon found/);
});

test('dig comparison displays ranked results, recorded mode and compact losses with standard action buttons', async t => {
  const original = globalThis.document;
  t.after(() => { globalThis.document = original; });
  const element = tag => ({
    tag,
    children: [], textContent: '', className: '', attributes: {}, listeners: {},
    append(...children) { this.children.push(...children); },
    appendChild(child) { this.children.push(child); },
    replaceChildren(...children) { this.children = children; },
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(type, fn) { this.listeners[type] = fn; },
    focus() { this.focused = true; },
  });
  const results = element();
  const context = element();
  globalThis.document = { getElementById: id => id === 'xn-dig-results' ? results : context, createElement: element };
  const { renderDigComparison } = await import('../nexus-addon/tabs/xeno.js');
  const entry = (outcome, viable) => ({
    entrance: 'Main (ruins)', candidate: { label: 'Fleet', mass: 100 },
    result: { outcome, viable, excavators: 1, destroyed: 1, damaged: 2,
      losses: [{ name: 'Cruiser', destroyed: 1, damaged: 2 }] },
  });
  const scaledEntry = entry('attacker_won', false);
  scaledEntry.result.scaled = true;
  const snapshot = {
    planet: 'Home', zone: 'sentinel', chainId: 1, at: 0, massLimit: 45000, leadership: true, mode: 'fast',
    results: [entry('defender_won', false), scaledEntry, entry('attacker_won', true)],
  };
  renderDigComparison(snapshot);
  const panel = results.children[0];
  const scroll = panel.children[0];
  assert.equal(scroll.tabIndex, 0);
  assert.equal(scroll.attributes.role, 'region');
  assert.equal(scroll.attributes['aria-label'], 'Dig fleet comparison results');
  assert.match(scroll.className, /\bexplore-military-table-scroll\b/);
  assert.match(panel.className, /\bexplore-military-table-panel\b/);
  assert.equal(context.textContent, '', 'a snapshot without an active campaign has no visible context');
  assert.equal(results.hidden, true);
  assert.equal(panel.children[1].children[0].textContent, '3 comparisons');
  assert.equal(panel.children[1].children[1].hidden, true);
  const table = scroll.children[0];
  const header = table.children[0].children[0];
  assert.deepEqual(header.children.map(cell => cell.textContent),
    ['Result', 'Entrance', 'Fleet', 'Leadership vessel', 'Mode', 'Excavators survived', 'Estimated mass', 'Destroyed', 'Damaged', 'Action']);
  const rows = table.children[1].children;
  const badges = rows.map(row => row.children[0].children[0]);
  assert.deepEqual(badges.map(badge => [badge.textContent, badge.className]), [
    ['Victory', 'badge badge-success xeno-dig-outcome'],
    ['Defeat', 'badge badge-error xeno-dig-outcome'],
    ['Victory · too few excavators', 'badge badge-warning xeno-dig-outcome'],
  ]);
  assert.equal(rows[2].children[0].children[1].textContent, 'Scaled estimate');
  const trace = rows[0].children[1].children[1];
  assert.equal(trace.textContent, 'Ruins');
  assert.equal(trace.className, 'badge finder-trace finder-trace-ruins');
  assert.deepEqual(rows.map(row => row.children[3].textContent), ['Yes', 'Yes', 'Yes']);
  assert.deepEqual(rows.map(row => [row.children[4].children[0].textContent, row.children[4].children[0].className]),
    [['Fast', 'badge'], ['Fast', 'badge'], ['Fast', 'badge']]);
  assert.equal(rows[0].children[7].textContent, '1');
  assert.equal(rows[0].children[8].textContent, '2');
  assert.equal(rows[0].children[7].children.length, 0, 'loss totals have no expandable details');
  assert.equal(rows[0].children[9].children[0].className, 'toolbar-button primary-button');
  renderDigComparison({ ...snapshot, mode: undefined }, true);
  assert.equal(results.children[0].children[0].children[0].children[1].children[0].children[4].children[0].textContent, 'Unknown');
  renderDigComparison({ ...snapshot, launchSimulation: { mode: 'careful' } }, true);
  assert.equal(results.children[0].children[0].children[0].children[1].children[0].children[4].children[0].textContent, 'Careful');
  renderDigComparison({ ...snapshot, leadership: false }, true);
  assert.equal(results.children[0].children[0].children[0].children[1].children[0].children[3].textContent, 'No');
  renderDigComparison({ ...snapshot, leadership: undefined }, true);
  assert.equal(results.children[0].children[0].children[0].children[1].children[0].children[3].textContent, 'Unknown');
  renderDigComparison({ ...snapshot, results: [entry('draw', false), entry('future_loss', false)] }, true);
  assert.deepEqual(results.children[0].children[0].children[0].children[1].children.map(
    row => [row.children[0].children[0].textContent, row.children[0].children[0].className],
  ), [['Draw', 'badge badge-warning xeno-dig-outcome'], ['Future loss', 'badge xeno-dig-outcome']]);
  renderDigComparison({ ...snapshot, results: Array.from({ length: 26 }, () => entry('attacker_won', true)) });
  let controls = results.children[0].children[1].children[1];
  assert.equal(controls.hidden, false);
  assert.equal(results.children[0].children[0].children[0].children[1].children.length, 25);
  controls.children[2].listeners.click();
  controls = results.children[0].children[1].children[1];
  assert.equal(controls.children[1].textContent, 'Page 2 / 2');
  assert.equal(controls.children[0].focused, true);
  assert.equal(results.children[0].children[0].children[0].children[1].children.length, 1);
  await setSettings({ 'general.tablePageSize': 30 });
  assert.equal(results.children[0].children[1].children[1].hidden, true);
  assert.equal(results.children[0].children[0].children[0].children[1].children.length, 26);
  await setSettings({ 'general.tablePageSize': 25 });
});

test('dig launch requires confirmation and fresh state before sending the compared fleet', async t => {
  const previous = { document: globalThis.document, browser: globalThis.browser, nexusStorage: globalThis.nexusStorage };
  t.after(() => Object.assign(globalThis, previous));
  makeBrowserStub();
  const elements = new Map();
  const element = () => ({
    children: [], textContent: '', className: '', style: {}, value: '', options: [], listeners: {},
    append(...children) { this.children.push(...children); },
    appendChild(child) { this.children.push(child); },
    replaceChildren(...children) { this.children = children; },
    setAttribute() {}, addEventListener(type, fn) { this.listeners[type] = fn; },
    add(option) { this.options.push(option); },
    querySelector(tag) { return get(`archive-${tag}`); },
    remove() {}, focus() {},
  });
  const get = id => {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  };
  let approve = false;
  const body = element();
  body.append = overlay => {
    const buttons = overlay.children[0].children[1].children;
    setImmediate(() => buttons[approve ? 1 : 0].onclick());
  };
  globalThis.document = { getElementById: get, createElement: element, body };
  const oldOption = globalThis.Option;
  t.after(() => { globalThis.Option = oldOption; });
  globalThis.Option = function (text, value) { Object.assign(this, { text, value }); };
  get('xn-dig-mode').value = 'careful';
  const stored = {};
  let failConfirmedSave = false;
  globalThis.nexusStorage = {
    getSelectedServer: async () => ({ key: 's0' }),
    forServer: () => ({ set: async value => {
      if (failConfirmedSave && value.xeno_dig_comparison.launchedMissionId) throw new Error('Storage unavailable');
      Object.assign(stored, structuredClone(value));
    } }),
  };
  const garrison = [{ key: 'xeno_golem', quantity: 9 }];
  const overview = {
    liveDig: { status: 'outbound' }, config: { zones: { sentinel: { excavators: 3, massLimit: 45000 } }, modes: { careful: {} } },
    chain: { id: 5, site: { moonId: 10, moonName: 'Moon' }, zone: 'sentinel', trace: 'ruins',
      expiresAt: '2099-01-01T00:00:00Z', garrison: [], sideEntrances: [{ trace: 'spire', garrison }] },
  };
  const definitions = [
    { id: 12, key: 'missile_cruiser', name: 'Missile Cruiser', hp: 1000, shipSize: 'large' },
    { id: 29, key: 'excavator', name: 'Excavator', hp: 400, shipSize: 'large' },
  ];
  const sent = [];
  let rejectLaunch = false;
  globalThis.browser.runtime.sendMessage = async message => {
    if (message.type === 'GET_XENO_OVERVIEW') return overview;
    if (message.type === 'GET_PLANET_SHIPS') return { available: { 12: 40, 29: 3 } };
    if (message.type === 'SIM_BOOTSTRAP') return { playerShips: definitions };
    if (message.type === 'GET_MISSIONS') return { missions: [] };
    if (message.type === 'SEND_XENO_DIG') {
      sent.push(message);
      if (rejectLaunch) return { error: 'Dispatch rejected' };
      return { ok: true, data: { missionId: 1, arrivesAt: '2099-01-01T00:00:00Z' } };
    }
    throw new Error(`Unexpected request: ${message.type}`);
  };
  const entry = { entrance: 'Side (spire)', entranceId: 'spire', garrison,
    candidate: { label: 'Fleet', mass: 41200, fleet: [{ shipDefId: 12, quantity: 40 }, { shipDefId: 29, quantity: 3 }] },
    result: { outcome: 'attacker_won', viable: true, excavators: 3, destroyed: 0, damaged: 0, losses: [] } };
  const snapshot = { complete: true, serverKey: 's0', planet: 'Home', planetId: 1, siteMoonId: 10,
    siteName: 'Moon', zone: 'sentinel', chainId: 5, at: 0, massLimit: 45000, leadership: false, results: [entry] };
  const { renderDigComparison, resetXenoTab } = await import('../nexus-addon/tabs/xeno.js');
  renderDigComparison(snapshot);
  const send = () => get('xn-dig-results').children[0].children[0].children[0].children[1].children[0].children[9].children[0];
  const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
  send().listeners.click();
  await settle();
  assert.equal(sent.length, 0);
  assert.equal(snapshot.launchAttempted, undefined);
  approve = true;
  send().listeners.click();
  await settle();
  assert.equal(sent.length, 0);
  assert.match(get('xn-dig-launch-status').children.at(-1).textContent, /already active/);
  overview.liveDig = null;
  send().listeners.click();
  await settle();
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].ships, entry.candidate.fleet);
  assert.equal(sent[0].entrance, 'spire');
  assert.equal(stored.xeno_dig_comparison.launchAttempted, true);
  assert.equal(stored.xeno_dig_comparison.launchedMissionId, 1);
  assert.deepEqual(stored.xeno_dig_comparison.launchSimulation, { ...entry, mode: 'careful' });
  assert.equal(get('xn-dig-results').children[0].children[0].children[0].children[1].children[0].children[4].children[0].textContent, 'Careful');
  assert.equal(send().disabled, true);
  assert.equal(get('xn-dig-panel').hidden, true, 'a confirmed addon launch hides the controls before a fleet refresh');
  assert.equal(get('xn-dig-results').hidden, true);
  assert.match(get('xn-dig-launch-status').textContent, /Dig fleet sent/);
  resetXenoTab();
  rejectLaunch = true;
  const rejected = { ...snapshot, launchAttempted: false, launchedMissionId: undefined };
  renderDigComparison(rejected);
  send().listeners.click();
  await settle();
  assert.equal(rejected.launchedMissionId, undefined, 'a rejected dispatch is not a confirmed launch');
  assert.match(get('xn-dig-launch-status').children.at(-1).textContent, /Dig launch failed: Dispatch rejected/);

  resetXenoTab();
  rejectLaunch = false;
  failConfirmedSave = true;
  const confirmationLog = t.mock.method(console, 'error', () => {});
  const accepted = { ...snapshot, launchAttempted: false, launchedMissionId: undefined };
  renderDigComparison(accepted);
  send().listeners.click();
  await settle();
  assert.equal(accepted.launchedMissionId, 1, 'storage failure must not undo an accepted game launch');
  assert.equal(get('xn-dig-panel').hidden, true);
  assert.equal(get('xn-dig-results').hidden, true);
  assert.match(get('xn-dig-launch-status').children.at(-1).textContent, /Dig fleet sent.*Storage unavailable.*Do not resend/);
  assert.equal(confirmationLog.mock.callCount(), 1);
  resetXenoTab();

  failConfirmedSave = false;
  overview.chain.trace = 'spire';
  overview.chain.garrison = garrison;
  overview.chain.sideEntrances = [{ trace: 'ruins', garrison: [{ key: 'xeno_golem', quantity: 23 }] }];
  const mainEntry = { ...entry, entrance: 'Main (spire)', entranceId: 'main' };
  const mainSnapshot = { ...snapshot, launchAttempted: false, launchedMissionId: undefined, results: [mainEntry] };
  renderDigComparison(mainSnapshot);
  assert.equal(send().disabled, false, 'a viable main-entrance comparison permits confirmation');
  send().listeners.click();
  await settle();
  assert.equal(sent.at(-1).entrance, 'main', 'the main entrance sends its ID, not its guardian trace');
  assert.deepEqual(sent.at(-1).ships, mainEntry.candidate.fleet);
  assert.deepEqual(stored.xeno_dig_comparison.launchSimulation, { ...mainEntry, mode: 'careful' });
  assert.equal(mainSnapshot.launchedMissionId, 1);
  assert.equal(send().disabled, true);
  resetXenoTab();
});
