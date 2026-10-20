# Changelog

All notable changes to the Nexus Overseer Firefox addon (formerly Nexus Accounting).

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- Persistent galaxy knowledge per universe, shared with asteroid searches.
  Physical properties do not expire; ownership and changing field data stay
  separate. Existing scans migrate, normal gameplay grows saved knowledge, and
  regular backups include the galaxy database.
- Five Galaxy Scout views: Map, Search, Systems, Planets and Moons. Lists browse
  search matches or all known data with independent filters, sorting and paging.
  System overview groups saved planets/moons with thumbnails, slot capacities,
  last-known owners and observation times, without scanning.
- Map navigation with local name/ID suggestions, Home planet, zoom, Whole galaxy
  and a clicked-system information box. Star colors, optional zone rings, own
  colonies, saved alliance markers, hubs and optional stations have a visual
  legend and independent layer controls.
- Search supports multiple planet/moon types, zones, sector ranges, distance and
  minimum size, slot and moon counts. A moon-slot threshold applies to one free
  moon, not a sum. Searches are saved per universe and restored locally.
- Public galaxy exchange through previewed structure-only exports and manually
  attached contribution issues. Maintainer-reviewed downloads fill missing
  structure without exposing owners, colony names, resources, visibility or
  upgrade-dependent slots. Daily checks are optional; manual updates remain
  available. Direct observations take priority.
- Windows maintainer import starter with a file picker, conflict preview,
  explicit MERGE confirmation and checksum validation; no upload, commit or push.
- Optional local diagnostic logs, per-stream search/JSONL export and clearing,
  console log levels and read-only resource history. Recording defaults off;
  logs stay separate per universe and are not part of regular data backups.

### Changed
- Galaxy Scout shows saved ownership first and checks unknown owners only in
  matching, fully visible systems. Manual checks include locally hidden matches.
  Player-rank columns and rank requests have been removed.
- Planet/moon types, security-zone colors and moon badges match the game.
  Slot capacities prefer saved explicit values over size-derived planet base
  slots; unknown values never satisfy numeric filters.
- Search and directory filters share compact toolbars and badges. More filters
  keeps an active count; local list resets preserve other views and the search.
  Clear search preserves galaxy knowledge; cache clearing is a separate recovery
  action under Options > Data > Danger zone.
- Options subnavigation for General, Data and Developer / Debug, matching the
  Statistics navigation. General preferences and dashboard controls share a tab
  with separate panels and reset actions. Data separates storage, public galaxy
  data, private backups and the danger zone; detailed explanations are collapsible.

### Fixed
- Shared API requests respect rate-limit cooldowns across concurrent reads and
  writes, honor Retry-After dates and slow repeated background requests after
  throttling. Exhausted galaxy requests stop visibly while preserving results.
- Combat simulation requests are paced across callers with bounded retries,
  recovery cooldowns and progress feedback during fleet calculations. Requests
  retain their selected universe while another universe's data is loading.
- Galaxy searches no longer delay every cached system or discard knowledge
  beyond 800 systems. Unavailable details are distinguished from empty data,
  and abandoned colonies do not retain their former owners.
- Map hover details, click selection, drag/zoom coordinates and labels remain
  aligned at browser/Windows scaling. Map view fits the viewport without page
  scrolling; other views retain normal scrolling and shared panel spacing.
- Switching views or receiving saved-data updates preserves the active search.
  Pending filters do not alter the map until a search starts.
- Moon processing is shared across search, lists and overviews. Public exports
  read only the selected universe instead of loading an all-server backup.
- Mission countdowns in tabs show the ETA without repeated event labels;
  Dashboard countdowns retain their event labels.
- Diagnostic capture uses batched writes and lazy details, preserves explicit
  truncation markers, and stops stale connections cleanly after extension reloads.
  Clearing targets the selected server, and Chromium uses the correct script world.

### Documentation
- Clarified game mechanics and API payloads in separate, cross-linked references,
  including observed universe configuration, galaxy updates, scout reports,
  building previews and storage limits.
- Updated the User Guide and privacy policy for local diagnostics. Diagnostic
  logs use separate JSONL exports and are not included in regular data backups.
- Documented galaxy-cache behavior, public contributions and Windows imports.
  The isolated screenshot demo uses 6,000 fictional systems and station markers.

## [2.2.2] - 2026-10-19

### Added
- A Check for updates button beside the footer version in manual installations,
  with immediate checks, progress, results and a short repeat-click cooldown.

### Changed
- What's new groups all published changes in the installed minor-version series
  under separate version headings, newest first.

## [2.2.1] - 2026-10-19

### Fixed
- The What's new dialog selects the installed version's release notes instead
  of displaying an empty Unreleased section.

## [2.2.0] - 2026-10-19

### Added
- The manual Windows package checks for stable releases from the dashboard
  footer at most every six hours. Master builds show their commit and whether
  they are ahead of the latest release; the version button still opens What's new.
- A separate Windows manual-installation ZIP for Chromium, with a PowerShell
  updater requiring no Git or Python. It offers stable releases or an explicit
  master commit, file backups, interrupted-update recovery and visible errors.
- Confirmed, recoverable updater self-updates from stable releases only.
  Store packages remain free of updater scripts.

### Changed
- The Dashboard mission card groups fleet-slot usage with its capacity bar,
  shows the next returning fleet and lists active patrols separately.

### Fixed
- A failed updater check after a completed Windows add-on update now reports
  a separate warning instead of incorrectly reporting the add-on update as failed.
- Mission stages and countdowns now follow the reported fleet status instead
  of assuming a return when an arrival time has passed.
- Fleet-slot counts include expeditions and exclude patrols, which use their
  own capacity.
- Game-tab requests now time out instead of remaining pending indefinitely,
  and failed requests report more useful details.

