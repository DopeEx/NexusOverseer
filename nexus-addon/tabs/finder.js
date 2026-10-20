// Planet Finder tab: galaxy map, filters, scan loop.

import { cssVar, setStatusText } from '../common.js';
import { loadGalaxyScans, getSystemPlanets } from '../galaxy-client.js';
import { systemCacheFresh, readSavedCatalog } from '../galaxy-cache.js';
import { buildGalaxyDirectory, DIRECTORY_RANGES, directoryOwner, directoryOwnership, hasKnownOwnership, matchesSearchMoon, moonsByPlanet, parseSectorRange, planetSlots, queryGalaxyDirectory, systemBodyRows } from '../galaxy-directory.js';
import { appendGalaxyImage } from '../galaxy-images.js';

// ── Planet Finder tab ──────────────────────────────────────────────────────

export let galaxySystems = null;     // full /api/galaxy/map systems array

export let finderArms = null;

export let finderInited = false;
let ownershipRunning = false;
let finderGeneration = 0;
const finderZones = new Set();
const searchTypes = { types: [], moonTypes: [] };
const PLANET_TYPES = ['rocky', 'crystalline', 'gas_giant', 'ice', 'terra', 'volcanic'];
const MOON_TYPES = ['barren', 'metallic', 'icy', 'volcanic', 'hollow', 'ancient'];
const LAST_SEARCH_KEY = 'galaxy_last_search';
let finderServerKey = null;
let galaxyCatalogReadAt = 0;
let mapHomeSystemId = null;
let mapPlayerName = null;
let mapMatches = [];
let mapActiveMatch = -1;
let mapInfoSystemId = null;
let mapDragged = false;
let mapStationsVisible = false;
let mapHubsVisible = true;
let mapAllianceVisible = true;
let mapStations = [];
let mapStationsRead = 0;
const mapPoints = new Map();
const MAP_OWN_COLOR = '#38bdf8';
const MAP_ALLY_COLOR = '#7ee787';
const MAP_HIT_COLOR = '#f0883e';
const MAP_ZONE_COLORS = { sentinel: '#22c55e', open: '#f59e0b', dead: '#ef4444', rift: '#7c3aed' };
const MAP_STAR_COLORS = {
  yellow: '#fbbf24', red_dwarf: '#ef4444', blue_giant: '#60a5fa',
  orange: '#f97316', white_dwarf: '#e2e8f0', neutron: '#c084fc',
};
let mapZonesVisible = true;
let mapSize = null;
let lastSearch = null;
let searchStorageQueue = Promise.resolve();
let clearingSearch = false;
let finderScans = {};
let finderView = 'map';
let searchSummary = '';
let directoryError = '';
let directoryRead = 0;
const directoryStates = {};
let overviewSystemId = null;
let overviewSourceGroup = null;
let overviewSourceId = null;
let galaxyImageOrigin = null;
let directoryFilterKey = '';
const finderViews = ['map', 'search', 'systems', 'planets', 'moons'];
const isDirectoryView = () => ['systems', 'planets', 'moons'].includes(finderView);

function setToggleState(button, selected) {
  button.setAttribute('aria-pressed', String(selected));
  button.classList.toggle('is-selected', selected);
}

function directoryState() {
  return directoryStates[finderView] ||= {
    text: '', zones: [], types: [], ownership: '', arm: '', origin: '', ranges: {},
    sector: '', contents: '', moonTypes: [], parentTypes: [], minFreeMoonSlots: '',
    advancedOpen: false, invalidNumbers: [], sort: 'distance', direction: 1, page: 0,
  };
}

export function resetFinderTab() {
  finderGeneration++;
  finderServerKey = null;
  galaxyCatalogReadAt = 0;
  mapHomeSystemId = null;
  mapPlayerName = null;
  mapStationsVisible = false;
  mapHubsVisible = true;
  mapAllianceVisible = true;
  for (const id of ['f-map-hubs', 'f-map-alliance']) {
    setToggleState(document.getElementById(id), true);
  }
  mapStations = [];
  mapStationsRead++;
  setToggleState(document.getElementById('f-map-stations'), false);
  document.getElementById('f-map-stations').disabled = false;
  mapPoints.clear();
  document.getElementById('f-map-labels').textContent = '';
  mapZonesVisible = true;
  setToggleState(document.getElementById('f-map-zones'), true);
  mapView.scale = 1;
  mapView.ox = 0;
  mapView.oy = 0;
  mapPan = null;
  document.getElementById('f-tooltip').style.display = 'none';
  document.getElementById('f-map-search').value = '';
  document.getElementById('f-map-systems').textContent = '';
  closeMapSuggestions();
  mapMatches = [];
  document.getElementById('f-map-search-clear').hidden = true;
  setStatusText(document.getElementById('f-map-match-status'), '');
  document.getElementById('f-map-home').disabled = true;
  setStatusText(document.getElementById('f-map-navigation-status'), '');
  lastSearch = null;
  galaxyImageOrigin = null;
  closeSystemOverview();
  finderRunning = false;
  ownershipRunning = false;
  finderInited = false;
  galaxySystems = null;
  finderZones.clear();
  searchTypes.types = [];
  searchTypes.moonTypes = [];
  drawSearchTypeFilters();
  for (const id of ['f-min-size', 'f-min-moons', 'f-min-moon-slots']) document.getElementById(id).value = '0';
  for (const id of ['f-min-planet-slots', 'f-max-distance', 'f-ownership']) document.getElementById(id).value = '';
  document.getElementById('f-exclude-mine').checked = false;
  finderSort = { key: 'size', dir: -1 };
  setStatusText(document.getElementById('f-search-storage-status'), '');
  document.getElementById('f-clear-search').disabled = true;
  finderArms = null;
  finderHits = [];
  finderScans = {};
  document.getElementById('f-search-issues').hidden = true;
  document.getElementById('f-search-issues-list').textContent = '';
  searchSummary = '';
  directoryError = '';
  directoryRead++;
  directoryFilterKey = '';
  for (const key of Object.keys(directoryStates)) delete directoryStates[key];
  document.getElementById('f-directory-scope').value = 'all';
  document.getElementById('f-directory-filter').value = '';
  for (const id of ['head', 'body', 'summary', 'page']) document.getElementById(`f-directory-${id}`).textContent = '';
  void selectFinderView('map');
  hitSystems = {};
  mapBounds = null;
  homeSys = null;
  myPlanets = [];
  myUserId = null;
  myOwnedSystems = new Set();
  myAllianceTag = null;
  allianceMemberIds = new Set();
  allianceSystems = {};
  galaxyHubs = [];
  selectedSystemId = null;
  document.getElementById('f-search').textContent = 'Search';
  document.getElementById('f-search').disabled = false;
  document.getElementById('f-check-ownership').textContent = 'Check result ownership';
  document.getElementById('f-check-ownership').disabled = true;
  setStatusText(document.getElementById('f-ownership-progress'), '');
  renderFinderResults();
}

export let finderRunning = false;

export let finderHits = [];          // matching planets

export let hitSystems = {};          // systemId → {x, y, screenX, screenY, planets: []}

export let mapBounds = null;

export let homeSys = null;           // {x, y} of the origin system, for distance

export let myPlanets = [];           // player's planets with system coords, for the origin selector

export let myUserId = null;          // player's user id, for "exclude mine"

export let mapView = { scale: 1, ox: 0, oy: 0 };   // pan/zoom transform on the map

export let selectedSystemId = null;  // system focused from a results row

export let myOwnedSystems = new Set();   // system ids where you own a planet

export let myAllianceTag = null;         // your alliance tag (e.g. "SWORD")

export let allianceMemberIds = new Set();// userIds of your alliance members

export let allianceSystems = {};         // systemId → owner name (alliance, found while scanning)

export let galaxyHubs = [];              // market hubs: {name, x, y}


export async function initFinderTab() {
  if (finderInited) return;
  finderInited = true;
  if (!searchSummary) document.getElementById('f-directory-scope').value = 'all';
  const status = document.getElementById('f-map-status');
  const initializationStatus = text => {
    setStatusText(status, text);
    if (!searchSummary) setStatusText(document.getElementById('f-progress'), text);
  };
  const generation = finderGeneration;
  initializationStatus('Loading galaxy map…');
  let responses;
  try {
    responses = await Promise.all([
      browser.runtime.sendMessage({ type: 'GET_ARMS' }),
      browser.runtime.sendMessage({ type: 'GET_GALAXY_MAP' }),
      browser.runtime.sendMessage({ type: 'GET_AUTH_ME' }),
      browser.runtime.sendMessage({ type: 'GET_ALLIANCE' }),
      browser.runtime.sendMessage({ type: 'GET_HUBS' }),
      globalThis.nexusStorage.getActiveServer(),
    ]);
  } catch (error) {
    if (generation !== finderGeneration) return;
    finderInited = false;
    initializationStatus(`Galaxy initialization failed: ${error.message}`);
    return;
  }
  if (generation !== finderGeneration) return;
  const [arms, map, me, ally, hubs, server] = responses;
  finderServerKey = server.key;
  galaxyImageOrigin = server.origin;
  if (arms.error || map.error) {
    initializationStatus(`Error: ${arms.error || map.error}`);
    finderInited = false;
    return;
  }
  finderArms = arms.arms || [];
  galaxySystems = map.systems || [];
  galaxyCatalogReadAt = map._galaxyCatalogAt || 0;
  await updateGalaxyDeltaFlags(generation);
  if (generation !== finderGeneration) return;

  // Origin reference for distance + "exclude mine". auth/me carries per-planet
  // system coords, so the user can pick any of their planets as the origin.
  if (me && !me.error) {
    myUserId = me.user?.id ?? null;
    mapPlayerName = me.user?.username || null;
    myOwnedSystems = new Set((me.planets || []).map(p => p.systemId).filter(x => x != null));
    myPlanets = (me.planets || []).filter(p => p.systemX != null && p.systemY != null);
    const osel = document.getElementById('f-origin');
    osel.textContent = '';
    for (const p of myPlanets) {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = `${p.name} (${p.systemName || p.systemId})`;
      osel.appendChild(o);
    }
    const def = myPlanets.find(p => p.isHomeworld) || myPlanets[0];
    if (def) { osel.value = def.id; homeSys = { x: def.systemX, y: def.systemY }; }
    mapHomeSystemId = (me.planets || []).find(planet => planet.isHomeworld)?.systemId ?? null;
  }
  document.getElementById('f-map-home').disabled = !galaxySystems.some(system =>
    system.id === mapHomeSystemId && Number.isFinite(system.x) && Number.isFinite(system.y));
  document.getElementById('f-map-home').title = document.getElementById('f-map-home').disabled
    ? 'Homeworld system is not available in known galaxy data.' : 'Center on your homeworld, independently of the search origin.';
  if (me?.error || ally?.error) setStatusText(document.getElementById('f-map-navigation-status'),
    [me?.error ? `Own colonies unavailable: ${me.error}` : '', ally?.error ? `Alliance unavailable: ${ally.error}` : ''].filter(Boolean).join(' · '));
  updateMapSystemChoices();
  if (ally && !ally.error) {
    myAllianceTag = ally.tag || null;
    allianceMemberIds = new Set(ally.memberIds || []);
  }
  if (hubs && !hubs.error) {
    galaxyHubs = (hubs.hubs || [])
      .filter(h => h.systemX != null && h.systemY != null)
      .map(h => ({ name: h.name, x: h.systemX, y: h.systemY }));
  }

  const sel = document.getElementById('f-arm');
  sel.textContent = '';
  for (const a of finderArms) {
    const o = document.createElement('option');
    o.value = a.id;
    o.textContent = a.name;
    sel.appendChild(o);
  }
  const allArmsOption = document.createElement('option');
  allArmsOption.value = 'all';
  allArmsOption.textContent = 'All arms';
  sel.appendChild(allArmsOption);
  sel.value = 'all';
  updateSectorInput();

  // Zone filter from the distinct security zones present on the map.
  drawFinderZones();
  drawSearchTypeFilters();

  setStatusText(status, `${galaxySystems.length} known systems`);
  if (!searchSummary) setStatusText(document.getElementById('f-progress'), 'Ready to search saved knowledge.');
  document.getElementById('f-clear-search').disabled = false;
  await restoreLastSearch(generation);
  if (generation !== finderGeneration) return;
  if (!lastSearch) try {
    const scans = await loadGalaxyScans();
    if (generation !== finderGeneration) return;
    finderScans = scans;
  } catch (error) {
    if (generation !== finderGeneration) return;
    console.error('[NexusOverseer] Could not load map ownership:', error);
    setStatusText(document.getElementById('f-map-navigation-status'), `Map ownership could not be loaded: ${error.message}`);
  }
  renderFinderDirectory();
  renderFinderResults();
  renderFinderDirectory();
  drawGalaxyMap();
}

browser.storage.local.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.nexus_active_server) {
    resetFinderTab();
    void initFinderTab();
  } else if (area === 'local' && changes.galaxy_delta_revision && galaxySystems) {
    void updateGalaxyDeltaFlags(finderGeneration);
  } else if (area === 'local' && changes.galaxy_system_revision && galaxySystems) {
    void updateGalaxySystemData(finderGeneration);
  } else if (area === 'local' && changes.galaxy_public_revision && galaxySystems) {
    void updatePublicGalaxyData(finderGeneration);
  }
});

