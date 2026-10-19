// User Guide content, shared by the in-game overlay (guide-view.js) and the
// dashboard's User Guide tab (tabs/guide.js). Classic script so it can run as a
// content script; exposes the sections and a renderer on globalThis. The
// nx-guide-* classes are styled in theme.css.

// [section title, [ [lead, text], … ]]. `lead` is bolded; text may be ''.
globalThis.NX_GUIDE_SECTIONS = [
  ['Getting started', [
    ['Nexus Overseer', 'The main dashboard: opens in a new tab from the sidebar. Aggregates every report over time into charts, stat cards and sortable tables. Navigate with the sidebar on the left; on narrow windows it collapses behind the ☰ menu button.'],
    ['In-game tools', 'User Guide opens from the Addon section of the sidebar; the Quartermaster opens from the 📦 button in the top bar; the upgrade/build planners sit on building, research and ship cards. All render as overlays/panels on the game page itself.'],
    ['Servers', 'Data is kept separately per server. Use the server picker at the top of the dashboard to choose which server to view.'],
    ['Data', 'Use Statistics > Scrape Now to fetch report data through your logged-in game tab. Report data and preferences are stored locally in your browser, not on a server operated by the addon author. Backups are written to Downloads/NexusOverseer before each update and automatically (weekly by default, see Options).'],
  ]],
  ['Dashboard tabs', [
    ['Dashboard', 'Default tab: total resources and hourly production across all planets and moons, active missions with fleet slots, a "Needs attention" box, an empire summary, and a card per planet/moon with its construction queue, shipyard queue and hangar fleet by class. Hints cover idle research labs, planets without construction, nearly full storage, command ship repair, damaged ships and unspent talent points; Options can also enable hints for idle shipyards and free fleet, colony or moon slots. Refresh in the top-right header updates the overview immediately.'],
    ['Statistics', 'All recorded activity, split into sub-tabs: see below. The top-right header shows the latest scrape status; Scrape Now fetches data immediately.'],
    ['Asteroids', 'Scan the nearest systems for asteroid fields (filter by multiplier, quantity, remaining %, type and zone) with distance, fuel cost and a ship recommendation per field. 🚀 on a row opens the fleet editor seeded from that recommendation.'],
    ['Galaxy Scout', 'Search explored systems for planets by arm, sector, type, size, temperature, moons, zone and ownership, sorted by distance from a chosen origin. Owners show alliance and military/economy/research rank. Moons show type (colour-coded) + building slots.'],
    ['Pirates', 'Known pirate camps; fleets start from a chosen planet or, with Nearest planet enabled, the nearest owned planet with suitable ships. Scout a camp with a template, or attack it: the fleet editor\'s "Calculate fleet" suggests an attack fleet from the ships you have available. Attack ships selects the allowed ship types from a template, not fixed quantities; All ships (strongest) leaves the choice unrestricted. Below: pirate reports, loot vs. losses, loot per period and outcome breakdown.'],
    ['Fleets', 'Named, planet-agnostic fleet templates for mining, scouting and pirate fleet selection. Mining ships are colour-coded by what they mine (see the legend); a template can carry an escort per zone.'],
    ['Simulator', 'Combat calculator backed by the game\'s own simulator. Load your fleet from any planet, fill the defender from an intel report, set tech bonuses, then see the outcome round by round with losses and debris. Also shows the distance between two coordinates.'],
    ['Market', 'All open offers on the public or alliance market, filtered by resource and minimum ratio and coloured by how good the deal is vs. the market average. Below: your trade history with estimated profit (ore-equivalent, after fees) and net resource flow.'],
    ['Tech Tree', 'Dependency graph of all research with branch filter and search. Click + on a tech to plan it (prerequisites included) into a research queue and pick the planet to launch from.'],
    ['Options', 'Choose which "Needs attention" hints and dashboard cards appear, the storage-full threshold, moon ordering, number format and start tab. Preferences are shared by all servers. Data: records cap, automatic backups (weekly, daily or off), Back up now, JSON export/import (all data or options only), Purge old reports (older than 3 days), Rebuild stats and Reset stats data. Reset stats data keeps your options.'],
    ['User Guide', 'The same guide is available below Options in the dashboard and from the in-game sidebar.'],
  ]],
  ['Statistics sub-tabs', [
    ['Global', 'Combined resource totals and a "share by source" breakdown across all activities.'],
    ['Surveys / Pirates / Mining / Expeditions / Xeno / Wormhole', 'Per-activity totals, net gain (loot − ship-cost losses − fuel), loot-composition doughnut, daily/hourly charts and a sortable report table.'],
    ['Battles', 'Every combat in one place: camp raids, mining/survey ambushes, expedition/wormhole fights and player-vs-player attacks. Click a row to expand the fleets (incl. enemy planetary defenses) and per-ship losses. Export CSV downloads the current view with fleets and per-round detail.'],
    ['Debris', 'Debris collected over time plus active and recent debris runs.'],
  ]],
  ['Upgrade & build planners', [
    ['⬆ upgrade', 'On every building and research card. Pick a target level (and for research, the planet that will research it) to see the total cost to get there and what is missing on that planet.'],
    ['🚀 build', 'On every shipyard card. Pick a quantity to see the total cost and the missing resources on the planet in view.'],
    ['Upgrade queue', 'Planned items from all three planners land in a shared to-do list next to the planner. Reorder by drag & drop; select several items to sum their cost against one planet\'s stock.'],
    ['Send the deficit', 'Every planner hands the missing resources to the Quartermaster, which pre-fills a transfer from another planet.'],
  ]],
  ['On the galaxy map', [
    ['Mining calculator', 'Each asteroid field card shows the optimal number of mining ships to clear it. A per-card picker sets the mining ship and cycle count (both persist).'],
    ['⛏ Mining toggle', 'The breadcrumb switch hides/shows the injected pickers across all cards at once: green when on, grey-red when off.'],
  ]],
  ['Quartermaster (📦 top bar)', [
    ['Overview', 'Resource and ship cards for your planets, moons and outposts. Moons and outposts sit in the left column; the planet grid uses the remaining width and fits more planets per row on wider screens.'],
    ['Move by drag & drop', 'Drag a resource or ship from a colony onto another to stage a transfer in the docked builder card at the top: adjust amounts, choose the allowed transport types (selection is remembered), see fuel + ETA, then Send. Hold the item in a highlighted top or bottom edge zone to scroll to colonies outside the visible area.'],
    ['Cargo controls', 'Fill sets one resource to the most the available transport fleet can carry alongside the other goods. If the load exceeds capacity, Fit to fleet reduces all resource amounts proportionally to fit. Both controls respect the selected transport types and the stock on the source colony. Review the amounts before pressing Send.'],
    ['What each drop does', 'Planet→planet: deliver resources / transfer (relocate) ships. Planet→outpost: supply resources / deploy ships. Drag an outpost resource onto a planet to collect it (choose source planet + resource types). Nothing sends until you press Send.'],
  ]],
  ['Good to know', [
    ['Windows manual updates', 'If you installed the Windows manual package, run Update-Nexus.bat from its extracted folder. Stable releases are the default; master is an optional development build for testers. Keep the loaded addon folder at the same path and do not uninstall the extension. Export your data under Options > Data before switching channels or downgrading: the updater backs up extension files, not browser data. After updating, reload the extension on your browser\'s extensions page, then reload open game pages.'],
    ['After an update', 'Reload open game pages after updating or reloading the extension so their in-page tools reconnect. If a tool still fails to open, keep the exact error message: it identifies the failed request and helps distinguish a connection problem from a game API error.'],
    ['Mission overview', 'The Dashboard shows Fleet slots used with its capacity bar. Next return is the earliest confirmed return that frees a normal fleet slot, not a mining cycle or outbound arrival. Expeditions count toward fleet slots; patrols use separate capacity and appear on their own line. Mission rows keep their current status and event countdown until fresh game data reports a change.'],
    ['Stats drift', 'If a "Stats drift detected" banner appears, click Options > Data > Rebuild stats once: it recomputes aggregates from the stored records.'],
    ['Fleet review', 'Check the ships and amounts in the fleet editor or confirmation dialog before sending. Quartermaster transfers are staged in the builder and are only sent when you press Send.'],
  ]],
];

globalThis.NX_renderGuide = function renderGuide(root) {
  for (const [title, items] of globalThis.NX_GUIDE_SECTIONS) {
    const panel = document.createElement('section');
    panel.className = 'nx-guide-panel';
    const label = document.createElement('h2');
    label.className = 'nx-guide-label';
    label.textContent = title;
    const list = document.createElement('div');
    list.className = 'nx-guide-items';
    for (const [lead, text] of items) {
      const item = document.createElement('div');
      item.className = 'nx-guide-item';
      const b = document.createElement('strong');
      b.textContent = lead;
      item.append(b, text ? `: ${text}` : '');
      list.appendChild(item);
    }
    panel.append(label, list);
    root.appendChild(panel);
  }
};