### Documentation
- A local dashboard preview with fictional sample data for creating screenshots
  without a game account.
- A README gallery covering all eleven regular dashboard tabs, with screenshots
  cropped to the height of the main navigation.

## [2.1.0] - 2026-10-18

### Added
- A **Dashboard** tab, now the default tab: total resources with hourly production
  across all planets and moons, active missions and fleet slots, a "Needs attention"
  box (idle research labs, planets without construction, nearly full storage, command
  ship repair, damaged ships, unspent talent points),
  an empire summary and one card per planet or moon with its construction queue,
  shipyard queue and hangar fleet by class.
- The *What's new* dialog is remembered once read and only reappears for a new version.
- A GitHub link and the version number in the dashboard footer; clicking the version reopens *What's new*.
- An **Options** tab: choose which "Needs attention" hints appear (including optional ones for
  idle shipyards and free fleet, colony or moon slots), the storage warning threshold, the
  visible dashboard cards, moons shown last or right after their planet, the number format and the tab opened on start.
  Options are shared by all servers and included in the JSON export. Options-only export
  and import are available too. The automatic backup can be set to weekly, daily or off, and
  there are buttons to back up right now and to purge reports older than 3 days.
- **Pirates**: choose the nearest owned planet with suitable ships as the fleet's
  origin, and use a fleet template to select which ship types *Calculate fleet*
  may use. The calculation determines the quantities from the available ships.
- **Quartermaster**: *Fill* sets a resource amount to what the available transport
  fleet can carry alongside the other goods. *Fit to fleet* reduces cargo amounts
  proportionally when the selected load exceeds the fleet's capacity.

### Changed
- Dashboard and Statistics status controls share a right-aligned header with the
  menu button on narrow windows.
- Updated the add-on icon and added the project logo to the README.
- Dashboard navigation now sits in a left sidebar, with a menu drawer on narrow
  windows. The add-on name, icon and server picker stay together above the navigation.
- The combat simulator is integrated into the dashboard instead of opening a
  separate page, sharing the fleet controls, number formatting and theme.
- The Quartermaster topbar button uses a larger control and label to match the
  other text buttons in the game toolbar.
- In-game planners and the Quartermaster now share frame, heading, section-label
  and resource-row styles.
- Planner opening buttons now sit beside the game's building, research and ship
  action controls, sharing the available row width without overlapping. Costs,
  demolition controls and the ship quantity picker keep their own full-width rows.
- Building, Technology and Shipyard planners, their opening buttons and the shared
  to-do list now use the add-on theme, with consistent controls and responsive panels.
- Export, import, *Rebuild stats* and the renamed *Reset stats data* moved from the Statistics
  bar to Options > Data. Resetting keeps your options. The records cap and the storage summary
  (formerly in the footer) moved there too. (The earlier hint to find **Export JSON**
  in the dashboard header now applies to Options > Data.)
- The server selection moved to the top next to the add-on name and applies to all tabs.
  Beta is now a built-in server; New Frontier is only listed when the server list provides it.
- Number format defaults to German (1.234.567); English and compact are available in Options.
- Resource colours are now the same everywhere (stat cards, charts, tables,
  asteroid and fleet views), including a distinct colour per rare resource.
- Resource amounts are shown as whole numbers throughout the add-on.
- Status messages are classified consistently as warnings or errors.
- Faster fleet calculations in the Pirates attack planner reuse matching
  simulation results across sessions.
- The User Guide now covers the Statistics sub-tabs, Simulator, Pirates, Market,
  Tech Tree and Options as they are today, plus the upgrade/build planners. The game
  sidebar link is now called *Nexus Overseer*. The guide is also available as its own
  *User Guide* tab below Options in the dashboard. In the game it now uses the
  add-on's look (same panels as the dashboard tab).
- The Quartermaster overlay now matches the dashboard design: panels, section labels,
  buttons and input fields look the same as in the add-on. Outposts now sit below the
  moons so the planet grid gets more room, and the *Total ships* / *In flight* boxes
  were removed. The overlay now uses the full screen width, so wider screens fit more
  planets per row.
- *Empire View* is no longer listed in the game sidebar for now.

### Fixed
- Quartermaster: dragging a resource or ship to the top/bottom edge now reliably scrolls
  the view, so colonies further down can be reached. Highlighted scroll zones show where
  to hold the item while dragging.
- Fleet template changes are picked up by open tabs again without a reload.

## [2.0.0] - 2026-10-15

### Important
- Nexus Overseer is now an independent project. Because of the rename, an
  existing installation may start with an empty data store. **Before
  updating, export your data (**Export JSON** in the dashboard header) and import it again after
  the update.** Backups made with earlier versions can be imported.

### Added
- A **Pirates** tab with pirate camp cards, scouting, attacks and an attack
  planner that uses the combat simulator.
- Live Search shows what it is doing: scan progress, the time of the last
  scan, the number of matches and when the next scan runs.

### Changed
- Live Search now selects systems the same way as the manual scan, so the same
  filters give the same results.

### Fixed
- Requests are paused for all callers after a "Too Many Requests" response.
- The "Live Search Belts" window reports a stale page after an add-on reload
  instead of failing silently.

## [1.9.1] - 2026-10-11

### Fixed
- Sending a mining fleet no longer fails with "Invalid request body": the
  escort withdraw threshold is now sent in the format the game expects.
- The Asteroids results now mark only the belt a fleet is mining instead of
  every belt in that system.

## [1.9.0] - 2026-10-11

### Added
- Pirate, expedition and wormhole reports now retain zone information from
  in-flight missions and galaxy-map sectors when their targets are gone.
- Debris fields now use the security zone supplied by the game API, falling
  back to the system-name lookup when it is missing.