async function updatePublicGalaxyData(generation) {
  try {
    const [map, arms, hubs, stations] = await Promise.all([
      readSavedCatalog(finderServerKey, '/api/galaxy/map'),
      readSavedCatalog(finderServerKey, '/api/galaxy/arms'),
      readSavedCatalog(finderServerKey, '/api/market/hubs'),
      mapStationsVisible ? readSavedCatalog(finderServerKey, '/api/galaxy/station-index') : null,
    ]);
    if (generation !== finderGeneration) return;
    galaxySystems = map.systems;
    galaxyCatalogReadAt = map._galaxyCatalogAt || 0;
    await updateGalaxyDeltaFlags(generation);
    if (generation !== finderGeneration) return;
    finderArms = arms.arms;
    const selection = document.getElementById('f-arm').value;
    const selector = document.getElementById('f-arm');
    selector.textContent = '';
    for (const arm of [...finderArms, { id: 'all', name: 'All arms' }]) {
      const option = document.createElement('option');
      option.value = arm.id;
      option.textContent = arm.name;
      selector.appendChild(option);
    }
    selector.value = selection;
    galaxyHubs = hubs.hubs.filter(hub => Number.isFinite(hub.systemX) && Number.isFinite(hub.systemY))
      .map(hub => ({ name: hub.name, x: hub.systemX, y: hub.systemY }));
    mapBounds = null;
    updateMapSystemChoices();
    setStatusText(document.getElementById('f-map-status'), `${galaxySystems.length} known systems · public base data available`);
    if (stations) mapStations = stations.stations;
    drawFinderZones();
    await updateGalaxySystemData(generation);
  } catch (error) {
    console.warn('[NexusOverseer] Public galaxy display update failed:', error);
    setStatusText(document.getElementById('f-map-navigation-status'), `Public data display failed: ${error.message}`);
  }
}

async function updateGalaxySystemData(generation) {
  try {
    const scans = await loadGalaxyScans();
    if (generation !== finderGeneration) return;
    updateSavedScans(scans);
    renderFinderResults();
    renderFinderDirectory();
    drawGalaxyMap();
    if (overviewSystemId != null) openSystemOverview(overviewSystemId, overviewSourceGroup, overviewSourceId);
  } catch (error) {
    if (generation !== finderGeneration) return;
    console.error('[NexusOverseer] Could not load updated galaxy data:', error);
    setStatusText(document.getElementById('f-search-storage-status'), `Updated galaxy data could not be loaded: ${error.message}`);
  }
}

function updateSavedScans(scans) {
  finderScans = scans;
  const hitsBySystem = new Map();
  for (const hit of finderHits) {
    if (!hitsBySystem.has(hit.systemId)) hitsBySystem.set(hit.systemId, []);
    hitsBySystem.get(hit.systemId).push(hit);
  }
  for (const [systemId, hits] of hitsBySystem) {
    if (scans[systemId]) updateResultOwnership(systemId, scans[systemId].data, hits);
  }
}

async function updateGalaxyDeltaFlags(generation) {
  try {
    const response = await browser.runtime.sendMessage({ type: 'GET_GALAXY_DELTAS' });
    if (response.error) throw new Error(response.error);
    if (generation !== finderGeneration) return;
    const systemsById = new Map(galaxySystems.map(system => [system.id, system]));
    for (const delta of response.deltas) {
      const system = systemsById.get(delta.systemId);
      if (system && (delta.at > galaxyCatalogReadAt || !Object.hasOwn(system, 'hasColonies'))) {
        system.hasColonies = true;
        system.colonyStateObservedAt = delta.at;
      }
    }
    if (overviewSystemId != null) updateOverviewColonyState();
  } catch (error) {
    if (generation !== finderGeneration) return;
    console.error('[NexusOverseer] Could not load galaxy live state:', error);
    setStatusText(document.getElementById('f-search-storage-status'), `Galaxy live state could not be loaded: ${error.message}`);
  }
}

export async function selectFinderView(view) {
  if (!finderViews.includes(view)) return;
  closeMapInfo();
  finderView = view;
  const read = ++directoryRead;
  const generation = finderGeneration;
  for (const name of finderViews) {
    const button = document.getElementById(`f-tab-${name}`);
    button.classList.toggle('active', name === view);
    button.setAttribute('aria-selected', String(name === view));
    button.tabIndex = name === view ? 0 : -1;
  }
  document.getElementById('f-map-panel').hidden = view !== 'map';
  document.getElementById('f-search-panel').hidden = view !== 'search';
  const panel = document.getElementById('f-directory');
  panel.hidden = !isDirectoryView();
  if (!isDirectoryView()) { renderFinderResults(); if (view === 'map') drawGalaxyMap(); return; }
  panel.setAttribute('aria-labelledby', `f-tab-${view}`);
  document.getElementById('f-directory-title').textContent = view[0].toUpperCase() + view.slice(1);
  document.getElementById('f-directory-filter').value = directoryState().text;
  directoryError = '';
  renderFinderDirectory();
  if (finderRunning || ownershipRunning) return;
  try {
    const scans = await loadGalaxyScans();
    if (generation !== finderGeneration || read !== directoryRead) return;
    updateSavedScans(scans);
    renderFinderResults();
  } catch (error) {
    if (generation !== finderGeneration || read !== directoryRead) return;
    directoryError = `Local galaxy data could not be loaded: ${error.message}`;
    renderFinderDirectory();
  }
}

for (const [index, view] of finderViews.entries()) {
  const button = document.getElementById(`f-tab-${view}`);
  button.addEventListener('click', () => selectFinderView(view));
  button.addEventListener('keydown', event => {
    let next;
    if (event.key === 'ArrowRight') next = (index + 1) % finderViews.length;
    if (event.key === 'ArrowLeft') next = (index + finderViews.length - 1) % finderViews.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = finderViews.length - 1;
    if (next === undefined) return;
    event.preventDefault();
    document.getElementById(`f-tab-${finderViews[next]}`).focus();
    void selectFinderView(finderViews[next]);
  });
}

document.getElementById('f-directory-filter').addEventListener('input', event => {
  directoryState().text = event.target.value;
  directoryState().page = 0;
  renderFinderDirectory();
});
document.getElementById('f-directory-scope').addEventListener('change', () => {
  for (const state of Object.values(directoryStates)) state.page = 0;
  renderFinderDirectory();
});
document.getElementById('f-directory-ownership').addEventListener('change', event => {
  if (finderView === 'systems') return;
  directoryState().ownership = event.target.value;
  directoryState().page = 0;
  renderFinderDirectory();
});
document.getElementById('f-directory-more').addEventListener('toggle', event => {
  if (isDirectoryView()) directoryState().advancedOpen = event.target.open;
});
document.getElementById('f-directory-reset').addEventListener('click', () => {
  const { sort, direction, advancedOpen } = directoryState();
  delete directoryStates[finderView];
  Object.assign(directoryState(), { sort, direction, advancedOpen });
  directoryFilterKey = '';
  document.getElementById('f-directory-filter').value = '';
  renderFinderDirectory();
});
for (const [id, step] of [['prev', -1], ['next', 1]]) {
  document.getElementById(`f-directory-${id}`).addEventListener('click', () => {
    directoryState().page += step;
    renderFinderDirectory();
  });
}

function typeBadge(value, group) {
  const badge = document.createElement('span');
  const types = {
    yellow: 'gold', orange: 'orange', red_dwarf: 'red', blue_giant: 'blue', white_dwarf: 'neutral', neutron: 'purple',
  };
  const moonType = MOON_TYPES.includes(value);
  const color = group === 'systems' && Object.hasOwn(types, value) ? types[value] : 'neutral';
  badge.className = `finder-badge ${group === 'moons' && moonType ? `finder-moon-${value}` : `finder-type-${color}`}`;
  badge.textContent = value == null ? 'unknown' : String(value).replace(/_/g, ' ');
  return badge;
}

function ownershipBadge(status, owner) {
  const badge = document.createElement('span');
  badge.className = `finder-badge finder-owner-${status}`;
  badge.textContent = status === 'free' ? 'Free' : status === 'colonized' ? `Colonized · ${owner}` : 'Unknown ownership';
  return badge;
}

function allianceBadge(tag) {
  const badge = document.createElement('span');
  badge.className = 'finder-badge finder-alliance';
  badge.textContent = `[${tag}]`;
  return badge;
}

function zoneBadge(zone) {
  const badge = document.createElement('span');
  badge.className = `finder-badge finder-zone-${['sentinel', 'open', 'dead', 'rift'].includes(zone) ? zone : 'unknown'}`;
  badge.textContent = zone || 'unknown';
  return badge;
}

function directoryOrigin(state) {
  const planet = myPlanets.find(planet => String(planet.id) === state.origin);
  return planet ? { x: planet.systemX, y: planet.systemY } : homeSys;
}

function drawTypeFilters(box, values, group, state, key, onChange = () => {
  state.page = 0;
  renderFinderDirectory();
}) {
  const signature = JSON.stringify([finderView, values]);
  if (box.dataset.options !== signature) {
    box.dataset.options = signature;
    box.textContent = '';
    for (const value of values) {
      const button = document.createElement('button');
      button.type = 'button';
      const badge = typeBadge(value, group);
      button.className = `finder-type-toggle ${badge.className}`;
      button.dataset.value = value;
      button.textContent = badge.textContent;
      button.addEventListener('click', () => {
        state[key] = state[key].includes(value) ? state[key].filter(type => type !== value) : [...state[key], value];
        onChange();
      });
      box.appendChild(button);
    }
  }
  for (const button of box.children) {
    const selected = state[key].includes(button.dataset.value);
    setToggleState(button, selected);
  }
}

function drawSearchTypeFilters() {
  drawTypeFilters(document.getElementById('f-types'), PLANET_TYPES, 'planets', searchTypes, 'types', drawSearchTypeFilters);
  drawTypeFilters(document.getElementById('f-moon-types'), MOON_TYPES, 'moons', searchTypes, 'moonTypes', drawSearchTypeFilters);
  updateSearchFilterCount();
}

function updateSearchFilterCount() {
  const count = ['f-max-distance', 'f-min-planet-slots'].filter(id => {
    const input = document.getElementById(id);
    return input.value.trim() !== '' || input.validity?.badInput;
  }).length + Number(searchTypes.moonTypes.length > 0);
  document.getElementById('f-search-active').textContent = count ? `(${count} active)` : '';
}

for (const id of ['f-max-distance', 'f-min-planet-slots']) {
  document.getElementById(id).addEventListener('input', updateSearchFilterCount);
}

function drawDirectoryFilters(rows, state) {
  const bodyView = finderView !== 'systems';
  const types = [...new Set(rows.map(row => row.type ?? row.starType ?? 'unknown').concat(state.types))].sort();
  const moonTypes = [...new Set(rows.flatMap(row => row.moonTypes || []).concat(state.moonTypes))].sort();
  const parentTypes = [...new Set(rows.map(row => row.parentType).filter(Boolean).concat(state.parentTypes))].sort();
  document.getElementById('f-directory-type-label').textContent = finderView === 'systems' ? 'Star type' : finderView === 'planets' ? 'Planet type' : 'Moon type';
  document.getElementById('f-directory-ownership-field').hidden = !bodyView;
  document.getElementById('f-directory-ownership').value = state.ownership;
  const key = JSON.stringify([finderView, types, moonTypes, parentTypes, finderArms, myPlanets]);
  if (directoryFilterKey !== key) {
    directoryFilterKey = key;
    // Rebuild controls only when switching lists or their available options change.
    document.getElementById('f-directory-types').dataset.options = '';
    const more = document.getElementById('f-directory-more');
    more.open = state.advancedOpen;
    const fields = document.getElementById('f-directory-extra-fields');
    fields.textContent = '';
    const update = () => { state.page = 0; renderFinderDirectory(); };
    const select = (id, label, values, property) => {
      const field = document.createElement('label');
      field.className = 'toolbar-field';
      field.textContent = label;
      const input = document.createElement('select');
      input.id = `f-directory-${id}`;
      input.className = 'toolbar-select';
      for (const [value, name] of values) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = name;
        input.appendChild(option);
      }
      input.value = state[property];
      input.addEventListener('change', () => { state[property] = input.value; update(); });
      field.appendChild(input);
      fields.appendChild(field);
    };
    const input = (id, label, value, onInput, type = 'text') => {
      const field = document.createElement('label');
      field.className = 'toolbar-field';
      field.textContent = label;
      const control = document.createElement('input');
      control.id = `f-directory-${id}`;
      control.className = 'toolbar-input';
      control.type = type;
      control.value = value;
      if (type === 'number') { control.min = '0'; control.step = '1'; }
      control.addEventListener('input', () => {
        state.invalidNumbers = state.invalidNumbers.filter(id => id !== control.id);
        if (type === 'number' && control.validity?.badInput) state.invalidNumbers.push(control.id);
        onInput(control.value);
        update();
      });
      field.appendChild(control);
      return field;
    };
    select('origin', 'Distance from', [['', 'Map search origin'], ...myPlanets.map(planet =>
      [String(planet.id), `${planet.name} (${planet.systemName || planet.systemId})`])], 'origin');
    select('arm', 'Arm', [['', 'All arms'], ...(finderArms || []).map(arm => [String(arm.id), arm.name])], 'arm');
    const sector = input('sector', 'Sector', state.sector, value => { state.sector = value; });
    sector.children[0].placeholder = '35 or 33-35';
    sector.title = 'Sector number or range within each arm (same numbering as Search).';
    fields.appendChild(sector);
    for (const [name, label] of DIRECTORY_RANGES[finderView]) {
      for (const bound of name === 'distance' ? ['min', 'max'] : ['min']) {
        const field = input(`${name}-${bound}`, `${bound === 'min' ? 'Min' : 'Max'} ${label}`, state.ranges[name]?.[bound] ?? '', value => {
          state.ranges[name] ||= {};
          state.ranges[name][bound] = value;
        }, 'number');
        if (name === 'slots' && finderView === 'planets') field.title = 'Capacity, not unused slots; calculated base capacity when no explicit value is saved.';
        fields.appendChild(field);
      }
    }
    if (!bodyView) {
      select('contents', 'Saved contents', [['', 'All systems'], ['recorded', 'Contents recorded'], ['missing', 'Not yet recorded']], 'contents');
    }
    if (finderView === 'planets') {
      fields.appendChild(input('free-moon-slots', 'Min moon slots', state.minFreeMoonSlots, value => { state.minFreeMoonSlots = value; }, 'number'));
      fields.children[fields.children.length - 1].title = 'At least one known-free moon must individually meet this limit. No requests are made to resolve unknown ownership.';
    }
    if (finderView === 'planets' || finderView === 'moons') {
      const field = document.createElement('div');
      field.className = 'toolbar-field finder-filter-type-field';
      field.textContent = finderView === 'planets' ? 'Moon type present (any selected)' : 'Parent planet type';
      const box = document.createElement('span');
      box.id = 'f-directory-related-types';
      box.className = 'finder-filter-toggles';
      box.setAttribute('role', 'group');
      box.setAttribute('aria-label', field.textContent);
      field.appendChild(box);
      fields.appendChild(field);
      drawTypeFilters(box, finderView === 'planets' ? moonTypes : parentTypes,
        finderView === 'planets' ? 'moons' : 'planets', state, finderView === 'planets' ? 'moonTypes' : 'parentTypes');
    }
  }
  drawTypeFilters(document.getElementById('f-directory-types'), types, finderView, state, 'types');
  // Related types also need their selected state updated without replacing focused controls.
  const related = document.getElementById('f-directory-related-types');
  if (finderView !== 'systems' && related) drawTypeFilters(related,
    finderView === 'planets' ? moonTypes : parentTypes,
    finderView === 'planets' ? 'moons' : 'planets', state, finderView === 'planets' ? 'moonTypes' : 'parentTypes');
  const rangeCount = Object.values(state.ranges).filter(range => range.min !== '' && range.min != null || range.max !== '' && range.max != null).length;
  const extraCount = rangeCount + state.invalidNumbers.length + ['arm', 'origin', 'sector', 'contents', 'minFreeMoonSlots']
    .filter(name => state[name] !== '').length + (state.moonTypes.length ? 1 : 0) + (state.parentTypes.length ? 1 : 0);
  document.getElementById('f-directory-active').textContent = extraCount ? `(${extraCount} active)` : '';
  return extraCount + (state.types.length ? 1 : 0) + (state.zones.length ? 1 : 0) + (state.text.trim() ? 1 : 0) + (state.ownership ? 1 : 0);
}