- The Galaxy Scout can now scan all arms at once as well as individual arms.
- Asteroid field searches can target resource types across selected zones,
  restore matching results from a 15-minute cache, and interpret “Nearest
  systems” within the selected zones.
- A **Yesterday** option in the View picker for the previous one-day window.
- Asteroid mining can continue until the mining hold is full or the field is
  depleted, and escort fleets can withdraw at a selected damage threshold.
- The API integration and game reference guides document the routes, payloads,
  and game systems used by the add-on.

### Changed
- **Quartermaster**: choose which transport ship types may be used for resource transfers and outpost collections; the selection is remembered.
- The universe picker now uses the game's universe catalog, with data kept in
  separate storage scopes for each universe.
- **Fleet Templates** and the Asteroids fleet-template selector are now
  available directly from the dashboard and Asteroids tab.
- The dashboard navigation, shared statistics controls, and report views have
  been reorganized around a consistent layout.
- **Combat simulator**: battle requests and results now use the game's official
  combat calculator, including its own ship data, research profile, losses,
  survivors, combat rounds, and debris.
- The simulator POST runs through the logged-in game tab; a response without
  a combat report is treated as an error instead of rendering a false result.

### Fixed
- Newer tiered spy reports are normalized alongside legacy reports, and fleet
  dispatch requests preserve hangar assignments.
- Report totals now account correctly for existing data; the records cap can
  be set to unlimited without exceeding the browser's storage quota.
- Debris and report processing now preserves expiration and zone data when the
  game response omits or relocates those fields.
- Asteroid live search handles the game's API response variations.

### Removed
- The locally estimated combat engine and its engine-only validation panel.

### Chore
- Added API and game reference documentation and updated the privacy policy.
- Release package filenames now use the add-on's fork-specific namespace.

## [1.8.0] - 2026-08-12

### Added
- **Multi-server support (NX-S0 / NX-NF)**: full server-aware operation with isolated storage scopes per server.
- **Test workflow**: a root-level `check` script now runs lint plus the full test suite in one step.
- **Market trade history**: the Market tab now includes profit statistics, resource-flow summaries, history filtering, and per-trade net value calculations.
- **Shared status helper**: status rendering across the dashboard and feature tabs is now centralized through a common helper.
- **Server-scoped storage**: storage is now isolated per Nexus server, with migration and regression coverage for the new storage model.
- **Game request bridge**: game-tab API requests now route through the session bridge so background requests stay aligned with the active game tab.
- **Simulator wiring**: simulator status/shared helper wiring is now aligned with the rest of the addon.

### Changed
- **Repository metadata**: the root package metadata now uses the current fork name and URLs, with browser-neutral wording instead of Firefox-only wording.
- **Versioning**: the addon manifest and addon package metadata now both report `1.8.0`.
- **Linting setup**: ESLint now understands the addon’s CSS and HTML files with dedicated parsers/configs, so lint covers the full project without parser clashes.
- **Fork identity**: the root package name now uses a fork-specific identifier to avoid confusion with the upstream repo.
- **Server context handling**: active-server detection and selection are now enforced consistently across scrape, dashboard, and game-request flows.
- **Dashboard/server flow**: the dashboard now tracks the selected server more consistently, including server-switch handling and status updates.
- **Tab behavior**: asteroid-related tab state is reset more cleanly when the active server changes.
- **Simulator page wiring**: simulator page plumbing was updated together with the shared status helper work.

### Fixed
- **Chrome MV3 warning**: removed the legacy `background.scripts` entry from the manifest so the extension uses the MV3 `service_worker` path only.
- **HTML/CSS lint noise**: adjusted the lint config so CSS/HTML files are checked with the right rules and do not trigger JavaScript parser errors.
- **Test warning cleanup**: removed an unused variable from the server-storage regression test.
- **Backup/import compatibility**: backup and restore now preserve multi-server storage correctly.
- **Selected-server enforcement**: scrape and dashboard actions now continue to honor the chosen server instead of falling back to the wrong context.
- **Simulated helper cleanup**: simulator and status rendering imports were corrected where needed.

### Removed
- Legacy `background.scripts` manifest entry.

### Chore
- **Dependency metadata**: package-lock and repository metadata were refreshed as part of the fork maintenance updates.

## [1.7.6] - 2026-07-22

### Fixed
- **Collect-debris under-recording**: debris collection now runs in
  repeating ticks under the same mission id, with cargo growing each
  tick. The addon's commit gate still treated `returnDepartsAt` (set
  from the first tick on) as "cargo is final," so it recorded only the
  first tick's partial haul instead of the full amount. Now gated on
  `raidParams.collectionComplete`, falling back to `status: 'returning'`
  for the older non-ticked mission shape.

## [1.7.5] - 2026-07-21

### Fixed
- **Fuel-estimate throttling**: `gamePost` now gates fuel-estimate calls to
  the endpoint's own rate-limit scope (40/10s, 120/min) instead of relying
  solely on the global budget `apiFetch` tracks.
- **429 retry on `gamePost`**: game actions sent through the game tab (mine,
  survey, investigate, fuel-estimate, etc.) now retry on 429, honouring
  `Retry-After` then falling back to exponential backoff — matching
  `apiFetch`'s existing policy. Previously only GET requests retried.

## [1.7.4] - 2026-07-20

### Added
- **Wormhole** is now its own tab too; Global's source-share breakdown
  splits Expedition vs. Wormhole gains/losses instead of folding them
  together.
- **Outpost column** on the Asteroids tab: fields with a built outpost now
  show the controlling player and their alliance tag (`player [ALLIANCE]`),
  resolved via the leaderboard search endpoint and cached per player.
- **"Already mining" row highlight**: the Asteroids tab and the live-search
  results panel both turn a field's row green when you already control it
  or have an active mine mission en route, updated optimistically the
  instant a send succeeds instead of waiting on the next missions poll.
- GitHub issue templates (bug report / feature request).

### Fixed
- Techtree/building upgrade cost formula: `costDoubleAfter` was compounding
  per level instead of a flat 2x once past the threshold, undercounting
  cost for the Research Lab and other buildings past that point.
- `xeno_survey` results actually arrive as a system message, not a fleet
  report — `/api/fleet/cyber-reports` was the wrong endpoint and was
  always empty.
- Expeditions/Wormhole/Xeno's "Ships lost (build cost)" card ignored the
  View/Window/Zone filters (read the all-time aggregate instead of the
  filtered records); same gap fixed in the Global tab's filtered view.
- Build/upgrade buttons on ship/tech/building cards no longer overlap the
  entity image — moved to the card's bottom row, pinned to the left edge,
  enlarged 20%.

## [1.7.3] - 2026-07-19

### Added
- **Shipyard build planner** (`ship-upgrade.js`): a 🚀 button on each ship card
  computes the flat per-unit build cost (ore/silicates/hydrogen/alloys +
  rare) for a chosen quantity, then hands the deficit off to the
  Quartermaster or the shared to-do queue — same UX as the building/tech
  planners, but ships are per-planet.
- **Multi-select resource summary** in the upgrade to-do list: left-click
  toggles an item into a selection instead of delivering it immediately; the
  panel sums resource need across every selected item and subtracts the
  destination planet's stock once, then offers a single Send via
  Quartermaster. Restricted to one planet at a time.
- **Storage caps + outpost mining indicator** in the Quartermaster: each
  resource on a colony card now shows its storage cap; outposts are badged
  with what they're currently mining (icon + rate/h).
- **Server-side capacity check** before Quartermaster dispatch: cross-checks
  the intended resource total against the game's own bonus-adjusted fleet
  capacity (from `/fleet/fuel-estimate`) and disables Send with an explicit
  message if it's over, instead of surfacing a dispatch error after the fact.
- **Optimise Mining Fleet**: the live-search matches window and the
  Asteroids-tab fleet dialog both seed a mining send from the user's chosen
  template by default now. A new "Optimise Mining Fleet" button (next to the
  live-search Start/Stop toggle, and inside the Asteroids-tab dialog) swaps
  just the mining ships (Mining Vessel/Gas Collector/Ice Drill/Excavator) to
  the recommended count, leaving escort/combat ships untouched. Adds an
  Excavator when the +20% checkbox is checked.

### Removed
- The "Send non-optimised fleet" escape-hatch button from both fleet-confirm
  dialogs — redundant now that templates are the default.

## [1.7.2] - 2026-07-12

### Added
- **Tech upgrade planner**: a 🔬 button on each research card computes the
  cumulative research cost (ore/silicates/hydrogen/alloys + rare) to a target
  level and hands the deficit to the Quartermaster. Research is account-global,
  so a destination-planet picker chooses where it will run.
- **Upgrade to-do list**: a queue beside either upgrade planner. Queue building
  and tech steps with ➕ To-do; drag to reorder (labels recompute in order,
  per-planet for buildings, global for tech); each card shows its planet and,
  when clicked, stages that step's resource deficit in the Quartermaster.
- **Deliver/Transfer switch**: planet→planet resource dispatches in the
  Quartermaster can now be sent as a transfer (haulers stay) instead of a
  delivery (haulers return).

### Changed
- CI: bumped `actions/checkout` and `actions/setup-node` to v5 (Node 20
  deprecation).

### Fixed
- Date-flaky `purgeOldData` test (records fell in the same month early in the
  month, colliding archive keys and double-counting).
- Removed an unused variable flagged by lint.

## [1.7.1] - 2026-07-09

### Fixed
- **Quartermaster**: editing a resource amount now re-plans the transport fleet
  to match, instead of leaving the ship counts on the first auto-plan.
- **Excavator**: the +20% toggle now actually adds an Excavator to the launched
  fleet (it previously only inflated the recommended capacity but never sent the
  ship) — in both the live-search matches window and the Asteroids-tab dialog.

## [1.7.0] - 2026-07-09

### Added
- **Quartermaster** (in-game fleet & resource overview): a new panel giving a
  fleet + stored-resource overview across all your colonies with drag-and-drop
  transfers. Cards are grouped by kind in a 3-column layout (moons left, planets
  centre, outposts right) with drag edge-autoscroll and boxed drag chips.
  - **Per-resource cargo allocation** when planning a transfer, plus moon support.
  - **Moon transfers** and correct moon-ownership id handling.
  - **Outpost supply / deploy / collect** actions.
  - **In-flight ships** shown from active missions.
- **Battles — PvP combat**: ingest player-vs-player combat reports, show PvP rows
  in the Battles table, and a CSV export button (fleets + rounds included; Excel
  encoding fixed).
- **Simulator**: defense buildings can now field multiple units; simulations
  default to 100 runs.
- **In-game User Guide** overlay.
- **Object Finder — moon column**: shows moon types with slot counts,
  colour-coded.
- **API — proactive rate-limit throttle** to avoid hitting the game's limits.

### Fixed
- **Scrape**: tolerate a shipyard `403` (ships out on patrol) instead of failing
  the whole scrape.
- **Mining**: false `mining.deliveries` drift sourced from raid records.
- Lint: removed unused params (`processPvpReports` ships, `numInput` max) and a
  dead `missions` assignment.

## [1.6.9] - 2026-07-05

### Added
- **Galaxy — mining toggle**: a persisted "⛏ Mining" switch in the galaxy
  breadcrumb hides or shows the injected per-field mining picker + optimal-ships
  line across all cards at once (green on, grey-red off).