function renderFinderDirectory() {
  if (!isDirectoryView()) return;
  const scope = document.getElementById('f-directory-scope').value || (searchSummary ? 'matches' : 'all');
  const hits = visibleFinderHits();
  const state = directoryState();
  const rows = buildGalaxyDirectory({
    systems: galaxySystems || [], scans: finderScans, hits, scope, origin: directoryOrigin(state),
  }, finderView);
  const filterCount = drawDirectoryFilters(rows, state);
  drawDirectoryZones(state);
  const result = queryGalaxyDirectory(rows, state);
  state.page = result.page;
  const status = scope === 'matches' && !searchSummary
    ? 'No active search. Use Search or select All known data.'
    : `${filterCount ? `${filterCount} active list filters · ` : ''}${finderView !== 'systems' ? 'Ownership may be outdated · ' : ''}${result.total} ${finderView}`;
  setStatusText(document.getElementById('f-directory-summary'),
    directoryError || result.error || status);
  const columns = finderView === 'systems'
    ? [['name', 'System'], ['starType', 'Star type'], ['zone', 'Zone'], ['distance', 'Distance'], ['matches', 'Matching planets'], ['coverage', 'Known data']]
    : finderView === 'planets'
      ? [['name', 'Planet'], ['system', 'System'], ['type', 'Type'], ['size', 'Size'], ['slots', 'Slots'], ['moons', 'Moons'], ['zone', 'Zone'], ['distance', 'Distance'], ['owner', 'Owner'], ['alliance', 'Alliance']]
      : [['name', 'Moon'], ['planet', 'Parent planet'], ['system', 'System'], ['type', 'Type'], ['slots', 'Slots'], ['size', 'Size'], ['zone', 'Zone'], ['distance', 'Distance'], ['owner', 'Owner']];
  const head = document.getElementById('f-directory-head');
  head.textContent = '';
  const header = document.createElement('tr');
  for (const [key, label] of columns) {
    const th = document.createElement('th');
    th.setAttribute('aria-sort', state.sort === key ? state.direction === 1 ? 'ascending' : 'descending' : 'none');
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label + (state.sort === key ? state.direction === 1 ? ' ↑' : ' ↓' : '');
    button.addEventListener('click', () => {
      state.direction = state.sort === key ? -state.direction : 1;
      state.sort = key;
      state.page = 0;
      renderFinderDirectory();
    });
    th.appendChild(button);
    header.appendChild(th);
  }
  const actions = document.createElement('th');
  actions.textContent = 'Actions';
  header.appendChild(actions);
  head.appendChild(header);
  const body = document.getElementById('f-directory-body');
  body.textContent = '';
  for (const row of result.rows) {
    const tr = document.createElement('tr');
    for (const [key] of columns) {
      const td = document.createElement('td');
      td.textContent = row[key] == null ? '—' : String(row[key]).replace(/_/g, ' ');
      if (key === 'name') appendGalaxyImage(td, finderView, {
        starType: row.starType,
        planetType: finderView === 'planets' ? row.type : undefined,
        moonType: finderView === 'moons' ? row.type : undefined,
        imagePath: row.imagePath,
      }, galaxyImageOrigin);
      if (key === 'type' || key === 'starType') {
        td.textContent = '';
        td.appendChild(typeBadge(row[key], finderView));
      }
      if (key === 'zone') {
        td.textContent = '';
        td.appendChild(zoneBadge(row.zone));
      }
      if (key === 'slots' && finderView === 'planets') td.title = 'Building-slot capacity; calculated base slots when no explicit capacity is saved. Not unused slots.';
      if (key === 'alliance' && row.alliance) {
        td.textContent = '';
        td.appendChild(allianceBadge(row.alliance));
      }
      if (key === 'system' || key === 'planet') td.className = 'finder-parent-reference';
      if (key === 'coverage') {
        td.textContent = '';
        const coverage = document.createElement('span');
        coverage.className = 'finder-coverage';
        for (const [name, count] of [['Planets', row.planets], ['Moons', row.moons], ['Asteroids', row.asteroids]]) {
          const label = document.createElement('span');
          label.className = 'finder-badge';
          label.textContent = `${name}: ${count ?? 'unknown'}`;
          coverage.appendChild(label);
        }
        td.title = row.coverage;
        td.appendChild(coverage);
      }
      if (key === 'owner') {
        td.textContent = '';
        td.appendChild(ownershipBadge(row.ownerStatus, row.owner));
        if (finderView === 'moons' && row.alliance) td.appendChild(allianceBadge(row.alliance));
        td.title = row.ownershipAt
          ? `Ownership last checked: ${new Date(row.ownershipAt).toLocaleString()}` : 'Ownership has not been verified.';
      }
      tr.appendChild(td);
    }
    const td = document.createElement('td');
    const sourceGroup = finderView === 'systems' ? null : finderView;
    td.appendChild(directoryActions(row.systemId, sourceGroup, row.id));
    tr.appendChild(td);
    body.appendChild(tr);
  }
  if (!result.rows.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = columns.length + 1;
    td.textContent = 'No matching entries in saved galaxy data.';
    tr.appendChild(td);
    body.appendChild(tr);
  }
  document.getElementById('f-directory-prev').disabled = result.page === 0;
  document.getElementById('f-directory-next').disabled = result.page >= result.pages - 1;
  setStatusText(document.getElementById('f-directory-page'), `Page ${result.page + 1}/${result.pages} · ${result.total} entries`);
}

function directoryActions(systemId, sourceGroup, bodyId) {
  const buttons = document.createElement('div');
  buttons.className = 'finder-directory-actions';
  const show = document.createElement('button');
  show.type = 'button';
  show.className = 'toolbar-button secondary-button';
  show.textContent = 'Show on map';
  show.disabled = !galaxySystems?.some(system => system.id === systemId);
  show.addEventListener('click', event => {
    event.stopPropagation?.();
    void selectFinderView('map');
    focusSystem(systemId);
  });
  buttons.appendChild(show);
  const overview = document.createElement('button');
  overview.type = 'button';
  overview.className = 'toolbar-button secondary-button';
  overview.textContent = 'System overview';
  overview.addEventListener('click', event => {
    event.stopPropagation?.();
    openSystemOverview(systemId, sourceGroup, bodyId);
  });
  buttons.appendChild(overview);
  return buttons;
}

function drawZoneFilters(box, zones, isSelected, toggle) {
  box.textContent = '';
  for (const zone of [...zones].sort()) {
    const selected = isSelected(zone);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `zone-toggle zone-${zone}`;
    button.textContent = zone;
    setToggleState(button, selected);
    button.addEventListener('click', () => toggle(zone, selected));
    box.appendChild(button);
  }
}

function drawDirectoryZones(state) {
  const zones = new Set((galaxySystems || []).map(system => system.securityZone || 'unknown'));
  const systemIds = new Set((galaxySystems || []).map(system => system.id));
  if (Object.keys(finderScans).some(id => !systemIds.has(Number(id)))) zones.add('unknown');
  drawZoneFilters(document.getElementById('f-directory-zones'), zones, zone => state.zones.includes(zone), (zone, selected) => {
    state.zones = selected ? state.zones.filter(value => value !== zone) : [...state.zones, zone];
    state.page = 0;
    renderFinderDirectory();
  });
}

function closeSystemOverview() {
  const dialog = document.getElementById('f-system-overview');
  if (dialog.open) dialog.close();
  overviewSystemId = null;
  overviewSourceGroup = null;
  overviewSourceId = null;
  document.getElementById('f-system-body').textContent = '';
  document.getElementById('f-system-title').textContent = 'System overview';
  document.getElementById('f-system-meta').textContent = '';
}

document.getElementById('f-system-close').addEventListener('click', closeSystemOverview);
document.getElementById('f-system-overview').addEventListener('click', event => {
  const dialog = event.currentTarget;
  if (event.target !== dialog) return;
  const rect = dialog.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right ||
      event.clientY < rect.top || event.clientY > rect.bottom) closeSystemOverview();
});
document.getElementById('f-system-overview').addEventListener('cancel', event => {
  event.preventDefault();
  closeSystemOverview();
});
document.getElementById('f-system-overview').addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  closeSystemOverview();
});
document.getElementById('f-system-map').addEventListener('click', () => {
  const systemId = overviewSystemId;
  closeSystemOverview();
  void selectFinderView('map');
  focusSystem(systemId);
});

function updateOverviewColonyState() {
  const state = document.getElementById('f-system-colony-state');
  if (!state) return;
  const system = galaxySystems?.find(system => system.id === overviewSystemId);
  state.textContent = system?.hasColonies === true ? ' · Colonies reported'
    : system?.hasColonies === false ? ' · No colonies reported' : '';
  state.title = system?.colonyStateObservedAt
    ? `System-level WebSocket observation: ${new Date(system.colonyStateObservedAt).toLocaleString()}. Does not identify a planet or owner and may be outdated.`
    : 'Saved system-level state; not a current planet ownership check.';
}