- **Mining — Fuel cost + ROI columns**: the Recent Deliveries table drops Ships
  lost and Stolen for a Fuel cost column (POST fuel-estimate for the stored fleet,
  source planet → mined system) and an ROI column (weighted: mined − breakdown −
  fuel − ship loss − stolen).
- **Fleet Templates — mining ship colours**: each mining ship's name is coloured
  by what it mines (Mining Vessel, Gas Collector, Ice Drill, Excavator, Freighter),
  with a "Mines: …" tooltip and a legend.
- **Empire View — hero banner** image at the top of the overlay.

### Fixed
- **Galaxy mining picker**: the cycle number sometimes rendered blank. When the
  game re-rendered a field card and reconciled away part of the injected picker,
  `paint()` threw before setting the value. Rebuild the picker when it's
  incomplete and populate the cycle value at build time.
- **Galaxy mining picker**: dark-matter fields ("Dark Matter Rift") showed "No
  mining ship" — the ship map keyed the field by `dark_matter` instead of the
  actual field type `dark`. Now recommends the Ice Drill.
- **Mining reports**: only `delivery` reports count toward totals/cycles/table;
  `pirate_raid` reports are kept for the battles tab but no longer inflate them.
  Cycles come from `resourcesDelivered._cyclesDone` (default 10 when absent).
- **Cryo-ice captured**: the game delivers `cryo_ice` but the addon used `ice`,
  so cryo-ice was dropped from all report processing and rendered as zero. Renamed
  the internal key across processing, series and the report tables.
- **Loot doughnut**: rare resources (cryo-ice, plasma core, quantum dust, …) were
  missing in windowed modes; now read whether stored flat or in the rare map.

## [1.6.8] - 2026-07-04

### Added
- **Empire View**: a new "Empire View" link in the game sidebar opens a
  game-styled overlay with a columnar per-planet summary (one column per planet
  plus a Total column):
  - **Workforce**: population (cur/max), growth/h, assigned workers, free
    workers, energy (net).
  - **Available resources**: stored / storage capacity per resource, red near
    full; Total summed.
  - **Resource buildings**: level and production/h for ore / silicates /
    hydrogen / alloys (+ rares when produced).
  - **Infrastructure** with live countdowns: building slots (used/max), build
    queue, researching tech, buildings in construction, and ships in production
    across both the Shipyard and Orbital Shipyard queues.
  Data is fetched same-origin from the game APIs; the overlay lives in `<body>`
  so game re-renders never wipe it.

## [1.6.7] - 2026-07-04

### Fixed
- **Galaxy field cards**: the optimal-ships line stopped rendering. `galaxy-fields.js`
  used top-level `const`s, and Firefox re-injecting the content script into the
  same isolated world (extension reload) threw "redeclaration of const", aborting
  the whole script. Wrapped the body in an IIFE + re-run guard. Also buffer relayed
  field stats in the MAIN-world hook and replay them on init, so data fetched
  before the isolated-world listener attaches isn't lost.

## [1.6.6] - 2026-07-03

### Added
- **Galaxy mining calculator**: on the in-game `/galaxy` page, each asteroid
  `field-card` now shows the optimal number of mining ships to clear it —
  `ceil(remaining / (extraction_capacity × cycles × richness))`. A floating
  picker (image tiles) selects the mining ship (Mining Vessel / Gas Collector /
  Ice Drill / Excavator) and a −/+ stepper sets the target cycle count (1–10);
  both persist. Field data (resources, richness, type) is read from the game's
  own `/planets` response via a page-world fetch/XHR hook.
- **Battles tab**: one place aggregating every combat across sources — pirate
  camp raids, pirate ambushes while mining, survey ambushes and
  expedition/wormhole encounters. Summary cards (battles, ships lost/damaged,
  enemies destroyed), a source filter, a sortable table (date, source, location,
  zone, outcome, losses, debris) and click-a-row to expand the attacker/enemy
  fleets and per-ship losses. Reads the recent records already in memory.

### Fixed
- Live-search matches window now refreshes its "as of" time, match count and
  rows live when a background scan completes, instead of freezing at open time.

## [1.6.5] - 2026-07-01

### Added
- **Asteroid belt live search**: a second filter row on the Asteroids tab scans
  the nearest systems in the background every 5 minutes — even when the tab or
  browser isn't focused — and fires a notification when a new field matches your
  filter (type/zone/mult/qty/left%).
- **In-game matches window**: clicking the notification (or the new "Live Search
  Belts" sidebar link) opens a floating, draggable window listing the matches,
  with per-row fuel cost, an editable fleet (one ship per line), and a one-click
  ⛏ to send a mining mission. Start/stop the search from the window.
- **Ratio Calculator** in the game sidebar: a floating, draggable calculator —
  enter any two of offer / pay / ratio and it infers the third.
- **Market** "Ratio wanted ≥" filter on the open-offers table.
- **Asteroids** "Left % ≥" filter.
- **Mining**: drill-breakdown maintenance (75 alloy per breakdown) is now charged
  in the Net total.

### Changed
- **Market** tab: removed the Trade Hub filter and the mini-map.

### Fixed
- The Asteroids availability strip no longer blinks each poll, and no longer
  disappears.

## [1.6.4] - 2026-06-26

### Added
- **Date-range "Days" picker** with **Last 3 days / Last 7 days / Last month**
  view presets. The selected range drives the stat cards, net, doughnuts and
  charts, and overrides "All time" when a range is set.
- **Loot composition** doughnut on the Mining tab; Mining net now shows in every
  view, not just All-time.
- A labelled legend (source — %) on Global's "Share by source" chart.
- Asteroids remembers the selected planet and fleet template across tab switches
  and restarts.

### Changed
- Per-mission fuel uses the game's exact fuel-estimate (real fleet + route),
  falling back to the fitted formula only when no game tab is open.

### Fixed
- Graphs bucket data by **local** day/hour instead of the raw UTC timestamp, so
  reports near midnight no longer fall in the wrong day/hour.

## [1.6.3] - 2026-06-26

### Added
- **"On this planet" ship strip**: live counts (icon + qty) above the
  Asteroids fields table — refreshed every 10s and after each
  launch, so you can see fleets free up without reloading.

### Changed
- Debris fields show a **Total** column (ore + silicates + alloys) instead of an
  always-zero hydrogen column.

## [1.6.2] - 2026-06-25

### Added
- **Fuel Cost** column on the Asteroids tab: per-field hydrogen estimate for the
  selected fleet template from the Mining-From planet (out-of-range in red).
- **What's-new modal**: after an update, the latest changelog entry is shown
  once in the dashboard, formatted (headings, bullets, bold/italic/code).

### Changed
- **Asteroids tab** now scans the *N nearest explored systems* to the chosen
  planet (set the count) instead of an arm + sector region.
- Asteroid scans refetch system data after 15 minutes (was 24h) so drained
  fields and miner presence stay current; Planet Finder keeps the 24h cache.
- Dashboard now opens on the **Global** tab.

### Fixed
- Rate-limited (429) API calls now retry with backoff instead of erroring out.
- Fuel estimates are cached per source/destination/template, so known routes no
  longer re-hit the API on re-render, paging or template reselection.

## [1.6.1] - 2026-06-25

### Added
- Launch confirmations show each ship's image + name instead of `#<id>`.
- Used/max fleet slots shown on the Asteroids tab.

### Fixed
- Fleet/research launches no longer silently cancel: native `confirm()` is
  replaced by an in-page modal, so Firefox's "prevent additional dialogs"
  checkbox can't suppress launch confirmations anymore.

## [1.6.0] - 2026-06-25

### Added
- **Asteroids Fields tab**: scan a region (arm + sectors) for asteroid fields
  via the galaxy sector endpoints, listing type, content, richness multiplier,
  remaining %, security zone, distance to a chosen planet and miner presence.
  - Resource-icon type filter, colour-coded zone toggles, mult/qty floors,
    sortable columns and pagination.
  - **🚀 per row** dispatches a fleet template to mine the field, capped to the
    ships actually on the source planet.
- **Fleet Templates tab**: named, reusable ship templates (planet-agnostic),
  styled like the simulator's attacker fleet and built from the full shipyard
  catalog. Shared by mining actions.

### Fixed
- Fleet-action POSTs (mine, survey, investigate, fuel-estimate) route through
  the game tab's content script so they run same-origin with the session
  cookie — a Bearer POST from the extension carries an `Origin` header the
  server rejects with a 500.

## [1.5.7] - 2026-06-19

### Added
- **Tech Tree research planner**: queue research targets and launch them
  straight from the dashboard.
  - Real lab level read from each planet's Research Lab building (highest
    across planets) — replaces the previous estimate.
  - Lab-upgrade steps are inserted automatically when a planned tech needs
    a higher lab level, and gate the techs that depend on them.
  - **Launch** button on each researchable step posts the research to the
    game (with a confirm dialog) on a planet of your choice — a "Launch on"
    picker lists every planet, with busy ones disabled.

### Changed
- Fuel cards appear on every tab (Surveys, Pirates, Mining, Debris,
  Expeditions, Global) and the net-gain totals now label themselves
  "− fuel". All fuel reads go through `fuelForMode` so they honour the
  View and Zone selectors.
- Removed the dead report-join fuel path and the `mission_origins`,
  coordinate, home-system, and owned-system caches (superseded by the
  launch-log approach).
- Research time estimates are now accurate: they use the game's own
  per-level time scaled by each planet's research-speed multiplier, and the
  schedule models one research slot per planet (parallel) plus a
  time-aware affordability check that accrues income over the queue.

### Fixed
- Fuel formula recalibrated against real data: `rate × (0.0496 × distance + 3.48)`
  (~6% mean error; the previous formula was ~2× too high due to a mislabeled
  distance scale).
- Fuel is now counted once per **launched** mission (stored in `fuel_log` by
  type/date/zone). A survey's heavy investigation/collection fleet is counted
  rather than the lighter scout probe; `investigate` and `anomaly` mission
  types are both mapped to the survey zone.
- Schema v7 clears `fuel_log` and stale coordinate/home/owned-system caches
  so fuel rebuilds cleanly from launch records.

## [1.5.6] - 2026-06-18

### Added
- New **Global** tab: collected resources, net gain, operations count, a
  per-period chart, a collected-composition doughnut and a weighted
  "share by source" doughnut — all honouring the View/Window/Zone selectors.
- Alloys and exotic resources (ice, quantum dust, plasma core, dark matter,
  antimatter) tracked everywhere: collected cards, recent-report tables,
  resource line charts and the "resources by event type" chart, across
  surveys, pirates, mining, debris and expeditions.
- Per-period charts gained a report-count line (missions/raids/deliveries/
  runs) on a secondary axis; debris and expeditions got per-period charts.

### Changed
- Net gain now includes exotic resources, weighted ×10 in the total
  (ore×1, silicates×2, hydrogen×3, alloys×5, exotics×10).
- Survey table drops the wormholes column; expeditions split the Loot
  column into per-resource columns; debris cards/graph honour view + zone.

## [1.5.5] - 2026-06-18

### Added
- Sidebar launcher: an "Addon → Nexus Tracker" entry is injected into the
  game's sidebar (using its own styling) to open the dashboard.
- Graph time-window selector (last 5/7/14/30/all days; default 5), and the
  View/Window/Zone controls now sit directly above each tab's graphs.