function openSystemOverview(systemId, sourceGroup = null, sourceId = null) {
  overviewSystemId = systemId;
  overviewSourceGroup = sourceGroup;
  overviewSourceId = sourceId;
  const system = galaxySystems?.find(system => system.id === systemId);
  const data = finderScans[systemId]?.data || {};
  const children = moonsByPlanet(data.moons);
  const title = document.getElementById('f-system-title');
  title.textContent = `System overview: ${system?.name || `#${systemId}`}`;
  appendGalaxyImage(title, 'systems', system || {}, galaxyImageOrigin);
  const meta = document.getElementById('f-system-meta');
  meta.textContent = [
    `ID ${systemId}`,
    `Star: ${system?.starType?.replace(/_/g, ' ') || 'unknown'}`,
    `Arm: ${finderArms?.find(arm => arm.id === system?.armId)?.name || system?.armId || 'unknown'}`,
    `Sector: ${system?.sectorId ?? 'unknown'}`,
    `Coordinates: ${system?.x ?? '?'} / ${system?.y ?? '?'}`,
    `Distance: ${system ? systemDistance(system) ?? 'unknown' : 'unknown'}`,
    `Visibility: ${system?.visibility || data.visibility || 'unknown'}`,
  ].join(' · ');
  const colonyState = document.createElement('span');
  colonyState.id = 'f-system-colony-state';
  meta.appendChild(colonyState);
  updateOverviewColonyState();
  meta.append(document.createTextNode(' · Zone: '), zoneBadge(system?.securityZone));
  const body = document.getElementById('f-system-body');
  body.textContent = '';
  let selectedRow;
  const groups = [
    ['bodies', 'Planets and moons', []],
    ['asteroidFields', 'Asteroid fields', [
      ['id', 'ID'], ['name', 'Name'], ['fieldType', 'Type'], ['richness', 'Richness'],
      ['remainingResources', 'Remaining'], ['totalResources', 'Total'],
      [field => Object.hasOwn(field, 'controllerUserId')
        ? field.controllerUserId == null ? 'unowned' : field.controllerName || `Player #${field.controllerUserId}` : 'unknown', 'Controller'],
    ]],
  ];
  for (const [group, label, columns] of groups) {
    const entries = group === 'bodies' ? systemBodyRows(data)
      : (data[group] || []).map(item => ({ group, item }));
    const section = document.createElement('section');
    section.className = 'finder-system-section';
    const heading = document.createElement('h3');
    heading.textContent = group === 'bodies'
      ? `Planets (${data.planets?.length ?? 'unknown'}) · Moons (${data.moons?.length ?? 'unknown'})`
      : `${label} (${Array.isArray(data[group]) ? data[group].length : 'unknown'})`;
    section.appendChild(heading);
    const at = data._galaxyCache?.times?.[group];
    const ownershipAt = data._galaxyCache?.ownership?.[group];
    const stamp = document.createElement('p');
    stamp.className = 'finder-system-meta';
    stamp.textContent = group === 'bodies' ? ['planets', 'moons'].map(section => {
      const observed = data._galaxyCache?.times?.[section];
      const checked = data._galaxyCache?.ownership?.[section];
      return `${section}: Data observed: ${observed ? new Date(observed).toLocaleString() : 'unknown'} · Ownership checked: ${checked ? new Date(checked).toLocaleString() : 'unknown'}`;
    }).join(' · ') : `Data observed: ${at ? new Date(at).toLocaleString() : 'unknown'}` +
      (group === 'asteroidFields' ? '' : ` · Ownership checked: ${ownershipAt ? new Date(ownershipAt).toLocaleString() : 'unknown'}`);
    if (data._galaxyCache?.publicSource) stamp.textContent += ' · Includes public base data; not a visibility or ownership observation.';
    section.appendChild(stamp);
    if (group === 'bodies') {
      for (const name of ['planets', 'moons']) {
        if (data[name]?.length) continue;
        const message = document.createElement('p');
        message.textContent = Array.isArray(data[name]) ? `No ${name} in saved data.` : `${name === 'planets' ? 'Planets' : 'Moons'} have not been collected.`;
        section.appendChild(message);
      }

    }
    if (group !== 'bodies' && !entries.length) {
      const message = document.createElement('p');
      message.textContent = Array.isArray(data[group]) ? `No ${label.toLowerCase()} in saved data.` : `${label} have not been collected.`;
      section.appendChild(message);
    } else if (group === 'bodies' && entries.length) {
      const scroll = document.createElement('div');
      scroll.className = 'finder-system-list-scroll';
      scroll.tabIndex = 0;
      scroll.setAttribute('aria-label', 'Planets and moons; scroll horizontally for all columns');
      const list = document.createElement('div');
      list.className = 'finder-system-list';
      list.setAttribute('role', 'table');
      list.setAttribute('aria-label', 'Saved planets and moons');
      const labels = ['Body', 'Type', 'Size', 'Slots', 'Orbit', 'Moons', 'ID', 'Ownership / Alliance'];
      const headings = document.createElement('div');
      headings.className = 'finder-body-columns';
      headings.setAttribute('role', 'row');
      for (const label of labels) {
        const cell = document.createElement('span');
        cell.textContent = label;
        cell.setAttribute('role', 'columnheader');
        headings.appendChild(cell);
      }
      list.appendChild(headings);
      scroll.appendChild(list);
      section.appendChild(scroll);
      const planets = new Map();
      for (const entry of entries) {
        const { item } = entry;
        const isMoon = entry.group === 'moons';
        let container;
        if (isMoon) {
          container = planets.get(entry.parent);
          if (!container) {
            container = document.createElement('section');
            container.className = 'finder-planet-group';
            container.setAttribute('role', 'rowgroup');
            const missing = document.createElement('h4');
            missing.textContent = `Parent planet #${entry.parent ?? '?'} not collected`;
            container.appendChild(missing);
            planets.set(entry.parent, container);
            list.appendChild(container);
          }
        } else {
          container = document.createElement('section');
          container.className = 'finder-planet-group';
          container.setAttribute('role', 'rowgroup');
          planets.set(item.id, container);
          list.appendChild(container);
        }
        const card = document.createElement('article');
        card.className = `finder-body-card${isMoon ? ' finder-system-moon' : ''}`;
        card.setAttribute('role', 'row');
        card.dataset.bodyId = String(item.id);
        card.dataset.bodyGroup = entry.group;
        if (entry.group === sourceGroup && item.id === sourceId) {
          card.className += ' finder-system-selected';
          card.setAttribute('aria-current', 'true');
          card.title = 'Opened from this entry';
          selectedRow = card;
        }
        const header = document.createElement('div');
        header.className = 'finder-body-header';
        header.setAttribute('role', 'presentation');
        const name = document.createElement(isMoon ? 'h5' : 'h4');
        name.setAttribute('role', 'cell');
        name.title = isMoon ? `Moon of planet #${entry.parent ?? 'unknown'}` : 'Planet';
        name.textContent = item.name || `${isMoon ? 'Moon' : 'Planet'} #${item.id}`;
        appendGalaxyImage(name, entry.group, item, galaxyImageOrigin);
        const type = document.createElement('span');
        type.setAttribute('role', 'cell');
        type.appendChild(typeBadge(isMoon ? item.moonType : item.planetType, entry.group));
        header.append(name, type);
        card.appendChild(header);
        const facts = document.createElement('div');
        facts.className = 'finder-body-facts';
        facts.setAttribute('role', 'presentation');
        const values = [
          ['Size', item.size], ['Slots', isMoon ? item.buildingSlots : planetSlots(item)],
          ['Orbit', item.position == null ? null : `#${item.position}`],
          ['Moons', isMoon ? '—' : Array.isArray(data.moons)
            ? (children.get(item.id) || []).length : null],
          ['ID', item.id],
        ];
        for (const [label, value] of values) {
          const fact = document.createElement('span');
          fact.textContent = value == null ? '—' : String(value);
          fact.setAttribute('role', 'cell');
          fact.setAttribute('aria-label', `${label}: ${value ?? 'unknown'}`);
          fact.title = `${label}: ${value ?? 'unknown'}`;
          if (label === 'Slots' && !isMoon) fact.title += ' · Building-slot capacity; calculated base slots when no explicit capacity is saved. Not unused slots.';
          facts.appendChild(fact);
        }
        card.appendChild(facts);
        const status = document.createElement('div');
        status.className = 'finder-body-status';
        status.setAttribute('role', 'cell');
        const badge = ownershipBadge(directoryOwnership(item), directoryOwner(item));
        const checked = data._galaxyCache?.ownership?.[entry.group];
        badge.title = checked ? `Ownership last checked: ${new Date(checked).toLocaleString()}` : 'Ownership has not been verified.';
        status.appendChild(badge);
        if (item.ownerAllianceTag) {
          status.appendChild(allianceBadge(item.ownerAllianceTag));
        }
        card.appendChild(status);
        container.appendChild(card);
      }
    } else if (entries.length) {
      const scroll = document.createElement('div');
      scroll.className = 'finder-directory-scroll';
      const table = document.createElement('table');
      const head = document.createElement('thead');
      const header = document.createElement('tr');
      for (const [, name] of columns) {
        const th = document.createElement('th');
        th.textContent = name;
        header.appendChild(th);
      }
      head.appendChild(header);
      const tbody = document.createElement('tbody');
      for (const entry of entries) {
        const { item } = entry;
        const row = document.createElement('tr');
        if (entry.group === sourceGroup && item.id === sourceId) {
          row.className += ' finder-system-selected';
          row.setAttribute('aria-current', 'true');
          row.title = 'Opened from this entry';
          selectedRow = row;
        }
        for (const [key] of columns) {
          const cell = document.createElement('td');
          const value = typeof key === 'function' ? key(item) : item[key];
          cell.textContent = value == null ? '—' : String(value).replace(/_/g, ' ');
          row.appendChild(cell);
        }
        tbody.appendChild(row);
      }
      table.append(head, tbody);
      scroll.appendChild(table);
      section.appendChild(scroll);
    }
    body.appendChild(section);
  }
  document.getElementById('f-system-map').disabled = !system;
  const dialog = document.getElementById('f-system-overview');
  if (!dialog.open) dialog.showModal();
  selectedRow?.scrollIntoView({ block: 'nearest' });
}

export function systemDistance(s) {
  if (!homeSys || ![s.x, s.y, homeSys.x, homeSys.y].every(Number.isFinite)) return null;
  return Math.round(Math.hypot(s.x - homeSys.x, s.y - homeSys.y));
}

function drawFinderZones() {
  const zones = new Set((galaxySystems || []).map(system => system.securityZone).filter(Boolean));
  drawZoneFilters(document.getElementById('f-zone'), zones, zone => finderZones.has(zone), (zone, selected) => {
    if (selected) finderZones.delete(zone); else finderZones.add(zone);
    drawFinderZones();
  });
}

// Sector field accepts a single sector ("35") or a range ("33-35").
// Empty means the whole arm.
export function regionSectorIds(
  armValue = document.getElementById('f-arm').value,
  sectorValue = document.getElementById('f-sector').value,
) {
  if (armValue === 'all') {
    return { armId: null, from: 1, to: Infinity, min: -Infinity, max: Infinity };
  }
  const armId = parseInt(armValue, 10) || 1;
  const arm = finderArms.find(a => a.id === armId) || { sectorCount: 50 };
  const raw = sectorValue.trim();
  let from = 1, to = arm.sectorCount;
  const range = parseSectorRange(raw);
  if (range) ({ from, to } = range);
  from = Math.max(1, Math.min(arm.sectorCount, from));
  to = Math.max(1, Math.min(arm.sectorCount, to));
  const base = (armId - 1) * 50;
  return { armId, from, to, min: base + from, max: base + to };
}

function updateSectorInput() {
  const allArms = document.getElementById('f-arm').value === 'all';
  const sector = document.getElementById('f-sector');
  if (allArms) sector.value = '';
  sector.disabled = allArms;
  sector.title = allArms ? 'Disabled when scanning all arms.' : '';
}

export const MAP_PAD = 14;

function mapDimensions(canvas) {
  return mapSize || { width: canvas.width, height: canvas.height };
}

function resizeMapCanvas(canvas) {
  const rect = canvas.getBoundingClientRect();
  if (!(rect.width > 0 && rect.height > 0)) return;
  const next = { width: rect.width, height: rect.height };
  if (mapSize && mapBounds && Number.isFinite(mapBounds.minX) &&
    (next.width !== mapSize.width || next.height !== mapSize.height)) {
    const ratio = mapProjectionScale(next) / mapProjectionScale(mapSize);
    mapView.ox = next.width / 2 * (1 - mapView.scale) +
      (mapView.ox - mapSize.width / 2 * (1 - mapView.scale)) * ratio;
    mapView.oy = next.height / 2 * (1 - mapView.scale) +
      (mapView.oy - mapSize.height / 2 * (1 - mapView.scale)) * ratio;
    mapPan = null;
    document.getElementById('f-tooltip').style.display = 'none';
  }
  mapSize = next;
  const density = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(next.width * density));
  const height = Math.max(1, Math.round(next.height * density));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
}

// Base projection (data coords → canvas px, before pan/zoom).
export function mapBaseX(canvas, x) {
  const size = mapDimensions(canvas);
  const scale = mapProjectionScale(size);
  return size.width / 2 + (x - (mapBounds.minX + mapBounds.maxX) / 2) * scale;
}
export function mapBaseY(canvas, y) {
  const size = mapDimensions(canvas);
  const scale = mapProjectionScale(size);
  return size.height / 2 + (y - (mapBounds.minY + mapBounds.maxY) / 2) * scale;
}

function mapProjectionScale(canvas) {
  return Math.min((canvas.width - 2 * MAP_PAD) / Math.max(1, mapBounds.maxX - mapBounds.minX),
    (canvas.height - 2 * MAP_PAD) / Math.max(1, mapBounds.maxY - mapBounds.minY));
}

function closeMapSuggestions() {
  document.getElementById('f-map-systems').hidden = true;
  const input = document.getElementById('f-map-search');
  input.setAttribute('aria-expanded', 'false');
  input.removeAttribute('aria-activedescendant');
  mapActiveMatch = -1;
}

function chooseMapSystem(system) {
  focusSystem(system.id);
}

function updateMapSystemChoices() {
  const query = document.getElementById('f-map-search').value.trim().toLowerCase();
  const select = document.getElementById('f-map-systems');
  closeMapSuggestions();
  select.textContent = '';
  const matches = query ? (galaxySystems || []).filter(system =>
    String(system.id) === query.replace(/^#/, '') || (system.name || '').toLowerCase().includes(query)) : [];
  mapMatches = matches.slice(0, 50);
  document.getElementById('f-map-search-clear').hidden = !query;
  const status = !query ? '' : !matches.length ? 'No known system matches'
    : `${matches.length} matches${matches.length > 50 ? ' (first 50 shown)' : ''}`;
  setStatusText(document.getElementById('f-map-match-status'), status);
  for (const [index, system] of mapMatches.entries()) {
    const option = document.createElement('div');
    option.id = `f-map-match-${index}`;
    option.className = 'finder-map-suggestion';
    option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', 'false');
    const name = document.createElement('strong');
    name.textContent = system.name || 'Unnamed system';
    const details = document.createElement('small');
    details.textContent = `#${system.id} · ${system.securityZone || 'Unknown zone'}`;
    option.append(name, details);
    option.addEventListener('mousedown', event => event.preventDefault());
    option.addEventListener('click', () => chooseMapSystem(system));
    select.appendChild(option);
  }
  if (query && !matches.length) {
    const empty = document.createElement('div');
    empty.className = 'finder-map-suggestion';
    empty.textContent = status;
    select.appendChild(empty);
  }
  select.hidden = !query;
  if (query && Number.isFinite(window.innerHeight)) {
    const rect = document.getElementById('f-map-search').getBoundingClientRect();
    select.style.maxHeight = `${Math.max(0, Math.min(280, window.innerHeight - rect.top - rect.height - 12))}px`;
  }
  document.getElementById('f-map-search').setAttribute('aria-expanded', String(Boolean(query)));
  return matches;
}

function rebuildMapAllianceSystems() {
  allianceSystems = {};
  for (const [id, scan] of Object.entries(finderScans)) {
    const names = new Set();
    for (const body of [...(scan.data.planets || []), ...(scan.data.moons || [])]) {
      if (body.ownershipKnown === false || body.userId == null || body.userId === myUserId) continue;
      if (allianceMemberIds.has(body.userId) || myAllianceTag && body.ownerAllianceTag === myAllianceTag) {
        names.add(body.ownerName || `Player #${body.userId}`);
      }
    }
    if (names.size) allianceSystems[id] = [...names].join(', ');
  }
}

export function drawGalaxyMap() {
  closeMapInfo();
  document.getElementById('f-tooltip').style.display = 'none';
  const canvas = document.getElementById('f-map');
  resizeMapCanvas(canvas);
  const { width, height } = mapDimensions(canvas);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(canvas.width / width, 0, 0, canvas.height / height, 0, 0);
  ctx.fillStyle = cssVar('--bg-page');
  ctx.fillRect(0, 0, width, height);
  mapPoints.clear();
  const labelLayer = document.getElementById('f-map-labels');
  labelLayer.textContent = '';
  if (!galaxySystems?.length) return;

  if (!mapBounds) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const s of galaxySystems.filter(system => Number.isFinite(system.x) && Number.isFinite(system.y))) {
      if (s.x < minX) minX = s.x;
      if (s.x > maxX) maxX = s.x;
      if (s.y < minY) minY = s.y;
      if (s.y > maxY) maxY = s.y;
    }
    mapBounds = { minX, maxX, minY, maxY };
  }
  if (!Number.isFinite(mapBounds.minX)) return;
  // base projection + pan/zoom transform
  const sx = x => mapBaseX(canvas, x) * mapView.scale + mapView.ox;
  const sy = y => mapBaseY(canvas, y) * mapView.scale + mapView.oy;

  const region = lastSearch ? regionSectorIds(lastSearch.config.arm, lastSearch.config.sector) : null;
  const inRegion = s => !region || region.armId == null ||
    (s.armId === region.armId && s.sectorId >= region.min && s.sectorId <= region.max);

  const unit = 1;
  const radius = Math.min(3.4, 0.9 + Math.log2(mapView.scale) * 0.7);
  const overlays = [];
  for (const s of galaxySystems) {
    const hit = hitSystems[s.id];
    const owned = myOwnedSystems.has(s.id);
    const allyOwner = mapAllianceVisible ? allianceSystems[s.id] : null;
    if (!Number.isFinite(s.x) || !Number.isFinite(s.y)) continue;
    const color = MAP_STAR_COLORS[s.starType] || '#9ca3af';
    const px = sx(s.x), py = sy(s.y);
    if (px < -24 * unit || py < -24 * unit || px > width + 24 * unit || py > height + 24 * unit) continue;
    mapPoints.set(s.id, { x: px, y: py });
    ctx.globalAlpha = !inRegion(s) ? 0.25 : s.visibility === 'fog' || s.visibility === 'outline' ? 0.45 : 1;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(px, py, radius, 0, Math.PI * 2);
    ctx.fill();
    if (mapZonesVisible) {
      ctx.strokeStyle = MAP_ZONE_COLORS[s.securityZone] || '#9ca3af';
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.arc(px, py, radius + 1.4, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    if (owned || allyOwner || hit || s.id === selectedSystemId) overlays.push({ s, px, py, owned, allyOwner, hit });
    if (hit) { hit.screenX = px; hit.screenY = py; }
  }

  const labels = [];
  const dark = cssVar('--bg-page') || '#080d17';
  const label = (text, x, y, color, priority) => labels.push({ text, x, y, color, priority });
  const strokePath = color => {
    ctx.strokeStyle = dark;
    ctx.lineWidth = 5 * unit;
    ctx.stroke();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2 * unit;
    ctx.stroke();
  };
  // Draw navigation markers after the point cloud so nearby stars cannot cover them.
  for (const { s, px, py, owned, allyOwner, hit } of overlays) {
    if (hit) {
      ctx.beginPath();
      ctx.arc(px, py, 7 * unit, 0, Math.PI * 2);
      strokePath(MAP_HIT_COLOR);
    }
    if (mapAllianceVisible && (owned || allyOwner)) {
      const d = 5 * unit, edge = 3 * unit;
      ctx.beginPath();
      for (const side of [-1, 1]) {
        ctx.moveTo(px + side * edge, py - d);
        ctx.lineTo(px + side * d, py - d);
        ctx.lineTo(px + side * d, py + d);
        ctx.lineTo(px + side * edge, py + d);
      }
      strokePath(MAP_ALLY_COLOR);
    }
    if (owned) {
      ctx.beginPath();
      ctx.moveTo(px - 6 * unit, py - 10 * unit);
      ctx.lineTo(px, py - 16 * unit);
      ctx.lineTo(px + 6 * unit, py - 10 * unit);
      strokePath(MAP_OWN_COLOR);
    }
    if (s.id === selectedSystemId) {
      ctx.beginPath();
      ctx.arc(px, py, 11 * unit, 0, Math.PI * 2);
      strokePath('#ffffff');
    }
  }

  if (mapHubsVisible) for (const h of galaxyHubs) {
    if (!Number.isFinite(h.x) || !Number.isFinite(h.y)) continue;
    const px = sx(h.x), py = sy(h.y), d = 7 * unit;
    if (px < -d || py < -d || px > width + d || py > height + d) continue;
    ctx.beginPath();
    ctx.moveTo(px, py - d);
    ctx.lineTo(px + d, py);
    ctx.lineTo(px, py + d);
    ctx.lineTo(px - d, py);
    ctx.closePath();
    ctx.fillStyle = '#f5d90a';
    ctx.fill();
    strokePath('#f5d90a');
    label(h.name, px, py + d + 4, '#f5d90a', 1);
  }

  if (mapStationsVisible) for (const station of mapStations) {
    const px = sx(station.systemX), py = sy(station.systemY), d = 8;
    if (px < -d || py < -d || px > width + d || py > height + d) continue;
    if (!mapPoints.has(station.systemId)) mapPoints.set(station.systemId, { x: px, y: py });
    const color = station.ownedByViewerAlliance ? MAP_ALLY_COLOR : '#c084fc';
    ctx.beginPath();
    for (let index = 0; index < 6; index++) {
      const angle = -Math.PI / 2 + index * Math.PI / 3;
      if (index === 0) ctx.moveTo(px + Math.cos(angle) * d, py + Math.sin(angle) * d);
      else ctx.lineTo(px + Math.cos(angle) * d, py + Math.sin(angle) * d);
    }
    ctx.closePath();
    strokePath(color);
    if (mapView.scale >= 3 || station.ownedByViewerAlliance) label(
      `${station.stationName}${station.ownerAllianceTag ? ` [${station.ownerAllianceTag}]` : ''}`,
      px, py + d + 4, color, 1);
  }

  const prioritized = [...overlays].sort((a, b) => Number(b.s.id === selectedSystemId) - Number(a.s.id === selectedSystemId) ||
    Number(b.owned) - Number(a.owned));
  for (const { s, px, py, owned, allyOwner } of prioritized) {
    if (owned || allyOwner || s.id === selectedSystemId) {
      const selected = s.id === selectedSystemId;
      const name = owned ? [mapPlayerName || `Player #${myUserId}`, allyOwner].filter(Boolean).join(', ')
        : allyOwner || s.name || `#${s.id}`;
      label(name, px, py + (selected ? 15 : 9),
        owned || allyOwner ? MAP_ALLY_COLOR : '#ffffff', owned || selected ? 0 : 2);
    }
  }
  const elements = labels.sort((a, b) => a.priority - b.priority).map(label => {
    const element = document.createElement('span');
    element.className = 'finder-map-label';
    element.textContent = label.text;
    element.style.color = label.color;
    element.style.visibility = 'hidden';
    labelLayer.appendChild(element);
    return { ...label, element };
  });
  // Measure native text together before placing it; never scale text with the canvas.
  const measured = elements.map(label => ({ ...label,
    width: label.element.offsetWidth, height: label.element.offsetHeight }));
  const occupied = [];
  for (const { x, y, element, width: labelWidth, height: labelHeight } of measured) {
    if (!(labelWidth > 0 && labelHeight > 0) || labelWidth > width - 4 || labelHeight > height - 4) continue;
    const left = Math.round(Math.max(2, Math.min(x - labelWidth / 2, width - labelWidth - 2)));
    for (const offset of [0, labelHeight, 2 * labelHeight]) {
      const top = Math.round(y + offset);
      if (top < 2 || top + labelHeight > height - 2) continue;
      if (occupied.some(box =>
        left < box.right && left + labelWidth > box.left && top < box.bottom && top + labelHeight > box.top)) continue;
      occupied.push({ left, right: left + labelWidth, top, bottom: top + labelHeight });
      element.style.left = `${left}px`;
      element.style.top = `${top}px`;
      element.style.visibility = '';
      break;
    }
  }
}

document.getElementById('f-map-zones').addEventListener('click', () => {
  mapZonesVisible = !mapZonesVisible;
  const button = document.getElementById('f-map-zones');
  setToggleState(button, mapZonesVisible);
  drawGalaxyMap();
});

for (const id of ['f-map-hubs', 'f-map-alliance']) {
  document.getElementById(id).addEventListener('click', () => {
    const visible = id === 'f-map-hubs' ? (mapHubsVisible = !mapHubsVisible)
      : (mapAllianceVisible = !mapAllianceVisible);
    const button = document.getElementById(id);
    setToggleState(button, visible);
    drawGalaxyMap();
  });
}

document.getElementById('f-map-stations').addEventListener('click', async () => {
  const button = document.getElementById('f-map-stations');
  if (mapStationsVisible) {
    mapStationsVisible = false;
  } else {
    const read = ++mapStationsRead, generation = finderGeneration;
    button.disabled = true;
    try {
      const response = await browser.runtime.sendMessage({ type: 'GET_STATION_INDEX' });
      if (generation !== finderGeneration || read !== mapStationsRead) return;
      if (response.error) throw new Error(response.error);
      if (!Array.isArray(response.stations)) throw new Error('Invalid station index response.');
      mapStations = response.stations;
      mapStationsVisible = true;
      setStatusText(document.getElementById('f-map-navigation-status'), '');
    } catch (error) {
      if (generation !== finderGeneration || read !== mapStationsRead) return;
      console.warn('[NexusOverseer] Station index failed:', error);
      setStatusText(document.getElementById('f-map-navigation-status'), `Stations could not be loaded: ${error.message}`);
    } finally {
      if (generation === finderGeneration && read === mapStationsRead) button.disabled = false;
    }
  }
  setToggleState(button, mapStationsVisible);
  drawGalaxyMap();
});

function findMapSystem(systemId) {
  const system = galaxySystems?.find(system => system.id === systemId);
  if (system) return system;
  const station = mapStationsVisible && mapStations.find(station => station.systemId === systemId);
  return station ? { id: station.systemId, name: station.systemName,
    x: station.systemX, y: station.systemY, visibility: 'unknown' } : null;
}

// Center the map on a system and select it (called from a results row).
export function focusSystem(systemId, center = true) {
  const canvas = document.getElementById('f-map');
  const s = findMapSystem(systemId);
  if (!s || !Number.isFinite(s.x) || !Number.isFinite(s.y)) {
    setStatusText(document.getElementById('f-map-navigation-status'), 'Cannot locate this system: saved coordinates are unavailable.');
    return;
  }
  if (!mapBounds) drawGalaxyMap();
  if (!mapBounds || !Number.isFinite(mapBounds.minX)) return;
  resizeMapCanvas(canvas);
  const { width, height } = mapDimensions(canvas);
  selectedSystemId = systemId;
  document.getElementById('f-map-search').value = s.name || `#${s.id}`;
  document.getElementById('f-map-search-clear').hidden = false;
  closeMapSuggestions();
  setStatusText(document.getElementById('f-map-match-status'), '');
  setStatusText(document.getElementById('f-map-navigation-status'), '');
  if (center) {
    mapView.scale = Math.max(mapView.scale, 4);
    mapView.ox = width / 2 - mapBaseX(canvas, s.x) * mapView.scale;
    mapView.oy = height / 2 - mapBaseY(canvas, s.y) * mapView.scale;
  }
  drawGalaxyMap();
  if (center) canvas.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

document.getElementById('f-map-search').addEventListener('input', updateMapSystemChoices);
document.getElementById('f-map-search').addEventListener('focus', updateMapSystemChoices);
document.getElementById('f-map-lookup').addEventListener('focusout', event => {
  if (!event.currentTarget.contains(event.relatedTarget)) closeMapSuggestions();
});
document.getElementById('f-map-search-clear').addEventListener('click', () => {
  const input = document.getElementById('f-map-search');
  input.value = '';
  updateMapSystemChoices();
  input.focus();
});
document.getElementById('f-map-search').addEventListener('keydown', event => {
  if (event.key === 'Escape') { event.preventDefault(); closeMapSuggestions(); return; }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    if (document.getElementById('f-map-systems').hidden) updateMapSystemChoices();
    if (!mapMatches.length) return;
    mapActiveMatch = mapActiveMatch < 0 ? (event.key === 'ArrowDown' ? 0 : mapMatches.length - 1)
      : (mapActiveMatch + (event.key === 'ArrowDown' ? 1 : -1) + mapMatches.length) % mapMatches.length;
    const options = document.getElementById('f-map-systems').children;
    for (let index = 0; index < options.length; index++) options[index].setAttribute('aria-selected', String(index === mapActiveMatch));
    event.target.setAttribute('aria-activedescendant', options[mapActiveMatch].id);
    options[mapActiveMatch].scrollIntoView({ block: 'nearest' });
    return;
  }
  if (event.key !== 'Enter') return;
  event.preventDefault();
  if (mapActiveMatch >= 0) { chooseMapSystem(mapMatches[mapActiveMatch]); return; }
  const matches = updateMapSystemChoices();
  const query = event.target.value.trim().toLowerCase();
  const exact = matches.filter(system => String(system.id) === query.replace(/^#/, '') || system.name?.toLowerCase() === query);
  if (exact.length === 1 || matches.length === 1) chooseMapSystem((exact.length === 1 ? exact[0] : matches[0]));
  else setStatusText(document.getElementById('f-map-navigation-status'),
    matches.length ? 'Multiple systems match. Choose a suggestion or use the arrow keys.' : 'No known system matches your search.');
});
document.getElementById('f-map-home').addEventListener('click', () => {
  if (mapHomeSystemId != null) focusSystem(mapHomeSystemId);
});
document.getElementById('f-map-reset').addEventListener('click', () => {
  mapView.scale = 1;
  mapView.ox = 0;
  mapView.oy = 0;
  drawGalaxyMap();
});
function zoomMap(factor) {
  const canvas = document.getElementById('f-map');
  resizeMapCanvas(canvas);
  const { width, height } = mapDimensions(canvas);
  const previous = mapView.scale;
  mapView.scale = Math.min(12, Math.max(1, previous * factor));
  mapView.ox = width / 2 - (width / 2 - mapView.ox) * mapView.scale / previous;
  mapView.oy = height / 2 - (height / 2 - mapView.oy) * mapView.scale / previous;
  drawGalaxyMap();
}
document.getElementById('f-map-zoom-in').addEventListener('click', () => zoomMap(1.5));
document.getElementById('f-map-zoom-out').addEventListener('click', () => zoomMap(1 / 1.5));

if (typeof ResizeObserver !== 'undefined') {
  new ResizeObserver(() => drawGalaxyMap()).observe(document.getElementById('f-map'));
}
window.addEventListener('resize', () => {
  closeMapSuggestions();
  drawGalaxyMap();
});
function watchMapPixelDensity() {
  const query = window.matchMedia?.(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
  query?.addEventListener('change', () => {
    drawGalaxyMap();
    watchMapPixelDensity();
  }, { once: true });
}
watchMapPixelDensity();

function hasFreeSlotMoon(hit) {
  return hit.slotMoons.some(moon => hasKnownOwnership(moon) && moon.userId === null);
}

function matchesSearchPlanet(planet, { types, minSize, minPlanetSlots }) {
  return (!types.length || types.includes(planet.planetType)) &&
    (!(minSize > 0) || Number.isFinite(planet.size) && planet.size >= minSize) &&
    (minPlanetSlots == null || planetSlots(planet) != null && planetSlots(planet) >= minPlanetSlots);
}

function searchSystemHits(system, data, config, restoring = false) {
  const { minMoons, minMoonSlots, moonTypes, maxDistance } = config;
  const hits = [];
  const moons = data.moons;
  const children = moonsByPlanet(moons);
  for (const planet of data.planets || []) {
    if (!matchesSearchPlanet(planet, config)) continue;
    const planetMoons = children.get(planet.id) || [];
    const count = Array.isArray(moons) ? planetMoons.length : null;
    if (minMoons > 0 && (count == null || count < minMoons)) continue;
    const matchingMoons = planetMoons.filter(moon => matchesSearchMoon(moon, config));
    if (moonTypes.length && !matchingMoons.length) continue;
    const slotMoons = minMoonSlots > 0 ? matchingMoons : [];
    if (!restoring && minMoonSlots > 0 && !slotMoons.some(moon => !hasKnownOwnership(moon) || moon.userId === null)) continue;
    hits.push({
      systemId: system.id, planetId: planet.id, userId: planet.userId,
      planet: planet.name || `Planet #${planet.id}`, system: system.name || `#${system.id}`,
      sector: system.sectorId - (system.armId - 1) * 50,
      type: planet.planetType, size: planet.size, slots: planetSlots(planet),
      moons: count, moonList: moonList(planetMoons), zone: system.securityZone || '—', distance: systemDistance(system),
      minMoonSlots, slotMoons, moonTypes, maxDistance,
      owner: planet.ownerName || null,
      ownershipKnown: hasKnownOwnership(planet),
      alliance: planet.ownerAllianceTag || null,
      ownershipAt: data._galaxyCache?.ownership?.planets || 0,
    });
  }
  return hits;
}

function storeLastSearch(clear = false) {
  if (!finderServerKey || !lastSearch && !clear) return Promise.resolve();
  const serverKey = finderServerKey;
  const generation = finderGeneration;
  if (lastSearch && !clear) {
    lastSearch.hits = finderHits.map(hit => ({ systemId: hit.systemId, planetId: hit.planetId }));
    lastSearch.sort = { ...finderSort };
    lastSearch.ownership = document.getElementById('f-ownership').value;
    lastSearch.excludeMine = document.getElementById('f-exclude-mine').checked;
  }
  const snapshot = clear ? null : structuredClone(lastSearch);
  searchStorageQueue = searchStorageQueue.then(async () => {
    try {
      await globalThis.nexusStorage.withServer(serverKey, () => snapshot
        ? browser.storage.local.set({ [LAST_SEARCH_KEY]: snapshot })
        : browser.storage.local.remove(LAST_SEARCH_KEY));
      if (generation === finderGeneration) setStatusText(document.getElementById('f-search-storage-status'), '');
    } catch (error) {
      console.error('[NexusOverseer] Could not persist Galaxy Scout search:', error);
      if (generation === finderGeneration) setStatusText(document.getElementById('f-search-storage-status'),
        `${clear ? 'Could not clear saved search' : 'Search could not be saved'}: ${error.message}`);
    }
  });
  return searchStorageQueue;
}

async function restoreLastSearch(generation) {
  try {
    const serverKey = finderServerKey;
    await searchStorageQueue;
    if (generation !== finderGeneration) return;
    const stored = await globalThis.nexusStorage.withServer(serverKey, () => browser.storage.local.get(LAST_SEARCH_KEY));
    if (generation !== finderGeneration || !stored[LAST_SEARCH_KEY]) return;
    const saved = stored[LAST_SEARCH_KEY];
    const config = saved.config;
    if (saved.version !== 1 || !config || typeof saved.summary !== 'string' ||
        !['arm', 'sector', 'origin'].every(key => typeof config[key] === 'string') ||
        !['types', 'moonTypes', 'zones'].every(key => Array.isArray(config[key]) && config[key].every(value => typeof value === 'string')) ||
        !['minSize', 'minMoons', 'minMoonSlots'].every(key => Number.isSafeInteger(config[key]) && config[key] >= 0) ||
        config.minPlanetSlots != null && (!Number.isSafeInteger(config.minPlanetSlots) || config.minPlanetSlots < 0) ||
        config.maxDistance != null && (!Number.isSafeInteger(config.maxDistance) || config.maxDistance < 0) ||
        !Array.isArray(saved.hits) || !saved.hits.every(hit => Number.isSafeInteger(hit?.systemId) && Number.isSafeInteger(hit?.planetId))) {
      throw new Error('Invalid saved search. Use Clear search to remove it.');
    }
    if (config.types.some(type => !PLANET_TYPES.includes(type)) || config.moonTypes.some(type => !MOON_TYPES.includes(type))) {
      throw new Error('Saved search contains unsupported planet or moon types. Use Clear search and select valid types.');
    }
    const scans = await loadGalaxyScans();
    if (generation !== finderGeneration) return;
    lastSearch = saved;
    searchSummary = saved.summary;
    finderScans = scans;
    document.getElementById('f-arm').value = config.arm;
    document.getElementById('f-sector').value = config.sector;
    updateSectorInput();
    const origin = myPlanets.find(planet => String(planet.id) === config.origin);
    if (origin) {
      document.getElementById('f-origin').value = config.origin;
      homeSys = { x: origin.systemX, y: origin.systemY };
    } else if (config.origin) {
      homeSys = null;
      document.getElementById('f-origin').value = '';
      setStatusText(document.getElementById('f-search-storage-status'),
        'Saved origin is no longer available. Select an origin and rerun Search for distance-limited results.');
    }
    for (const [id, key] of [['f-min-size', 'minSize'], ['f-min-moons', 'minMoons'],
      ['f-min-moon-slots', 'minMoonSlots'], ['f-min-planet-slots', 'minPlanetSlots'], ['f-max-distance', 'maxDistance']]) {
      document.getElementById(id).value = config[key] == null ? '' : String(config[key]);
    }
    searchTypes.types = config.types;
    searchTypes.moonTypes = config.moonTypes;
    finderZones.clear();
    for (const zone of config.zones) finderZones.add(zone);
    drawFinderZones();
    drawSearchTypeFilters();
    const references = new Map();
    for (const hit of saved.hits) {
      if (!references.has(hit.systemId)) references.set(hit.systemId, new Set());
      references.get(hit.systemId).add(hit.planetId);
    }
    finderHits = galaxySystems.flatMap(system => {
      const ids = references.get(system.id);
      return ids ? searchSystemHits(system, scans[system.id]?.data || {}, config, true).filter(hit => ids.has(hit.planetId)) : [];
    });
    if (saved.sort && ['planet', 'system', 'sector', 'type', 'size', 'slots', 'moons', 'zone', 'distance', 'owner', 'alliance'].includes(saved.sort.key) &&
        [1, -1].includes(saved.sort.dir)) finderSort = saved.sort;
    document.getElementById('f-ownership').value = ['owned', 'unowned'].includes(saved.ownership) ? saved.ownership : '';
    document.getElementById('f-exclude-mine').checked = saved.excludeMine === true;
    document.getElementById('f-directory-scope').value = 'matches';
    document.getElementById('f-check-ownership').disabled = !finderHits.length;
    setStatusText(document.getElementById('f-progress'),
      `Saved search · ${finderHits.length} matching planets${saved.phase === 'complete' ? '' : ' · incomplete; rerun to continue'}`);
    setStatusText(document.getElementById('f-ownership-progress'), finderHits.length ? 'Using saved ownership; may be outdated.' : '');
  } catch (error) {
    if (generation !== finderGeneration) return;
    console.error('[NexusOverseer] Could not restore Galaxy Scout search:', error);
    setStatusText(document.getElementById('f-search-storage-status'), `Saved search could not be loaded: ${error.message}`);
  }
}

document.getElementById('f-clear-search').addEventListener('click', async function () {
  clearingSearch = true;
  this.disabled = true;
  finderGeneration++;
  directoryRead++;
  finderRunning = false;
  ownershipRunning = false;
  lastSearch = null;
  searchSummary = '';
  finderHits = [];
  finderSort = { key: 'size', dir: -1 };
  document.getElementById('f-search-issues').hidden = true;
  document.getElementById('f-search-issues-list').textContent = '';
  selectedSystemId = null;
  setStatusText(document.getElementById('f-map-navigation-status'), '');
  document.getElementById('f-arm').value = 'all';
  document.getElementById('f-sector').value = '';
  updateSectorInput();
  for (const id of ['f-min-size', 'f-min-moons', 'f-min-moon-slots']) document.getElementById(id).value = '0';
  for (const id of ['f-min-planet-slots', 'f-max-distance', 'f-ownership']) document.getElementById(id).value = '';
  document.getElementById('f-exclude-mine').checked = false;
  searchTypes.types = [];
  searchTypes.moonTypes = [];
  finderZones.clear();
  drawFinderZones();
  drawSearchTypeFilters();
  document.getElementById('f-directory-scope').value = 'all';
  for (const state of Object.values(directoryStates)) state.page = 0;
  document.getElementById('f-search').textContent = 'Search';
  document.getElementById('f-search').disabled = false;
  document.getElementById('f-check-ownership').textContent = 'Check result ownership';
  document.getElementById('f-check-ownership').disabled = true;
  setStatusText(document.getElementById('f-progress'), 'Search cleared. Saved galaxy knowledge is unchanged.');
  setStatusText(document.getElementById('f-ownership-progress'), '');
  renderFinderResults();
  drawGalaxyMap();
  await storeLastSearch(true);
  clearingSearch = false;
  this.disabled = false;
});

// A planet's moons as [{ type, slots }] (slots = building slots).
function moonList(moons) {
  return moons.map(m => ({ type: (m.moonType || '?').replace(/_/g, ' '), slots: m.buildingSlots ?? 0 }));
}

// Fill a moon cell: game-coloured type and building slots per moon.
function buildMoonCell(td, list) {
  if (!list || !list.length) { td.textContent = '—'; return; }
  list.forEach((m, i) => {
    if (i) td.appendChild(document.createTextNode(', '));
    td.appendChild(typeBadge(m.type, 'moons'));
    td.appendChild(document.createTextNode(` (${m.slots})`));
  });
}

document.getElementById('f-search').addEventListener('click', async function () {
  if (ownershipRunning || clearingSearch) return;
  if (finderRunning) {
    finderRunning = false;
    this.disabled = true;
    return;
  }
  if (!galaxySystems) return;

  const region = regionSectorIds();
  const status = document.getElementById('f-progress');
  const numericIds = ['f-min-size', 'f-min-moons', 'f-min-moon-slots', 'f-min-planet-slots', 'f-max-distance'];
  const inputs = numericIds.map(id => document.getElementById(id));
  if (inputs.some(input => input.validity?.badInput || input.value.trim() !== '' &&
      (!Number.isSafeInteger(Number(input.value)) || Number(input.value) < 0))) {
    setStatusText(status, 'Search limits require non-negative whole numbers.');
    return;
  }
  const [minSize, minMoons, minMoonSlots] = inputs.map(input => Number(input.value));
  const minPlanetSlots = inputs[3].value.trim() === '' ? null : Number(inputs[3].value);
  const maxDistance = inputs[4].value.trim() === '' ? null : Number(inputs[4].value);
  if (maxDistance != null && (!homeSys || ![homeSys.x, homeSys.y].every(Number.isFinite))) {
    setStatusText(status, 'Select an available origin to use Max distance.');
    return;
  }
  const types = [...searchTypes.types];
  const moonTypes = [...searchTypes.moonTypes];
  const zones = new Set(finderZones);
  const generation = ++finderGeneration;
  const config = {
    types, moonTypes, minSize, minMoons, minMoonSlots, minPlanetSlots, maxDistance, zones: [...zones],
    arm: document.getElementById('f-arm').value, sector: document.getElementById('f-sector').value,
    origin: String(document.getElementById('f-origin').value),
  };
  const matchesPlanet = planet => matchesSearchPlanet(planet, config);
  const arm = finderArms.find(arm => arm.id === region.armId)?.name || 'All arms';
  const summary = `${arm}${region.armId == null ? '' : `, sectors ${region.from}-${region.to}`} · ${types.join(', ') || 'any type'} · size ≥ ${minSize}${minPlanetSlots == null ? '' : ` · planet slots ≥ ${minPlanetSlots}`} · moons ≥ ${minMoons} · moon types ${moonTypes.join(', ') || 'any'} · free moon slots ≥ ${minMoonSlots}${maxDistance == null ? '' : ` · distance ≤ ${maxDistance}`} · zones ${[...zones].join(', ') || 'all'}`;

  directoryRead++;
  finderRunning = true;
  this.textContent = 'Stop';
  document.getElementById('f-check-ownership').disabled = true;
  setStatusText(document.getElementById('f-ownership-progress'), '');
  setStatusText(status, 'Searching saved data…');
  finderHits = [];
  searchSummary = summary;
  document.getElementById('f-search-issues').hidden = true;
  document.getElementById('f-search-issues-list').textContent = '';
  lastSearch = { version: 1, config, summary, phase: 'running', hits: [] };
  renderFinderResults();
  drawGalaxyMap();
  await storeLastSearch();
  if (generation !== finderGeneration) return;
  let cache;
  try { cache = await loadGalaxyScans(); }
  catch (error) {
    if (generation !== finderGeneration) return;
    finderRunning = false;
    this.textContent = 'Search';
    this.disabled = false;
    document.getElementById('f-check-ownership').disabled = !finderHits.length;
    setStatusText(status, `Error: ${error.message}`);
    lastSearch.phase = 'stopped';
    await storeLastSearch();
    return;
  }
  if (generation !== finderGeneration) return;
  if (!finderRunning) {
    this.textContent = 'Search';
    this.disabled = false;
    document.getElementById('f-check-ownership').disabled = !finderHits.length;
    return;
  }
  const inRange = galaxySystems.filter(s =>
    (region.armId == null || (s.armId === region.armId && s.sectorId >= region.min && s.sectorId <= region.max)) &&
    (maxDistance == null || systemDistance(s) != null && systemDistance(s) <= maxDistance) &&
    (!zones.size || zones.has(s.securityZone)));
  const needsMoons = minMoons > 0 || minMoonSlots > 0 || moonTypes.length > 0;
  const publicMoonSlotsMissing = data => minMoonSlots > 0 && data?._galaxyCache?.publicGroups?.includes('moons') &&
    !data._galaxyCache.times.moons && data.moons.some(moon =>
      (!moonTypes.length || moonTypes.includes(moon.moonType)) && !Number.isFinite(moon.buildingSlots));
  const candidates = inRange.filter(system => {
    if (system.visibility === 'full') return true;
    const entry = cache[system.id];
    if (publicMoonSlotsMissing(entry?.data)) return false;
    if (!systemCacheFresh(entry, 'static', undefined, Date.now(), 'planets')) return false;
    return !needsMoons || !entry.data.planets.some(matchesPlanet) ||
      systemCacheFresh(entry, 'static', undefined, Date.now(), 'moons');
  });

  finderHits = [];
  finderScans = cache;
  directoryError = '';
  document.getElementById('f-directory-scope').value = 'matches';
  for (const state of Object.values(directoryStates)) state.page = 0;
  hitSystems = {};
  allianceSystems = {};

  let done = 0, successful = 0, errors = 0, unavailable = 0, rateLimited = false;
  const reportIssue = (system, reason) => {
    const item = document.createElement('li');
    item.textContent = `${system.name || `#${system.id}`} (#${system.id}): ${reason}`;
    document.getElementById('f-search-issues-list').appendChild(item);
    document.getElementById('f-search-issues-summary').textContent = `Search issues (${errors + unavailable + Number(rateLimited)})`;
    document.getElementById('f-search-issues').hidden = false;
  };
  let completed;
  try {
    for (const s of candidates) {
      if (!finderRunning) break;
      let data;
      try {
        setStatusText(status, `${systemCacheFresh(cache[s.id], 'static', undefined, Date.now(), 'planets')
          ? 'Searching saved data' : 'Loading missing data'} · system ${done + 1}/${candidates.length}`);
        data = await getSystemPlanets(s.id, cache, { purpose: 'static', group: 'planets' });
        if (generation !== finderGeneration || !finderRunning) break;
        if (needsMoons && (data.planets || []).some(matchesPlanet)) {
          const forceMoons = publicMoonSlotsMissing(data);
          if (forceMoons || !systemCacheFresh(cache[s.id], 'static', undefined, Date.now(), 'moons')) {
            setStatusText(status, `Loading missing moon data · system ${done + 1}/${candidates.length}`);
          }
          data = await getSystemPlanets(s.id, cache, { purpose: 'static', group: 'moons', force: forceMoons });
        }
      } catch (error) {
        if (generation !== finderGeneration || !finderRunning) break;
        console.warn(`[NexusOverseer] Galaxy search skipped system ${s.id}:`, error);
        if (error.status === 429) {
          rateLimited = true;
          reportIssue(s, 'HTTP 429: API rate limit. Search stopped.');
          break;
        }
        if (error.code === 'GALAXY_DATA_UNAVAILABLE') {
          unavailable++;
          reportIssue(s, `${error.message} Missing details stay unknown. Automatic requests are paused for up to 15 minutes.`);
        } else {
          errors++;
          reportIssue(s, `${error.status ? `HTTP ${error.status}: ` : ''}${error.message}`);
        }
        done++;
        continue;
      }
      if (generation !== finderGeneration || !finderRunning) break;
      finderHits.push(...searchSystemHits(s, data, config));
      done++;
      successful++;
      if (done % 10 === 0) {
        setStatusText(status, `Searching saved data · ${done}/${candidates.length} systems · ${finderHits.length} matches`);
        renderFinderResults();
        drawGalaxyMap();
      }
      if (done % 25 === 0) {
        await storeLastSearch();
        if (generation !== finderGeneration) return;
        await new Promise(r => setTimeout(r, 0));
      }
    }
    completed = !rateLimited && finderRunning && done === candidates.length;
  } finally {
    if (generation === finderGeneration) {
      finderRunning = false;
      this.textContent = 'Search';
      this.disabled = false;
      document.getElementById('f-check-ownership').disabled = !finderHits.length;
    }
  }
  if (generation !== finderGeneration) return;
  lastSearch.phase = completed && !errors && !unavailable ? 'complete' : 'stopped';

  setStatusText(status, `${rateLimited ? 'Stopped: API rate limit (429). Retry the search later; saved results are retained' : errors || unavailable ? 'Incomplete' : 'Done'}: ${finderHits.length} matches in ${successful} scanned systems` +
    (!candidates.length ? ' · no searchable systems for these filters' : '') +
    (unavailable ? ` · ${unavailable} systems with unavailable details` : '') +
    (errors ? ` · ${errors} systems failed (see Search issues)` : '') + '.');
  renderFinderResults();
  drawGalaxyMap();
  await storeLastSearch();
  if (generation !== finderGeneration) return;
  if (completed) await checkResultOwnership(false);
});

document.getElementById('f-check-ownership').addEventListener('click', async function () {
  if (ownershipRunning) { ownershipRunning = false; this.disabled = true; return; }
  await checkResultOwnership(true);
});

async function checkResultOwnership(force) {
  if (finderRunning || !finderHits.length) return;
  const generation = finderGeneration;
  const button = document.getElementById('f-check-ownership');
  const status = document.getElementById('f-ownership-progress');
  const needsMoonOwnership = hit => hit.minMoonSlots > 0 && !hasFreeSlotMoon(hit) &&
    hit.slotMoons.some(moon => !hasKnownOwnership(moon));
  const accessible = hit => !finderScans[hit.systemId]?.data._galaxyCache?.publicSource ||
    !!finderScans[hit.systemId]?.data._galaxyCache?.times?.planets ||
    galaxySystems.some(system => system.id === hit.systemId && system.visibility === 'full');
  const systemIds = [...new Set(finderHits.filter(hit => accessible(hit) &&
    (force || !hit.ownershipKnown || needsMoonOwnership(hit))).map(hit => hit.systemId))];
  if (!systemIds.length) {
    setStatusText(status, finderHits.some(hit => !accessible(hit))
      ? 'Public base data does not grant explored visibility. Ownership remains unknown for unexplored systems.'
      : 'Using saved ownership; may be outdated.');
    return;
  }
  ownershipRunning = true;
  directoryRead++;
  button.textContent = 'Stop ownership check';
  document.getElementById('f-search').disabled = true;
  let checked = 0, errors = 0, rateLimited = false;
  const cache = {};
  try {
    for (const systemId of systemIds) {
      if (!ownershipRunning || generation !== finderGeneration) break;
      setStatusText(status, `Checking ownership… ${checked}/${systemIds.length} matching systems.`);
      try {
        const group = finderHits.some(hit => hit.systemId === systemId && hit.minMoonSlots > 0) ? 'both' : 'planets';
        const data = await getSystemPlanets(systemId, cache, { group, force: true });
        if (generation !== finderGeneration) return;
        finderScans[systemId] = { data, at: Date.now() };
        updateResultOwnership(systemId, data);
      } catch (error) {
        if (generation !== finderGeneration) return;
        errors++;
        console.warn(`[NexusOverseer] Ownership check failed for system ${systemId}:`, error);
        if (error.status === 429) {
          rateLimited = true;
          break;
        }
      }
      checked++;
      renderFinderResults();
      drawGalaxyMap();
    }
    if (generation !== finderGeneration) return;
    setStatusText(status, `${rateLimited ? 'Stopped: API rate limit (429). Retry later' : ownershipRunning ? 'Done' : 'Stopped'}: checked ${checked}/${systemIds.length} matching systems` +
      (errors ? ` · ${errors} errors; failed updates keep the last known state` : '') + '.');
    renderFinderResults();
    drawGalaxyMap();
    await storeLastSearch();
  } finally {
    if (generation === finderGeneration) {
      ownershipRunning = false;
      button.textContent = 'Check result ownership';
      button.disabled = false;
      document.getElementById('f-search').disabled = false;
    }
  }
}

function updateResultOwnership(systemId, data, hits = finderHits.filter(hit => hit.systemId === systemId)) {
  const byId = new Map((data.planets || []).map(planet => [planet.id, planet]));
  const children = moonsByPlanet(data.moons);
  for (const hit of hits) {
    if (Array.isArray(data.moons)) {
      const moons = children.get(hit.planetId) || [];
      hit.moonList = moonList(moons);
      hit.moons = moons.length;
      if (hit.minMoonSlots > 0) hit.slotMoons = moons.filter(moon => matchesSearchMoon(moon, hit));
    }
    const planet = byId.get(hit.planetId);
    if (!planet || !hasKnownOwnership(planet)) continue;
    hit.ownershipKnown = true;
    hit.userId = planet.userId;
    hit.owner = planet.ownerName || null;
    hit.alliance = planet.ownerAllianceTag || null;
    if (planet.name) hit.planet = planet.name;
    hit.ownershipAt = data._galaxyCache?.ownership?.planets || 0;
  }
}

for (const id of ['f-ownership', 'f-exclude-mine']) {
  document.getElementById(id).addEventListener('change', () => {
    renderFinderResults();
    drawGalaxyMap();
    return storeLastSearch();
  });
}

export let finderSort = { key: 'size', dir: -1 };

document.getElementById('f-results-head').addEventListener('click', e => {
  const th = e.target.closest('th.sortable');
  if (!th) return;
  const key = th.dataset.key;
  finderSort = { key, dir: finderSort.key === key ? -finderSort.dir : -1 };
  renderFinderResults();
  return storeLastSearch();
});

function visibleFinderHits() {
  const ownership = document.getElementById('f-ownership').value;
  const excludeMine = document.getElementById('f-exclude-mine').checked;
  return finderHits.filter(hit => {
    if (hit.maxDistance != null && (hit.distance == null || hit.distance > hit.maxDistance)) return false;
    if (hit.minMoonSlots > 0 && !hasFreeSlotMoon(hit)) return false;
    if ((ownership || excludeMine) && !hit.ownershipKnown) return false;
    if (ownership === 'unowned' && hit.userId != null) return false;
    if (ownership === 'owned' && hit.userId == null) return false;
    return !excludeMine || myUserId == null || hit.userId !== myUserId;
  });
}

export function renderFinderResults() {
  const visible = visibleFinderHits();
  renderFinderDirectory();
  document.getElementById('f-match-count').textContent = `${visible.length} shown / ${finderHits.length} matching planets`;
  if (galaxySystems) setStatusText(document.getElementById('f-map-status'),
    `${galaxySystems.length} known systems${searchSummary ? ` · ${visible.length} matching planets in ${new Set(visible.map(hit => hit.systemId)).size} systems` : ''}`);
  hitSystems = {};
  rebuildMapAllianceSystems();
  for (const hit of visible) {
    if (!hitSystems[hit.systemId]) hitSystems[hit.systemId] = { planets: [] };
    const moonDetails = hit.moonList.map(moon => `${moon.type} (${moon.slots} slots)`).join(', ');
    hitSystems[hit.systemId].planets.push(`${hit.planet} (${hit.type}, ${hit.size}, ${hit.moons ?? '?'} moons${moonDetails ? ': ' + moonDetails : ''})`);
  }
  if (isDirectoryView()) return;
  const tbody = document.getElementById('f-results-tbody');
  tbody.textContent = '';

  // Header arrows
  document.querySelectorAll('#f-results-head th.sortable').forEach(th => {
    th.setAttribute('aria-sort', th.dataset.key === finderSort.key
      ? finderSort.dir === 1 ? 'ascending' : 'descending' : 'none');
    const old = th.querySelector('.arrow');
    if (old) old.remove();
    if (th.dataset.key === finderSort.key) {
      const arrow = document.createElement('span');
      arrow.className = 'arrow';
      arrow.textContent = finderSort.dir === -1 ? ' ↓' : ' ↑';
      (th.querySelector('button') || th).appendChild(arrow);
    }
  });

  const { key, dir } = finderSort;
  const sorted = visible.slice().sort((a, b) => {
    const va = a[key], vb = b[key];
    let cmp;
    if (va == null && vb == null) cmp = 0;
    else if (va == null) cmp = 1;          // nulls (e.g. no distance) sort last
    else if (vb == null) cmp = -1;
    else if (typeof va === 'number' && typeof vb === 'number') cmp = va - vb;
    else cmp = String(va).localeCompare(String(vb));
    return cmp * dir || b.size - a.size;
  });
  for (const h of sorted) {
    const tr = document.createElement('tr');
    const cells = [h.planet, h.system, String(h.sector), String(h.type ?? '—').replace(/_/g, ' '),
                   String(h.size), (h.slots == null ? '—' : String(h.slots)),
                   null,   // moon cell built below (coloured type + size)
                   h.zone || '—', (h.distance == null ? '—' : String(h.distance)),
                   h.ownershipKnown === false ? 'unknown' : h.owner || (h.userId == null ? 'unowned' : `Player #${h.userId}`),
                   h.alliance || '—'];
    cells.forEach((v, i) => {
      const td = document.createElement('td');
      if (i === 6) buildMoonCell(td, h.moonList);
      else if (i === 7) td.appendChild(zoneBadge(h.zone));
      else td.textContent = v;
      if (i === 0) appendGalaxyImage(td, 'planets', { planetType: h.type }, galaxyImageOrigin);
      if (i === 1) td.className = 'finder-parent-reference';
      if (i === 3) {
        td.textContent = '';
        td.appendChild(typeBadge(h.type, 'planets'));
      }
      if (i === 9) {
        td.textContent = '';
        const owner = { userId: h.userId, ownershipKnown: h.ownershipKnown, ownerName: h.owner };
        td.appendChild(ownershipBadge(directoryOwnership(owner), directoryOwner(owner)));
      }
      if (i === 5) td.title = 'Building-slot capacity; calculated base slots when no explicit capacity is saved. Not unused slots.';
      if (i === 10 && h.alliance) {
        td.textContent = '';
        td.appendChild(allianceBadge(h.alliance));
      }
      if (i === 9 || i === 10) td.title = h.ownershipAt
        ? `Ownership last checked: ${new Date(h.ownershipAt).toLocaleString()}`
        : 'Ownership has not been verified.';
      tr.appendChild(td);
    });
    const actions = document.createElement('td');
    actions.appendChild(directoryActions(h.systemId, 'planets', h.planetId));
    tr.appendChild(actions);
    tbody.appendChild(tr);
  }
}

// canvas-space cursor coords (account for CSS scaling of the canvas)
export function mapCursor(canvas, e) {
  const rect = canvas.getBoundingClientRect();
  const { width, height } = mapDimensions(canvas);
  return {
    x: (e.clientX - rect.left) * (width / rect.width),
    y: (e.clientY - rect.top) * (height / rect.height),
    rect,
  };
}

export let mapPan = null;   // { sx, sy, ox, oy } while dragging

function closeMapInfo() {
  mapInfoSystemId = null;
  document.getElementById('f-map-info').hidden = true;
}

function nearestMapSystem(canvas, event) {
  const { x, y, rect } = mapCursor(canvas, event);
  let nearest = null, distance = 8 * mapDimensions(canvas).width / rect.width;
  for (const [id, point] of mapPoints) {
    const next = Math.hypot(point.x - x, point.y - y);
    if (next < distance) { nearest = id; distance = next; }
  }
  return findMapSystem(nearest);
}

document.getElementById('f-map').addEventListener('click', event => {
  if (mapDragged) { mapDragged = false; return; }
  const canvas = event.currentTarget;
  const system = nearestMapSystem(canvas, event);
  closeMapInfo();
  if (!system) return;
  focusSystem(system.id, false);
  mapInfoSystemId = system.id;
  document.getElementById('f-tooltip').style.display = 'none';
  document.getElementById('f-map-info-title').textContent = `${system.name || 'Unnamed system'} (#${system.id})`;
  const data = finderScans[system.id]?.data;
  const count = group => Array.isArray(data?.[group]) ? `${data[group].length} saved` : 'not saved';
  document.getElementById('f-map-info-details').textContent = [
    `Star: ${system.starType?.replace(/_/g, ' ') || 'unknown'}`,
    `Zone: ${system.securityZone || 'unknown'} · Visibility: ${system.visibility || 'unknown'}`,
    system._publicSource ? 'Includes public base data; visibility and ownership are separate.' : '',
    myOwnedSystems.has(system.id) ? `Your colony: ${mapPlayerName || `Player #${myUserId}`}` : '',
    allianceSystems[system.id] ? `Alliance (saved): ${allianceSystems[system.id]}` : '',
    `Planets: ${count('planets')} · Moons: ${count('moons')}`,
    ...mapStations.filter(station => mapStationsVisible && station.systemId === system.id).map(station =>
      `Station: ${station.stationName} · ${station.ownerAllianceTag ? `[${station.ownerAllianceTag}]` : station.ownerAllianceName || (station.ownerAllianceId ? `Alliance #${station.ownerAllianceId}` : station._publicSource && !station._observedAt ? 'Ownership unknown' : 'Unclaimed')}${station.capturingAllianceTag ? ` · Capture: [${station.capturingAllianceTag}]` : ''} (last known)`),
  ].filter(Boolean).join('\n');
  const info = document.getElementById('f-map-info');
  info.hidden = false;
  const { width, height } = mapDimensions(canvas);
  const point = mapPoints.get(system.id);
  info.style.left = `${Math.max(8, Math.min(point.x + 14, width - info.offsetWidth - 8))}px`;
  info.style.top = `${Math.max(8, Math.min(point.y + 14, height - info.offsetHeight - 8))}px`;
  document.getElementById('f-map-info-overview').focus({ preventScroll: true });
});
document.getElementById('f-map-info-close').addEventListener('click', () => {
  closeMapInfo();
  document.getElementById('f-map-search').focus();
});
document.getElementById('f-map-info-overview').addEventListener('click', () => {
  const id = mapInfoSystemId;
  closeMapInfo();
  if (id != null) openSystemOverview(id);
});
window.addEventListener('keydown', event => {
  if (event.key === 'Escape') closeMapInfo();
});
window.addEventListener('mousedown', event => {
  if (!document.getElementById('f-map-info').contains(event.target)) closeMapInfo();
});

// Hover tooltips use saved data only and are suppressed while panning.
document.getElementById('f-map').addEventListener('mousemove', e => {
  const canvas = e.currentTarget;
  if (mapPan) {
    const { x, y } = mapCursor(canvas, e);
    if (Math.hypot(x - mapPan.sx, y - mapPan.sy) < 4 && !mapDragged) return;
    mapDragged = true;
    mapView.ox = mapPan.ox + (x - mapPan.sx);
    mapView.oy = mapPan.oy + (y - mapPan.sy);
    drawGalaxyMap();
    return;
  }
  if (mapInfoSystemId != null) return;
  const { rect } = mapCursor(canvas, e);
  const tip = document.getElementById('f-tooltip');
  const system = nearestMapSystem(canvas, e);
  if (system) {
    tip.textContent = [
      system.name || 'Unnamed system', system.securityZone || 'Unknown zone',
      `Visibility: ${system.visibility || 'unknown'}`,
      `Star: ${system.starType?.replace(/_/g, ' ') || 'unknown'}`,
      myOwnedSystems.has(system.id) ? 'Your colony' : '',
      allianceSystems[system.id] ? `Alliance (saved): ${allianceSystems[system.id]}` : '',
      ...(hitSystems[system.id]?.planets || []),
      ...mapStations.filter(station => mapStationsVisible && station.systemId === system.id)
        .map(station => `Station: ${station.stationName}`),
    ].filter(Boolean).join(' · ');
    tip.style.display = 'block';
    tip.style.left = `${Math.max(12, Math.min(e.clientX - rect.left + 14, rect.width - tip.offsetWidth))}px`;
    tip.style.top = `${Math.max(12, Math.min(e.clientY - rect.top + 14, rect.height - tip.offsetHeight))}px`;
    return;
  }
  tip.style.display = 'none';
});
document.getElementById('f-map').addEventListener('mouseleave', () => {
  document.getElementById('f-tooltip').style.display = 'none';
});

// Drag to pan
document.getElementById('f-map').addEventListener('mousedown', e => {
  if (e.button !== 0) return;
  const canvas = e.currentTarget;
  const { x, y } = mapCursor(canvas, e);
  mapDragged = false;
  document.getElementById('f-tooltip').style.display = 'none';
  mapPan = { sx: x, sy: y, ox: mapView.ox, oy: mapView.oy };
  canvas.style.cursor = 'grabbing';
});
window.addEventListener('mouseup', () => {
  if (!mapPan) return;
  mapPan = null;
  const canvas = document.getElementById('f-map');
  if (canvas) canvas.style.cursor = 'crosshair';
});

// Wheel to zoom toward the cursor
document.getElementById('f-map').addEventListener('wheel', e => {
  if (!galaxySystems) return;
  e.preventDefault();
  const canvas = e.currentTarget;
  const { x, y } = mapCursor(canvas, e);
  const bx = (x - mapView.ox) / mapView.scale;   // base-space point under cursor
  const by = (y - mapView.oy) / mapView.scale;
  const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
  mapView.scale = Math.min(12, Math.max(1, mapView.scale * factor));
  mapView.ox = x - bx * mapView.scale;
  mapView.oy = y - by * mapView.scale;
  drawGalaxyMap();
}, { passive: false });

['f-arm', 'f-sector'].forEach(id => {
  document.getElementById(id).addEventListener(id === 'f-arm' ? 'change' : 'input', () => {
    if (id === 'f-arm') updateSectorInput();
  });
});

// Change the distance origin to another of the player's planets, recomputing
// distances for the current results.
document.getElementById('f-origin').addEventListener('change', e => {
  const p = myPlanets.find(x => x.id === Number(e.target.value));
  if (!p) return;
  homeSys = { x: p.systemX, y: p.systemY };
  finderHits.forEach(h => {
    const s = galaxySystems && galaxySystems.find(x => x.id === h.systemId);
    h.distance = s ? systemDistance(s) : null;
  });
  drawGalaxyMap();
  renderFinderResults();
  if (lastSearch) {
    lastSearch.config.origin = String(e.target.value);
    void storeLastSearch();
  }
});