### Changed
- Fuel is now computed precisely from each mission's real fleet and real
  distance, captured live from /api/fleet/missions by mission id (including
  the actual launch system, not an assumed home). The earlier estimate is
  removed — missions the addon didn't observe contribute no fuel rather
  than a guess.
- Date graphs fill empty days/hours so the time axis is continuous.

## [1.5.4] - 2026-06-17

### Added
- Fuel cost estimate folded into net gain. Each survey, pirate, and mining
  report now estimates the round-trip hydrogen burned
  (`Σ(fuelRate×qty) × (0.0517×galaxyDist + 9.24)`, fitted to real send-fleet
  costs) and subtracts it from the Hydrogen and Total net. Survey shows a
  "Fuel spent est." card too.
- Galaxy map caches system coordinates; pirate-camps cache coordinates; the
  home system id is cached — all to measure travel distance.

### Notes
- Fuel needs a fresh Scrape Now to populate the new ship/coordinate fields,
  and only applies to newly scraped reports. Survey fuel uses an assumed
  fleet by zone (the report omits the fleet sent). Reports whose target
  system is unexplored show no fuel.

## [1.5.3] - 2026-06-16

### Added
- Combat simulator now shows a round-by-round "sample battle" (one
  representative run): ships and HP% per side each round, kills, and the
  sample outcome — alongside the Monte-Carlo averages.
- Fuel estimate for the attacking fleet: enter a distance (AU), optional
  round-trip, and get total hydrogen from each ship's fuel rate.

### Changed
- Rapid-fire table rebuilt from the exact in-game ship screens (fighter
  and carrier entries added; cruiser, battleship, bomber, interceptor
  values corrected).
- Rapid fire and ship stats now resolve pirate/NPC ships (e.g.
  "Pirate Fighter") to their base class, so the engine can simulate
  wormhole/pirate fleets and the validator can replay those reports.
- Ship catalog now stores fuel rate and cargo capacity.

## [1.5.2] - 2026-06-15

### Added
- Planet Finder: Max size, temperature range, security-zone, and
  "exclude mine" filters; Zone and Distance-from-home columns (sortable).
- A flaky system during a scan is now skipped and counted instead of
  aborting the whole scan.
- Galaxy map is now interactive: drag to pan, wheel to zoom toward the
  cursor; clicking a results row centers and rings that system. Matches
  table moved above the map.
- Map markers: your planets show a light-green aura; alliance-owned
  systems found while scanning get the same aura with the player's name;
  market hubs are drawn as yellow diamonds.
- Owner-only galaxy export/import: share scanned-planet knowledge as a
  JSON file, merged by freshest scan per system. Imported systems become
  searchable even if you haven't explored them.

### Fixed
- Widened host permissions to `*://*.nexuslegacy.space/*` so a single grant
  covers the `s0` (and any future universe) subdomain. Previously only the
  apex was granted on Firefox, leaving the API host unauthorized — every
  request was CORS-blocked and the addon reported "not logged in" with no
  data.
- `getToken` now searches every cookie store (Firefox containers, private
  windows) and domain-wide, not just the default store with two exact URLs.
- API errors now name the failing endpoint (network/CORS failures included).

## [1.5.1] - 2026-06-15

### Changed
- Tech Tree depth now factors in the required laboratory level as a
  tiebreak: depth = max(prerequisite-chain depth, lab-level floor), so
  lab-gated techs sink to their lab tier instead of bunching at the top
  when they have no research prerequisites.

## [1.5.0] - 2026-06-15

### Added
- Tech Tree tab: renders `/api/research` as a top-to-bottom dependency
  graph (OGame style). Rows are prerequisite depth; prerequisites sit
  above their dependents.
- Long edges route through invisible waypoints merged per source into
  vertical buses, so dependencies weave around nodes instead of crossing
  them. Crossing reduction uses barycenter (mean + median) with
  adjacent-transpose refinement, keeping the lowest-crossing ordering.
- Rounded orthogonal edges coloured by prerequisite branch, dashed/faded
  when the prereq is unmet, arrowheads into dependents.
- Nodes show branch accent + status; researchable-now techs glow, locked
  techs recede. Tier labels, row bands, and a legend aid orientation.
- Interaction: hover/click-pin chain highlight, drag-pan, wheel zoom,
  fit-to-width, branch filter, and search-to-highlight.

## [1.4.0] - 2026-06-15

### Changed
- Migrated to Manifest V3 and made the addon work on both Firefox and Chrome
  from one codebase (webextension-polyfill, MV3 service worker / event page,
  `action`, split host permissions).
- Realtime updates now use an observe-and-re-fetch trigger
  (`webRequest.onCompleted`) instead of Firefox-only response-body reading,
  which MV3 removed. Still near-realtime; costs one extra request per change.
- `build.py` emits both the `.xpi` (Firefox) and a `.zip` (Chrome Web Store).
- Auto-backups download from a data URL (service workers have no
  `URL.createObjectURL`).

## [1.3.4] - 2026-06-15

### Changed
- Net gain and resources-lost now include the repair cost of damaged ships
  (50% of build cost), not just destroyed ones. Surveys and pirate raids
  track damage per ship type for this.

## [1.3.3] - 2026-06-15

### Fixed
- Combat simulator rapid fire was dumping all of a unit's shots into one
  target, wasting most on overkill — rapid-fire swarms (e.g. interceptors)
  badly underperformed. Each shot now picks its own target and skips ships
  already lethally hit that round, validated against a third real battle.

## [1.3.2] - 2026-06-13

### Changed
- Published on addons.mozilla.org (listed channel). AMO now signs,
  distributes and auto-updates the addon; the short-lived self-hosted
  `update_url`/`updates.json` channel from 1.3.1 is removed.
- `build.py --sign` submits to the listed channel.

## [1.3.1] - 2026-06-13

### Added
- **Automatic backups** to `Downloads/NexusAccounting/`: weekly while
  scraping, and before every destructive operation — reset, import,
  schema-fallback wipe and version updates. Requires the new `downloads`
  permission.
- **Rebuild stats**: recomputes every aggregate losslessly from uncapped
  report archives (sharded by month so a scrape only rewrites the current
  month). The records cap now only bounds the UI tables.
- **Drift detection**: archive-derived sums are checked against stored
  totals after each scrape; mismatches surface a warning in the status bar.
- **Import validation**: backups are shape-checked before anything is
  replaced.
- Storage footer: archived report count, storage size, last backup date.
- Node test suite (`npm test`): combat-engine calibration regression tests
  and processor tests (dedupe, shards, migration, drift/rebuild).

### Changed
- Schema changes now migrate data in place (`MIGRATIONS` map); a wipe is the
  last resort and preserves the records cap, which only the user changes.
- Combat engine extracted to `engine.js`; dashboard split into `common.js`,
  `tabs/*.js` and an orchestrator; simulator split into core, intel and
  validation files.

## [1.3.0] - 2026-06-13

### Added
- **Mining tab**: deliveries, mining cycles, drill breakdowns, ambush ship
  losses (valued at build cost) and cargo stolen, with per-period chart.
- **Debris tab**: live debris fields snapshotted from `system-debris`,
  estimated collected amounts inferred from snapshot diffs, plus debris
  generated by your own pirate raids.
- **Expeditions tab**: expedition reports and wormhole runs merged — loot,
  losses, per-period chart (shape-tolerant parsing, endpoints unobserved yet).
- **Planet Finder tab**: full-galaxy map with region highlight; filters by
  arm, sector (single or range), planet type, min size, min moons and
  ownership; scans explored systems with a 24h cache; sortable results and
  hover tooltips on matches.
- Simulator: **Load my fleet** fills the attacker from your stationed ships.
- Simulator: **intel auto-fill** — defender fleet and turret/shield/EW levels
  load from spy or camp-scout reports; target resources shown with an
  estimated cargo requirement for ~50% loot.
- Simulator: **planetary defenses** — turret structure, always-regenerating
  shield generator and EW damage reduction (estimates); bombers keep their
  exact ×5 rapid fire vs defense buildings.
- Simulator: **engine validation** — replays recorded pirate raids and
  reports outcome accuracy and average loss error against real results.
- `build.py` builds the versioned xpi from the manifest.

### Changed
- Home planet is discovered via `/api/planets` and cached (no hardcoded id);
  recolonization self-heals on 404.
- Mining and Expeditions tabs honor the All time / Daily / Hourly view mode.
- Intel report retention raised to 200; spy, camp-scout, mining, expedition,
  wormhole and system-debris endpoints added to realtime interception.
- View mode and records cap controls hidden on tabs where they are
  meaningless (Planet Finder, Debris).

## [1.2.1] - 2026-06-10

### Added
- **Realtime updates**: the addon now intercepts the game's own API responses
  (survey reports, pirate reports, shipyard) via `webRequest.filterResponseData`
  and processes them immediately — the dashboard updates seconds after you open
  a report in game. The 15-minute scrape remains as fallback for when no game
  tab is open.
- **JSON export/import** on the dashboard: full backup of all aggregated data
  to a dated file, restore with confirmation. Protects history the game API no
  longer returns.
- Simulator: **research levels** (0–5) per side with exact in-game rates —
  weapon damage techs, hull techs, shield HP, and damage reduction
  (Shield Theory / Adaptive Shields / Advanced Shielding, stacks to 35%).
- Simulator: ship stat lines update live as research levels change.
- Simulator: average survivors shown next to each ship input after a run;
  auto-scroll to results.

### Changed
- Simulator targeting calibrated against real battle reports (partial
  focus-fire); default round cap raised to 10; options moved above the fleets.
- Dreadnought and Titan rapid-fire values are now exact (from in-game ship
  screens).
- "Resources collected" cards ordered Ore / Silicates / Hydrogen to match
  the resources-lost cards.
- Background page is persistent and requires the `webRequest` /
  `webRequestBlocking` permissions (needed for response interception).

### Fixed
- `package.json` license said MIT while the project is MPL-2.0.

## [1.2.0] - 2026-06-10

### Added
- **Combat simulator** (`simulator.html`, linked from the dashboard):
  Monte Carlo battle engine modeled on the official combat guide — round-based
  simultaneous fire, weapon-vs-armor matchups, rapid fire, plasma/ion shield
  burn, win/hold/mutual-destruction rates, expected losses and debris value.
  Debris rate (30% of destroyed ship cost) verified against real pirate
  reports.
- Ship catalog now stores combat stats (HP, shield, attack, weapon/armor type)
  for the simulator.

## [1.1.0] - 2026-06-10

### Added
- **Pirates tab**: aggregates pirate camp raids from
  `/api/fleet/pirate-reports` — loot collected, attacker ships destroyed and
  damaged (build-cost valuation of losses), pirates destroyed, outcome
  breakdown, debris fields generated, daily/hourly views and raid history
  table.

## [1.0.1] - 2026-06-10

### Fixed
- Skip uninvestigated anomalies and uncollected loot until fully resolved —
  reports are counted once, with their final loot.
- `ships_lost` counted array entries instead of summing quantities.
- Pagination buttons (CSP-safe event listeners instead of inline `onclick`).

## [1.0.0] - 2026-06-09

### Added
- Initial release: tracks Nexus Legacy survey reports — resources collected
  (ore, silicates, hydrogen), missions, ships lost with build-cost valuation,
  event type breakdown, daily/hourly charts, report history with configurable
  records cap, 15-minute background scrape with manual "Scrape Now".
